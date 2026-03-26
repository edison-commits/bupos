"use server";

import { mutateStore } from "@/lib/persistence/store";
import { getAdminSession } from "@/lib/auth/session";
import { orgQuery, orgTx } from "@/lib/db";
import type { Transfer, TransferLine } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";

const isPg = () => !!process.env.USE_POSTGRES;

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

  let parsedLines: { productVariantId: string; quantity: number }[] = [];
  try { parsedLines = JSON.parse(lineData || "[]"); } catch { throw new Error("Invalid line data"); }
  if (parsedLines.length === 0) throw new Error("At least one item is required");

  const ctx = await getAdminSession();
  if (!ctx) throw new Error("Not authenticated");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
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

export async function shipTransferAction(transferId: string) {
  const ctx = await getAdminSession();
  if (!ctx) throw new Error("Not authenticated");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const t = await client.query(`SELECT * FROM transfers WHERE id = $1 AND status = 'requested' FOR UPDATE`, [transferId]);
      if (t.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Transfer not found or not in requested status"); }
      const transfer = t.rows[0];

      await client.query(
        `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = now(), updated_at = now() WHERE id = $2`,
        [ctx.employee.id, transferId],
      );
      await client.query(`UPDATE transfer_lines SET quantity_shipped = quantity_requested WHERE transfer_id = $1`, [transferId]);

      const lines = await client.query(`SELECT product_variant_id, quantity_requested FROM transfer_lines WHERE transfer_id = $1`, [transferId]);
      for (const line of lines.rows) {
        await client.query(
          `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand - $1), updated_at = now()
           WHERE product_variant_id = $2 AND location_id = $3`,
          [line.quantity_requested, line.product_variant_id, transfer.source_location_id],
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

export async function receiveTransferAction(transferId: string) {
  const ctx = await getAdminSession();
  if (!ctx) throw new Error("Not authenticated");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const t = await client.query(`SELECT * FROM transfers WHERE id = $1 AND status = 'in_transit' FOR UPDATE`, [transferId]);
      if (t.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Transfer not found or not in transit"); }
      const transfer = t.rows[0];

      await client.query(
        `UPDATE transfers SET status = 'received', received_by = $1, received_at = now(), updated_at = now() WHERE id = $2`,
        [ctx.employee.id, transferId],
      );
      await client.query(
        `UPDATE transfer_lines SET quantity_received = COALESCE(quantity_shipped, quantity_requested) WHERE transfer_id = $1`,
        [transferId],
      );

      const lines = await client.query(
        `SELECT product_variant_id, COALESCE(quantity_shipped, quantity_requested) AS qty FROM transfer_lines WHERE transfer_id = $1`,
        [transferId],
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
  const ctx = await getAdminSession();
  if (!ctx) throw new Error("Not authenticated");

  if (isPg()) {
    const result = await orgQuery(
      ctx.employee.organizationId,
      `UPDATE transfers SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'requested' RETURNING id`,
      [ctx.employee.id, transferId],
    );
    if (result.rows.length === 0) throw new Error("Can only cancel requested transfers");
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
