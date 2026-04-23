"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import type { Transfer, TransferLine } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";

const isPg = () => !!process.env.USE_POSTGRES;

// Owners and managers can act on any transfer across the org (for oversight
// and cross-location coordination). inventory_clerk can only act on transfers
// where at least one endpoint is in their location assignment — stops a clerk
// at Location A from moving stock between Locations B and C.
function assertTransferLocationAuthority(
  roleKey: string | undefined | null,
  locationIds: string[] | undefined,
  sourceLocationId: string,
  destinationLocationId: string,
): void {
  if (roleKey === "owner" || roleKey === "manager") return;
  const assigned = locationIds ?? [];
  if (!assigned.includes(sourceLocationId) && !assigned.includes(destinationLocationId)) {
    throw new Error("You must be assigned to either the source or destination location");
  }
}

export async function createTransferAction(formData: FormData) {
  const sourceLocationId = formData.get("sourceLocationId") as string;
  const destinationLocationId = formData.get("destinationLocationId") as string;
  const notes = (formData.get("notes") as string) || undefined;
  const lineData = formData.get("lines") as string;

  if (!sourceLocationId || !destinationLocationId) {
    throw new Error("Source and destination locations are required");
  }
  if (sourceLocationId === destinationLocationId) {
    throw new Error("Source and destination must be different locations");
  }

  // R17-M-2: validate line shape with Zod. The previous `JSON.parse` with
  // no shape check accepted `{productVariantId: "", quantity: -5}` — a
  // manager could create a transfer with negative quantity, and
  // `shipTransferAction` would decrement source on_hand by a negative
  // (= adding phantom stock) and decrement destination by negative
  // (= draining). The `/api/transfers POST create` route validates via
  // `transferSchema`; the server-action equivalent didn't.
  let parsedLinesRaw: unknown;
  try { parsedLinesRaw = JSON.parse(lineData || "[]"); } catch { throw new Error("Invalid line data"); }
  const { z } = await import("zod");
  const linesSchema = z.array(z.object({
    productVariantId: z.string().uuid(),
    quantity: z.number().int().positive().max(1_000_000),
  })).min(1).max(500); // R19-LOW-2: bound for self-DoS protection
  const linesResult = linesSchema.safeParse(parsedLinesRaw);
  if (!linesResult.success) {
    throw new Error("Invalid line data: each item needs a productVariantId (uuid) and a positive integer quantity");
  }
  const parsedLines = linesResult.data;

  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");
  assertTransferLocationAuthority(
    ctx.employee.roleKey,
    ctx.employee.locationIds,
    sourceLocationId,
    destinationLocationId,
  );

  // R68-H2: step-up parity with REST /api/transfers POST. Prior
  // shape: only RBAC + location authority, no password re-auth. A
  // transfer drains inventory at source + credits at destination;
  // stolen manager cookie could move high-value stock to an off-
  // books location for an accomplice to pick up. Mirror the REST
  // bucket 'transfer-create-stepup' so the aggregate-per-actor cap
  // covers both surfaces.
  const actorPassword = String(formData.get("actorPassword") ?? "");
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword,
    bucketKey: "transfer-create-stepup",
  });
  if (!stepUp.ok) throw new Error(stepUp.error);

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R16-M-1 + R16-L-4: verify source + destination locations AND every
      // product_variant_id belong to caller's org. FKs are tenant-agnostic;
      // without these checks a manager in org X could write a transfer row
      // referencing foreign locations / variants. Same class as R14-M-3
      // (API route equivalent) + R15-M-2/H-4 FK-class bugs.
      const { rows: locCheck } = await client.query(
        `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [[sourceLocationId, destinationLocationId], orgId],
      );
      if (locCheck.length !== 2) {
        await client.query("ROLLBACK");
        throw new Error("Source or destination location does not belong to this organization");
      }

      const variantIds = Array.from(new Set(parsedLines.map((l) => l.productVariantId)));
      if (variantIds.length > 0) {
        const { rows: vCheck } = await client.query(
          `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [variantIds, orgId],
        );
        if (vCheck.length !== variantIds.length) {
          await client.query("ROLLBACK");
          throw new Error("One or more product variants do not belong to this organization");
        }
      }

      const transferId = randomUUID();
      await client.query(
        `INSERT INTO transfers (id, organization_id, source_location_id, destination_location_id, status, requested_by, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'requested', $5, $6, now(), now())`,
        [transferId, orgId, sourceLocationId, destinationLocationId, ctx.employee.id, notes || null],
      );
      for (const line of parsedLines) {
        await client.query(
          `INSERT INTO transfer_lines (id, transfer_id, product_variant_id, quantity_requested, created_at)
           VALUES ($1, $2, $3, $4, now())`,
          [randomUUID(), transferId, line.productVariantId, line.quantity],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const transfer: Transfer = {
        id, organizationId: store.organization.id, sourceLocationId, destinationLocationId,
        status: "requested", requestedBy: ctx.employee.id, notes, createdAt: now, updatedAt: now,
      };
      store.transfers.push(transfer);
      for (const line of parsedLines) {
        const tl: TransferLine = {
          id: crypto.randomUUID(), transferId: id, productVariantId: line.productVariantId,
          quantityRequested: line.quantity, createdAt: now,
        };
        store.transferLines.push(tl);
      }
    });
  }

  revalidatePath("/admin");
}

