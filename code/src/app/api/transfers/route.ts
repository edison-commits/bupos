import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, transferSchema } from "@/lib/validation/schemas";
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";


import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/transfers
 *
 * Query params:
 *   id       — single transfer detail with lines
 *   status   — filter by status (requested, in_transit, received, cancelled)
 *   location — filter by source or destination location
 */
export const GET = withDualAuth("inventory.adjust", async (req, ctx) => {
  const { orgId } = ctx;
  try {
    const sp = req.nextUrl.searchParams;

    // R13-H-1: inventory.adjust is held by inventory_clerk (non-owner/manager).
    // Without this filter they list every transfer in the org — variant names,
    // quantities, source-destination, supplier info. R12 hardened the WRITE
    // paths (ship/cancel/create) but left the READ surface open. Same shape
    // as the /api/audit + /api/returns retrofit.
    const allowedLocations = ctx.allowedLocations;

    // ── Single transfer detail ──
    const id = sp.get("id");
    if (id) {
      // R27-C9: explicit organization_id filter. Without it, passing
      // `?id=<foreign-transfer-UUID>` returned any tenant's transfer
      // detail. JOINs also gated by org so cross-tenant employee/
      // location IDs can't splice foreign names in.
      const transfer = await orgQuery(
        orgId,
        `SELECT t.*,
                sl.name AS source_location_name,
                dl.name AS destination_location_name,
                req.display_name AS requested_by_name,
                ship.display_name AS shipped_by_name,
                recv.display_name AS received_by_name,
                canc.display_name AS cancelled_by_name
         FROM transfers t
         LEFT JOIN locations sl ON sl.id = t.source_location_id AND sl.organization_id = $2
         LEFT JOIN locations dl ON dl.id = t.destination_location_id AND dl.organization_id = $2
         LEFT JOIN employees req ON req.id = t.requested_by AND req.organization_id = $2
         LEFT JOIN employees ship ON ship.id = t.shipped_by AND ship.organization_id = $2
         LEFT JOIN employees recv ON recv.id = t.received_by AND recv.organization_id = $2
         LEFT JOIN employees canc ON canc.id = t.cancelled_by AND canc.organization_id = $2
         WHERE t.id = $1 AND t.organization_id = $2`,
        [id, orgId],
      );

      if (transfer.rows.length === 0) {
        return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
      }

      // Location membership check on detail path — non-managers can only
      // see transfers that touch one of their assigned locations.
      if (allowedLocations !== null) {
        const row = transfer.rows[0] as { source_location_id: string; destination_location_id: string };
        if (!allowedLocations.includes(row.source_location_id) && !allowedLocations.includes(row.destination_location_id)) {
          return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
        }
      }

      // R27-C9: transfer_lines is FK-scoped by transfer_id (already
      // org-verified above). Add JOIN through transfers for explicit
      // org gate, and gate product/variant JOINs similarly.
      const lines = await orgQuery(
        orgId,
        `SELECT tl.*,
                p.name AS product_name,
                pv.sku, pv.barcode,
                pv.size_label AS size, pv.color_label AS color
         FROM transfer_lines tl
         JOIN transfers t ON t.id = tl.transfer_id AND t.organization_id = $2
         LEFT JOIN product_variants pv ON pv.id = tl.product_variant_id AND pv.organization_id = $2
         LEFT JOIN products p ON p.id = pv.product_id AND p.organization_id = $2
         WHERE tl.transfer_id = $1
         ORDER BY tl.created_at`,
        [id, orgId],
      );

      return NextResponse.json({ transfer: transfer.rows[0], lines: lines.rows });
    }

    // ── List all ──
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;

    // R27-C9: explicit organization_id filter. Without it, the list
    // endpoint returned every tenant's transfers.
    idx++;
    conditions.push(`t.organization_id = $${idx}`);
    values.push(orgId);

    // Non-manager location scope.
    if (allowedLocations !== null) {
      if (allowedLocations.length === 0) {
        return NextResponse.json({ transfers: [], page: 1, limit: 50 });
      }
      idx++;
      conditions.push(`(t.source_location_id = ANY($${idx}::uuid[]) OR t.destination_location_id = ANY($${idx}::uuid[]))`);
      values.push(allowedLocations);
    }

    const status = sp.get("status");
    if (status) {
      idx++;
      conditions.push(`t.status = $${idx}`);
      values.push(status);
    }

    const location = sp.get("location");
    if (location) {
      idx++;
      conditions.push(`(t.source_location_id = $${idx} OR t.destination_location_id = $${idx})`);
      values.push(location);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Page/limit — previously unbounded and N+1 on per-row subqueries. Replaced
    // the subqueries with a single LATERAL aggregation so one row per transfer.
    const page = Math.max(1, Number(sp.get("page")) || 1);
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
    const offset = (page - 1) * limit;
    const limitIdx = idx + 1;
    const offsetIdx = idx + 2;

    // R27-C9: JOINs also gated by $1 (orgId) — the list WHERE
    // already restricts `t.organization_id`, but belt-and-suspenders
    // on the display-only JOINs prevents a subtle cross-tenant
    // splice should a foreign FK ever appear.
    const transfers = await orgQuery(
      orgId,
      `SELECT t.*,
              sl.name AS source_location_name,
              dl.name AS destination_location_name,
              req.display_name AS requested_by_name,
              COALESCE(agg.line_count, 0)::int AS line_count,
              COALESCE(agg.total_units, 0)::int AS total_units
       FROM transfers t
       LEFT JOIN locations sl ON sl.id = t.source_location_id AND sl.organization_id = $1
       LEFT JOIN locations dl ON dl.id = t.destination_location_id AND dl.organization_id = $1
       LEFT JOIN employees req ON req.id = t.requested_by AND req.organization_id = $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS line_count,
                COALESCE(SUM(quantity_requested), 0) AS total_units
         FROM transfer_lines tl
         WHERE tl.transfer_id = t.id
       ) agg ON TRUE
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...values, limit, offset],
    );

    return NextResponse.json({ transfers: transfers.rows, page, limit });
  } catch (err) {
    console.error("GET /api/transfers error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch transfers" }, { status: 500 });
  }
});

/**
 * POST /api/transfers
 *
 * Body: { action, ... }
 *   action: "create"  — { sourceLocationId, destinationLocationId, notes?, lines: [{ productVariantId, quantity }] }
 *   action: "ship"    — { transferId }
 *   action: "receive" — { transferId }
 *   action: "cancel"  — { transferId }
 */
export const POST = withAdminAuth("catalog.manage", async (req, ctx) => {
  const { orgId } = ctx;
  const employeeId = ctx.employee.id;
  const idempotencyKey = req.headers.get('Idempotency-Key');

  // R64-L1: per-actor rate limit (60/60s). Transfers move inventory
  // between locations; a compromised cookie could spam creates to
  // flood inventory_adjustments with zero step-up barrier.
  const { checkRateLimit } = await import('@/lib/auth/rate-limit');
  const rl = checkRateLimit(`transfers:post:${orgId}:${employeeId}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }

  try {

    const body = await req.json();
    const v = validateBody(transferSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { action } = v.data;

    if (action === "create") {
      if (idempotencyKey) {
        const existing = await orgQuery(
          orgId,
          `SELECT id, status FROM transfers WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [orgId, idempotencyKey],
        );
        if (existing.rows.length > 0) {
          return NextResponse.json({ id: existing.rows[0].id, status: existing.rows[0].status, _idempotent: true });
        }
      }

      // R49: step-up re-auth on transfer create. A transfer drains
      // inventory at the source location and credits it at the
      // destination; a stolen manager cookie can move high-value stock
      // to an off-books location before an accomplice pulls it. Step-up
      // forces password re-entry, bounded by the step-up bucket cap.
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'transfer-create-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }

      // R30-L1: destructure from validated `v.data`, not raw `body`.
      // Prior shape ignored the Zod schema and reached straight into
      // the request payload — any future schema tightening (.default,
      // coercion, strict()) would be silently bypassed.
      const { sourceLocationId, destinationLocationId, notes, lines } = v.data;

      if (!sourceLocationId || !destinationLocationId) {
        return NextResponse.json({ error: "Source and destination locations required" }, { status: 400 });
      }
      if (sourceLocationId === destinationLocationId) {
        return NextResponse.json({ error: "Source and destination must be different" }, { status: 400 });
      }
      if (!lines || lines.length === 0) {
        return NextResponse.json({ error: "At least one line item required" }, { status: 400 });
      }

      // R14-M-3: verify BOTH location UUIDs belong to this tenant. The FK
      // `transfers.{source,destination}_location_id REFERENCES locations(id)`
      // doesn't apply RLS to FK checks, so without this gate an attacker
      // who knows a foreign-tenant location UUID could create a transfer
      // with `source=B-loc, dest=A-loc`. The `ship` step's FOR UPDATE on
      // foreign inventory_levels would return 0 (RLS-filtered), blocking
      // the actual drain — but the `transfers` row lands polluted.
      const { rows: locCheck } = await orgQuery(
        orgId,
        `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [[sourceLocationId, destinationLocationId], orgId],
      );
      if (locCheck.length !== 2) {
        return NextResponse.json(
          { error: "Source or destination location does not belong to this organization" },
          { status: 400 },
        );
      }

      // Cross-location drain prevention. A manager at Store B could
      // otherwise create a transfer FROM Store A (where they have no
      // assignment) TO Store B, then ship it themselves via a second
      // call — draining stock from a store they don't work at. The
      // source (or destination) must be in the caller's locationIds,
      // unless they're an owner who by convention sees all locations.
      const employeeLocIds = ctx.employee.locationIds ?? [];
      const isOwner = ctx.employee.roleKey === "owner";
      if (!isOwner) {
        if (!employeeLocIds.includes(sourceLocationId) && !employeeLocIds.includes(destinationLocationId)) {
          return NextResponse.json(
            { error: "You must be assigned to either the source or destination location" },
            { status: 403 },
          );
        }
      }

      const transferId = randomUUID();
      const client = await orgTx(orgId);
      try {
        // R16-L-4: verify every product_variant_id belongs to caller's org
        // before writing transfer_lines. FK is tenant-agnostic; without this
        // check a write could reference foreign variants, polluting admin
        // list views.
        const variantIds = Array.from(new Set(lines.map((l: { productVariantId: string }) => l.productVariantId)));
        if (variantIds.length > 0) {
          // R64-M4: also require variants to be ACTIVE. A transfer
          // on a soft-deleted variant creates zombie inventory
          // attributed to a "deleted" product — admin transfer
          // listings then show the dead SKU, inventory_adjustments
          // misattribute stock. Include is_active column so the
          // error branch can distinguish cross-org (400) from
          // soft-deleted (409).
          const { rows: vCheck } = await client.query(
            `SELECT id, is_active FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [variantIds, orgId],
          );
          if (vCheck.length !== variantIds.length) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "One or more product variants do not belong to this organization" }, { status: 400 });
          }
          const inactiveVariants = vCheck.filter((v: { is_active: boolean }) => !v.is_active);
          if (inactiveVariants.length > 0) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: "One or more product variants are inactive and cannot be transferred" },
              { status: 409 },
            );
          }
        }

        // R31-M5: catch 23505 on idempotency_key so a concurrent
        // retry-storm sees the winner's transfer_id instead of a 500.
        // Prior shape let the unique (org, idempotency_key) index
        // bubble up as a generic catch, returning "Failed to create
        // transfer" to the retrier while the first call succeeded —
        // classic idempotency contract violation.
        let idempotentWinnerId: string | null = null;
        try {
          await client.query(
            `INSERT INTO transfers (id, organization_id, source_location_id, destination_location_id, status, requested_by, notes, idempotency_key, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, now(), now())`,
            [transferId, orgId, sourceLocationId, destinationLocationId, employeeId, notes || null, idempotencyKey || null],
          );
        } catch (insertErr) {
          const err = insertErr as { code?: string; constraint?: string };
          if (
            idempotencyKey &&
            err.code === '23505' &&
            typeof err.constraint === 'string' &&
            err.constraint.toLowerCase().includes('idempotency')
          ) {
            // Winner already committed. Look up the winner's ID and
            // return it as the idempotent replay response.
            await client.query("ROLLBACK");
            const { rows: winnerRows } = await client.query(
              `SELECT id FROM transfers WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
              [orgId, idempotencyKey],
            );
            idempotentWinnerId = (winnerRows[0]?.id as string | null) ?? null;
          } else {
            throw insertErr;
          }
        }

        if (idempotentWinnerId) {
          // R49: `finally { client.release() }` below covers the release
          // here — remove the duplicate. The idempotent-winner branch
          // returned without committing, so finally runs on the
          // already-rolled-back client; release is called exactly once.
          return NextResponse.json({ id: idempotentWinnerId, status: 'requested', _idempotent: true });
        }

        for (const line of lines) {
          await client.query(
            `INSERT INTO transfer_lines (id, transfer_id, product_variant_id, quantity_requested, created_at)
             VALUES ($1, $2, $3, $4, now())`,
            [randomUUID(), transferId, line.productVariantId, line.quantity],
          );
        }

        // R49: audit INSIDE the tx. Prior shape wrote the audit row
        // post-commit via waitUntilOrAwait — if that failed the transfer
        // existed with no audit event. Matches the canonical R44+
        // audit-in-tx shape.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_created', $6, now())`,
          [
            randomUUID(), orgId, sourceLocationId, employeeId, transferId,
            JSON.stringify({
              source: sourceLocationId,
              destination: destinationLocationId,
              line_count: lines.length,
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

      return NextResponse.json({ id: transferId, status: "requested" }, { status: 201 });
    }

    if (action === "ship") {
      const { transferId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      // R72-C: idempotency-key short-circuit MOVED ABOVE step-up so
      // legitimate retries don't consume step-up budget (3/5min mem
      // + 4/5min KV). Prior R70-M1 ordering evaluated step-up first
      // — a caller retrying after transient failure could exhaust
      // the step-up bucket after ~3 tries even though the first
      // ship already committed. Mirrors the CREATE branch which
      // short-circuits idempotent repeats BEFORE step-up.
      if (idempotencyKey) {
        const existing = await orgQuery(
          orgId,
          `SELECT id, status, idempotency_key FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [transferId, orgId],
        );
        if (
          existing.rows.length > 0 &&
          existing.rows[0].status !== 'requested' &&
          existing.rows[0].idempotency_key === idempotencyKey
        ) {
          return NextResponse.json({ id: transferId, status: existing.rows[0].status, _idempotent: true });
        }
      }

      // R70-M1: step-up re-auth on SHIP. A transfer in status='requested'
      // was created by a (possibly different) actor; SHIP is the step
      // that actually drains source inventory, so it's the fraud-
      // relevant event. New bucket 'transfer-ship-stepup'.
      const { requireStepUp } = await import("@/lib/auth/step-up");
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (body as { actorPassword?: string })?.actorPassword,
        bucketKey: "transfer-ship-stepup",
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }

      const client = await orgTx(orgId);
      try {
        // R27-C9: explicit org filter on the SELECT. Without it, a
        // POST with a foreign tenant's transferId passed the status
        // gate and the owner-bypass location check, draining the
        // victim's inventory when the UPDATE below fired.
        const t = await client.query(
          `SELECT id, organization_id, source_location_id, destination_location_id, status, requested_by, shipped_by, received_by, notes, created_at, updated_at FROM transfers WHERE id = $1 AND organization_id = $2 AND status = 'requested' FOR UPDATE`,
          [transferId, orgId],
        );
        if (t.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Transfer not found or not in requested status" }, { status: 400 });
        }
        const transfer = t.rows[0];

        // R12-M-2: the SHIP step drains inventory at the source location.
        // Without this check a non-owner catalog.manage holder (inventory_clerk)
        // at Store B could ship a requested transfer whose source is Store A
        // — decrementing Store A's stock from a store they don't work at.
        // The `create` step already enforces source-or-destination membership;
        // `ship` must enforce SOURCE membership specifically.
        {
          const employeeLocIds = ctx.employee.locationIds ?? [];
          const isOwner = ctx.employee.roleKey === "owner";
          if (!isOwner && !employeeLocIds.includes(transfer.source_location_id)) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: "You are not assigned to this transfer's source location" },
              { status: 403 },
            );
          }
        }

        // R27-C9: scope every write by org. The SELECT above verified
        // the transfer belongs to this org, but the UPDATEs must also
        // include the filter so a race where `transfer.organization_id`
        // is corrupt can't widen the blast radius.
        await client.query(
          `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = now(), updated_at = now() WHERE id = $2 AND organization_id = $3`,
          [employeeId || null, transferId, orgId],
        );

        // transfer_lines: FK-scoped by transfer_id (already verified).
        // JOIN through transfers for defense in depth.
        await client.query(
          `UPDATE transfer_lines tl
              SET quantity_shipped = quantity_requested
             FROM transfers t
            WHERE tl.transfer_id = t.id
              AND t.id = $1
              AND t.organization_id = $2`,
          [transferId, orgId],
        );

        const lines = await client.query(
          `SELECT tl.product_variant_id, tl.quantity_requested
             FROM transfer_lines tl
             JOIN transfers t ON t.id = tl.transfer_id AND t.organization_id = $2
            WHERE tl.transfer_id = $1`,
          [transferId, orgId],
        );

        const variantIds = lines.rows.map((line) => line.product_variant_id as string);
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
        const onHandByVariant = new Map(
          lockedInventory.map((row) => [row.product_variant_id as string, Number(row.on_hand)]),
        );

        for (const line of lines.rows) {
          const available = onHandByVariant.get(line.product_variant_id as string) ?? 0;
          const requested = Number(line.quantity_requested);
          if (available < requested) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: `Insufficient stock for variant ${line.product_variant_id}` },
              { status: 409 },
            );
          }
        }

        for (const line of lines.rows) {
          // R27-C9: explicit org filter so a crafted destination row
          // at a foreign tenant can never be decremented.
          await client.query(
            `UPDATE inventory_levels SET on_hand = on_hand - $1, updated_at = now()
             WHERE organization_id = $4 AND product_variant_id = $2 AND location_id = $3`,
            [line.quantity_requested, line.product_variant_id, transfer.source_location_id, orgId],
          );
        }

        // R70-L1: audit the ship inside the tx. Ship is the money-
        // moving step (source inventory drained) — prior shape
        // only wrote to transfers.shipped_by/shipped_at columns.
        // A tampered/truncated transfers row would leave no
        // forensic evidence without this audit event.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_shipped', $6, now())`,
          [
            randomUUID(), orgId, transfer.source_location_id, employeeId, transferId,
            JSON.stringify({
              source_location_id: transfer.source_location_id,
              destination_location_id: transfer.destination_location_id,
              line_count: lines.rows.length,
            }),
          ],
        );

        await client.query("COMMIT");
        invalidateInventoryCache(orgId);
        return NextResponse.json({ id: transferId, status: "in_transit" }, { status: 200 });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "receive") {
      const { transferId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      // R72-C: idempotency short-circuit BEFORE step-up so retries
      // don't burn the bucket. Same rationale as R72-C on ship.
      if (idempotencyKey) {
        const existing = await orgQuery(
          orgId,
          `SELECT id, status FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [transferId, orgId],
        );
        if (existing.rows.length > 0 && existing.rows[0].status === 'received') {
          return NextResponse.json({ id: transferId, status: 'received', _idempotent: true });
        }
      }

      // R72-C: step-up re-auth on RECEIVE — mirror of R70-M1 on
      // SHIP. Receiving credits destination inventory; a stolen
      // cookie could inflate destination stock by auto-receiving
      // an in_transit transfer. Bucket 'transfer-receive-stepup'
      // distinct from ship so the aggregate cap is per-action.
      const { requireStepUp } = await import("@/lib/auth/step-up");
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (body as { actorPassword?: string })?.actorPassword,
        bucketKey: "transfer-receive-stepup",
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }

      const client = await orgTx(orgId);
      try {
        // R27-C9: explicit org filter. Without it, receiving a foreign
        // tenant's transfer restocked their destination inventory
        // under this tenant's org_id — an accounting corruption vector.
        const t = await client.query(
          `SELECT id, organization_id, source_location_id, destination_location_id, status, requested_by, shipped_by, received_by, notes, created_at, updated_at FROM transfers WHERE id = $1 AND organization_id = $2 AND status = 'in_transit' FOR UPDATE`,
          [transferId, orgId],
        );
        if (t.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Transfer not found or not in transit" }, { status: 400 });
        }
        const transfer = t.rows[0];

        // Receiving credits destination inventory — the caller must
        // actually work at that location, or they can forge receipts at
        // stores they aren't assigned to and pollute that store's
        // on-hand counts. Owners bypass (multi-location ownership).
        const employeeLocIds = ctx.employee.locationIds ?? [];
        const isOwner = ctx.employee.roleKey === "owner";
        if (!isOwner && !employeeLocIds.includes(transfer.destination_location_id)) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: "You are not assigned to this transfer's destination location" },
            { status: 403 },
          );
        }

        await client.query(
          `UPDATE transfers SET status = 'received', received_by = $1, received_at = now(), updated_at = now() WHERE id = $2 AND organization_id = $3`,
          [employeeId || null, transferId, orgId],
        );

        // R27-C9: JOIN through transfers for explicit org gate.
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

        // R70-L1: audit the receive. Closes the second half of the
        // inventory-move trail (source-drain audit on ship +
        // destination-credit audit on receive).
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_received', $6, now())`,
          [
            randomUUID(), orgId, transfer.destination_location_id, employeeId, transferId,
            JSON.stringify({
              source_location_id: transfer.source_location_id,
              destination_location_id: transfer.destination_location_id,
              line_count: lines.rows.length,
            }),
          ],
        );

        await client.query("COMMIT");
        invalidateInventoryCache(orgId);
        return NextResponse.json({ id: transferId, status: "received" }, { status: 200 });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "cancel") {
      const { transferId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      // R12-M-7: like create/ship/receive, restrict cancel to users
      // assigned to the source or destination. Without this, any
      // catalog.manage holder (inventory_clerk) in the org can cancel any
      // store's pending transfers — availability-disruption vector.
      const employeeLocIds = ctx.employee.locationIds ?? [];
      const isOwner = ctx.employee.roleKey === "owner";
      if (!isOwner) {
        // R27-C9: explicit org filter so cross-tenant transferIds
        // can't leak location_ids via this pre-check.
        const existing = await orgQuery(
          orgId,
          `SELECT source_location_id, destination_location_id, status FROM transfers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [transferId, orgId],
        );
        if (existing.rows.length === 0) {
          return NextResponse.json({ error: "Transfer not found or not in requested status" }, { status: 400 });
        }
        const row = existing.rows[0] as { source_location_id: string; destination_location_id: string };
        if (!employeeLocIds.includes(row.source_location_id) && !employeeLocIds.includes(row.destination_location_id)) {
          return NextResponse.json(
            { error: "You are not assigned to this transfer's source or destination location" },
            { status: 403 },
          );
        }
      }

      // R27-C9: owner bypass above granted access regardless of
      // location ownership — it MUST be constrained by organization_id
      // here so an owner at ORG A can't cancel ORG B's transfers.
      //
      // R72-B: wrap UPDATE + audit in one orgTx. Cancel is the third
      // state-change (alongside ship + receive) that needed audit
      // coverage — a tampered transfers row post-cancel would
      // otherwise leave no forensic trail.
      const client = await orgTx(orgId);
      try {
        const result = await client.query(
          `UPDATE transfers SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), updated_at = now()
           WHERE id = $2 AND organization_id = $3 AND status = 'requested'
           RETURNING id, source_location_id, destination_location_id`,
          [employeeId || null, transferId, orgId],
        );
        if (result.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Transfer not found or not in requested status" }, { status: 400 });
        }
        const cancelled = result.rows[0] as { source_location_id: string; destination_location_id: string };
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'transfer', $5, 'transfer_cancelled', $6, now())`,
          [
            randomUUID(), orgId, cancelled.source_location_id, employeeId, transferId,
            JSON.stringify({
              source_location_id: cancelled.source_location_id,
              destination_location_id: cancelled.destination_location_id,
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
      return NextResponse.json({ id: transferId, status: "cancelled" }, { status: 200 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/transfers error:", safeErr(err));
    return NextResponse.json({ error: "Failed to process transfer" }, { status: 500 });
  }
});