export async function shipTransferAction(transferId: string, actorPassword?: string) {
  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");

  // R74-A: short-circuit already-shipped transfers BEFORE consuming
  // a step-up bucket slot. Mirrors the REST parity fix from R72-C.
  // If status is anything but 'requested', ship is idempotent for
  // the current caller — no need to prompt for a password again.
  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const { orgQuery } = await import("@/lib/supabase-rest");
    const { rows: probe } = await orgQuery(
      orgId,
      `SELECT status FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [transferId, orgId],
    );
    if (probe.length > 0 && probe[0].status !== "requested") {
      // Treat as idempotent success — the state the caller wanted
      // (ship) is already achieved by a prior committed ship.
      return;
    }
  }

  // R70-M1: step-up re-auth. Ship is the inventory-draining step;
  // R68-H2 gated CREATE but not SHIP. Mirror the REST parity on
  // bucketKey 'transfer-ship-stepup'.
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword: actorPassword ?? "",
    bucketKey: "transfer-ship-stepup",
  });
  if (!stepUp.ok) throw new Error(stepUp.error);

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R27-C12: explicit organization_id filter on the SELECT. The
      // owner/manager short-circuit in assertTransferLocationAuthority
      // meant an owner at ORG A could pass ORG B's transferId and drain
      // B's inventory on ship. Without the org filter, the status gate
      // + owner bypass was the only check.
      const t = await client.query(`SELECT * FROM transfers WHERE id = $1 AND organization_id = $2 AND status = 'requested' FOR UPDATE`, [transferId, orgId]);
      if (t.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Transfer not found or not in requested status"); }
      const transfer = t.rows[0];

      // Same location-authority gate as create. Shipping moves stock OUT
      // of the source — if the clerk isn't assigned to source or dest,
      // they shouldn't be able to drain that store's inventory.
      try {
        assertTransferLocationAuthority(
          ctx.employee.roleKey,
          ctx.employee.locationIds,
          transfer.source_location_id,
          transfer.destination_location_id,
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      // Mirror the API route's FOR UPDATE + availability check. The old
      // code used `GREATEST(0, on_hand - $1)` with no lock and no stock
      // check, plus unconditionally wrote `quantity_shipped =
      // quantity_requested`. Shipping 10 units when only 3 were in stock
      // clamped source to 0 but kept shipped=10 — the receive step then
      // credited destination +10, creating 7 phantom units out of thin
      // air. Every shop's inventory accounting assumes this doesn't
      // happen.
      // R27-C12: JOIN through transfers for explicit org gate.
      const lines = await client.query(
        `SELECT tl.id, tl.product_variant_id, tl.quantity_requested
           FROM transfer_lines tl
           JOIN transfers t ON t.id = tl.transfer_id AND t.organization_id = $2
          WHERE tl.transfer_id = $1`,
        [transferId, orgId],
      );
      // R78-SEC-H1 (HIGH): Server Action twin of R76-SEC-H1. REST
      // /api/transfers ship aggregates per-variant before stock
      // check + single delta-join UPDATE; the Server Action was
      // never updated. transfer_lines has no UNIQUE on
      // (transfer_id, product_variant_id) so a transfer with
      // [{A,3},{A,3}] against on_hand=5 let both lines pass the
      // check (each reads the same base on_hand) then the serial
      // UPDATE loop drove on_hand to -1. Aggregate + single delta-
      // join UPDATE with GREATEST(0, ...) clamp.
      const variantIds = lines.rows.map((line: { product_variant_id: string }) => line.product_variant_id);
      const { rows: lockedInventory } = await client.query(
        `SELECT product_variant_id, on_hand
         FROM inventory_levels
         WHERE organization_id = $3
           AND location_id = $1
           AND product_variant_id = ANY($2::uuid[])
         ORDER BY product_variant_id
         FOR UPDATE`,
        [transfer.source_location_id, variantIds, orgId],
      );
      const onHandByVariant = new Map<string, number>(
        lockedInventory.map((row: { product_variant_id: string; on_hand: number }) => [row.product_variant_id, Number(row.on_hand)]),
      );

      const requestedByVariant = new Map<string, number>();
      for (const line of lines.rows as Array<{ product_variant_id: string; quantity_requested: number }>) {
        const vid = line.product_variant_id;
        const qty = Number(line.quantity_requested) || 0;
        requestedByVariant.set(vid, (requestedByVariant.get(vid) ?? 0) + qty);
      }
      for (const [vid, totalRequested] of requestedByVariant) {
        const available = onHandByVariant.get(vid) ?? 0;
        if (available < totalRequested) {
          await client.query("ROLLBACK");
          throw new Error(`Insufficient stock at source for variant ${vid} (have ${available}, need ${totalRequested})`);
        }
      }

      // R27-C12: explicit org filter on every write.
      await client.query(
        `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = now(), updated_at = now() WHERE id = $2 AND organization_id = $3`,
        [ctx.employee.id, transferId, orgId],
      );
      await client.query(
        `UPDATE transfer_lines tl
            SET quantity_shipped = tl.quantity_requested
           FROM transfers t
          WHERE tl.transfer_id = t.id
            AND t.id = $1
            AND t.organization_id = $2`,
        [transferId, orgId],
      );

      // Single UPDATE across all variants — unnest delta-join with
      // deduped (variant, qty) pairs. Same shape as REST ship.
      const aggVariantIds = [...requestedByVariant.keys()];
      const aggQuantities = aggVariantIds.map((v) => requestedByVariant.get(v) as number);
      await client.query(
        `UPDATE inventory_levels il
            SET on_hand = GREATEST(0, il.on_hand - delta.qty),
                updated_at = now()
           FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
          WHERE il.organization_id = $4
            AND il.location_id = $3
            AND il.product_variant_id = delta.variant_id`,
        [aggVariantIds, aggQuantities, transfer.source_location_id, orgId],
      );
      // R70-L1: ship audit in-tx (parity with REST ship path).
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_shipped', $6, now())`,
        [
          randomUUID(), orgId, transfer.source_location_id, ctx.employee.id, transferId,
          JSON.stringify({
            source_location_id: transfer.source_location_id,
            destination_location_id: transfer.destination_location_id,
            line_count: lines.rows.length,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const transfer = store.transfers.find((t) => t.id === transferId);
      if (!transfer) throw new Error("Transfer not found");
      if (transfer.status !== "requested") throw new Error("Transfer not in requested status");

      const now = new Date().toISOString();
      transfer.status = "in_transit";
      transfer.shippedBy = ctx.employee.id;
      transfer.shippedAt = now;
      transfer.updatedAt = now;

      const tLines = store.transferLines.filter((l) => l.transferId === transferId);
      for (const line of tLines) {
        line.quantityShipped = line.quantityRequested;
        const inv = store.inventory.find(
          (i) => i.productVariantId === line.productVariantId && i.locationId === transfer.sourceLocationId,
        );
        if (inv) { inv.onHand = Math.max(0, inv.onHand - line.quantityRequested); inv.updatedAt = now; }
      }
    });
  }

  revalidatePath("/admin");
}

export async function receiveTransferAction(transferId: string, actorPassword?: string) {
  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");

  // R74-A: short-circuit already-received transfers BEFORE
  // consuming a step-up bucket slot (mirror of ship fix above).
  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const { orgQuery } = await import("@/lib/supabase-rest");
    const { rows: probe } = await orgQuery(
      orgId,
      `SELECT status FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [transferId, orgId],
    );
    if (probe.length > 0 && probe[0].status === "received") {
      return;
    }
  }

  // R72-C: step-up on RECEIVE (parity with R70-M1 ship). Receiving
  // credits destination inventory — same inventory-mutation surface
  // as ship. Bucket 'transfer-receive-stepup' separate from ship
  // so the aggregate cap is per-action.
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword: actorPassword ?? "",
    bucketKey: "transfer-receive-stepup",
  });
  if (!stepUp.ok) throw new Error(stepUp.error);

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R27-C12: explicit organization_id filter. Mirrors the ship
      // handler — owner bypass on the location check made the org
      // filter mandatory to prevent cross-tenant receive.
      const t = await client.query(`SELECT * FROM transfers WHERE id = $1 AND organization_id = $2 AND status = 'in_transit' FOR UPDATE`, [transferId, orgId]);
      if (t.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Transfer not found or not in transit"); }
      const transfer = t.rows[0];

      try {
        assertTransferLocationAuthority(
          ctx.employee.roleKey,
          ctx.employee.locationIds,
          transfer.source_location_id,
          transfer.destination_location_id,
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      await client.query(
        `UPDATE transfers SET status = 'received', received_by = $1, received_at = now(), updated_at = now() WHERE id = $2 AND organization_id = $3`,
        [ctx.employee.id, transferId, orgId],
      );
      await client.query(
        `UPDATE transfer_lines tl
            SET quantity_received = COALESCE(tl.quantity_shipped, tl.quantity_requested)
           FROM transfers t
          WHERE tl.transfer_id = t.id
            AND t.id = $1
            AND t.organization_id = $2`,
        [transferId, orgId],
      );

      const lines = await client.query(
        `SELECT tl.product_variant_id, COALESCE(tl.quantity_shipped, tl.quantity_requested) AS qty
           FROM transfer_lines tl
           JOIN transfers t ON t.id = tl.transfer_id AND t.organization_id = $2
          WHERE tl.transfer_id = $1`,
        [transferId, orgId],
      );
      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO inventory_levels (id, organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, 0, now(), now())
           ON CONFLICT (product_variant_id, location_id)
           DO UPDATE SET on_hand = inventory_levels.on_hand + $5, updated_at = now()`,
          [randomUUID(), orgId, line.product_variant_id, transfer.destination_location_id, line.qty],
        );
      }
      // R70-L1: receive audit in-tx.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_received', $6, now())`,
        [
          randomUUID(), orgId, transfer.destination_location_id, ctx.employee.id, transferId,
          JSON.stringify({
            source_location_id: transfer.source_location_id,
            destination_location_id: transfer.destination_location_id,
            line_count: lines.rows.length,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const transfer = store.transfers.find((t) => t.id === transferId);
      if (!transfer) throw new Error("Transfer not found");
      if (transfer.status !== "in_transit") throw new Error("Transfer not in transit");

      const now = new Date().toISOString();
      transfer.status = "received";
      transfer.receivedBy = ctx.employee.id;
      transfer.receivedAt = now;
      transfer.updatedAt = now;

      const tLines = store.transferLines.filter((l) => l.transferId === transferId);
      for (const line of tLines) {
        line.quantityReceived = line.quantityShipped ?? line.quantityRequested;
        const inv = store.inventory.find(
          (i) => i.productVariantId === line.productVariantId && i.locationId === transfer.destinationLocationId,
        );
        if (inv) { inv.onHand += line.quantityReceived; inv.updatedAt = now; }
        else {
          store.inventory.push({
            id: crypto.randomUUID(), organizationId: transfer.organizationId,
            locationId: transfer.destinationLocationId, productVariantId: line.productVariantId,
            onHand: line.quantityReceived, reserved: 0, reorderPoint: 0, createdAt: now, updatedAt: now,
          });
        }
      }
    });
  }

  revalidatePath("/admin");
}

export async function cancelTransferAction(transferId: string) {
  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");

  if (isPg()) {
    // Read the source/dest first so the location gate can run. Cancelling
    // doesn't move stock, but a clerk who isn't assigned to either endpoint
    // shouldn't be undoing other locations' transfers either.
    // R27-C12: explicit organization_id filter on SELECT + UPDATE.
    // Owner bypass of the location check made org scope mandatory.
    const orgId = ctx.employee.organizationId;
    const { rows: tRows } = await orgQuery(
      orgId,
      `SELECT source_location_id, destination_location_id, status FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [transferId, orgId],
    );
    if (tRows.length === 0) throw new Error("Transfer not found");
    assertTransferLocationAuthority(
      ctx.employee.roleKey,
      ctx.employee.locationIds,
      tRows[0].source_location_id,
      tRows[0].destination_location_id,
    );
    // R72-B: wrap UPDATE + audit in one orgTx. Prior shape was two
    // bare orgQuery calls (SELECT then UPDATE); cancel is a state-
    // change worth logging for forensic review ("who cancelled
    // which transfer before shipping?"). R70-L1 added ship/receive
    // audits; cancel was the third-state gap.
    const client = await orgTx(orgId);
    try {
      const upd = await client.query(
        `UPDATE transfers SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND status = 'requested' RETURNING id`,
        [ctx.employee.id, transferId, orgId],
      );
      if (upd.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Can only cancel requested transfers");
      }
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_cancelled', $6, now())`,
        [
          randomUUID(), orgId, tRows[0].source_location_id, ctx.employee.id, transferId,
          JSON.stringify({
            source_location_id: tRows[0].source_location_id,
            destination_location_id: tRows[0].destination_location_id,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const transfer = store.transfers.find((t) => t.id === transferId);
      if (!transfer) throw new Error("Transfer not found");
      if (transfer.status !== "requested") throw new Error("Can only cancel requested transfers");
      transfer.status = "cancelled";
      transfer.cancelledBy = ctx.employee.id;
      transfer.cancelledAt = new Date().toISOString();
      transfer.updatedAt = transfer.cancelledAt;
    });
  }

  revalidatePath("/admin");
}
