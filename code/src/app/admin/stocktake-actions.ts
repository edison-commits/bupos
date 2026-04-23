"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import type { Stocktake, StocktakeLine } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";
import { orgTx } from "@/lib/supabase-rest";

const isPg = () => !!process.env.USE_POSTGRES;

/**
 * R31-H1: shared helper. Non-managers can only interact with
 * stocktakes at locations they're assigned to. The stocktake_id the
 * caller submits is not enough — we must resolve it to a location and
 * check that location against `employee.locationIds`. Prior shape:
 * `recordCountAction`, `acceptStocktakeAction`, and `cancelStocktake
 * Action` checked only `inventory.adjust` permission, letting a clerk
 * at store A record arbitrary counts on store B's stocktake and then
 * accept it (ABSOLUTE-mode sets `on_hand = counted_qty`, wiping out
 * or inflating store B's inventory org-wide, BYPASSING the ±1000 cap
 * that `adjustInventoryAction` enforces on direct adjusts).
 *
 * Returns the stocktake's `location_id` and `status` so callers can
 * skip a duplicate SELECT. Throws with a generic "Stocktake not
 * found" error on any mismatch to avoid leaking store-structure info.
 */
async function requireStocktakeLocationAccess(
  client: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  stocktakeId: string,
  orgId: string,
  actor: { roleKey: string; locationIds?: string[] | null },
): Promise<{ locationId: string; status: string }> {
  const { rows } = await client.query(
    `SELECT location_id, status FROM stocktakes WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [stocktakeId, orgId],
  );
  if (rows.length === 0) {
    throw new Error("Stocktake not found");
  }
  const locationId = rows[0].location_id as string;
  const status = rows[0].status as string;
  const isManager = actor.roleKey === "owner" || actor.roleKey === "manager";
  if (!isManager && !(actor.locationIds ?? []).includes(locationId)) {
    // Generic message — don't disclose whether the stocktake exists
    // at a different location vs. doesn't exist at all.
    throw new Error("Stocktake not found");
  }
  return { locationId, status };
}

export async function createStocktakeAction(formData: FormData) {
  const locationId = formData.get("locationId") as string;
  const countType = formData.get("countType") as string;
  const categoryFilter = (formData.get("categoryFilter") as string) || undefined;
  const notes = (formData.get("notes") as string) || undefined;

  if (!locationId || !countType) {
    throw new Error("Location and count type are required");
  }

  const ctx = await requireAdminPermission("inventory.adjust");

  // Location-assignment gate. Without this, an inventory_clerk assigned only
  // to Location A can start a stocktake at Location B, freezing/modifying
  // that location's inventory rows. Owners and managers keep org-wide access
  // for cross-store oversight.
  const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
  if (!isManager && !(ctx.employee.locationIds ?? []).includes(locationId)) {
    throw new Error("Location not assigned to this employee");
  }

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);

    // R15-M-3: defense-in-depth — even for managers (who skip the location-
    // assignment gate above), verify the client-supplied `locationId` belongs
    // to the caller's org. The locations FK is tenant-agnostic, so without
    // this a manager in org X who knows a location UUID from org Y could
    // create a stocktake row with a foreign location_id; the stocktake_lines
    // JOIN picks 0 foreign rows (RLS filters), but the stocktake row itself
    // pollutes reports and the admin UI's list.
    try {
      const locCheck = await client.query(
        `SELECT 1 FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [locationId, orgId],
      );
      if (locCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Location does not exist in this organization");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }

    const stocktakeId = randomUUID();
    try {
      await client.query(
        `INSERT INTO stocktakes (id, organization_id, location_id, initiated_by, status, count_type, category_filter, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, NOW(), NOW())`,
        [stocktakeId, orgId, locationId, ctx.employee.id, countType, categoryFilter || null, notes || null],
      );

      // Build stocktake_lines from current inventory at this location.
      // Filter by category when doing a cycle count with a category filter.
      const lineInsertSql = categoryFilter
        ? `INSERT INTO stocktake_lines (id, stocktake_id, product_variant_id, expected_qty, created_at)
           SELECT gen_random_uuid(), $1, il.product_variant_id, il.on_hand, NOW()
           FROM inventory_levels il
           JOIN product_variants pv ON pv.id = il.product_variant_id
           JOIN products p ON p.id = pv.product_id
           WHERE il.location_id = $2 AND il.organization_id = $3 AND p.category_id = $4`
        : `INSERT INTO stocktake_lines (id, stocktake_id, product_variant_id, expected_qty, created_at)
           SELECT gen_random_uuid(), $1, il.product_variant_id, il.on_hand, NOW()
           FROM inventory_levels il
           WHERE il.location_id = $2 AND il.organization_id = $3`;
      const lineParams = categoryFilter
        ? [stocktakeId, locationId, orgId, categoryFilter]
        : [stocktakeId, locationId, orgId];
      await client.query(lineInsertSql, lineParams);
      // R49: audit INSIDE the tx. Prior shape wrote the audit row
      // post-commit via waitUntilOrAwait — on failure the stocktake
      // existed with no audit. stocktakes are ABSOLUTE-mode inventory
      // rewrites; audit drop on create is a fraud-evidence gap.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'stocktake', $5, 'stocktake_created', $6, now())`,
        [
          randomUUID(), orgId, locationId, ctx.employee.id, stocktakeId,
          JSON.stringify({
            count_type: countType,
            category_filter: categoryFilter || null,
            notes: notes || null,
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
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const stocktake: Stocktake = {
        id,
        organizationId: store.organization.id,
        locationId,
        initiatedBy: ctx.employee.id,
        status: "in_progress",
        countType: countType as Stocktake["countType"],
        categoryFilter,
        notes,
        createdAt: now,
        updatedAt: now,
      };
      store.stocktakes.push(stocktake);

      const locationInventory = store.inventory.filter((inv) => inv.locationId === locationId);
      for (const inv of locationInventory) {
        if (countType === "cycle" && categoryFilter) {
          const variant = store.variants.find((v) => v.id === inv.productVariantId);
          const product = variant ? store.products.find((p) => p.id === variant.productId) : null;
          if (product?.categoryId !== categoryFilter) continue;
        }
        const line: StocktakeLine = {
          id: crypto.randomUUID(),
          stocktakeId: id,
          productVariantId: inv.productVariantId,
          expectedQty: inv.onHand,
          createdAt: now,
        };
        store.stocktakeLines.push(line);
      }
    });
  }

  revalidatePath("/admin");
}

export async function recordCountAction(formData: FormData) {
  const lineId = formData.get("lineId") as string;
  const countedQty = Number(formData.get("countedQty"));

  if (!lineId || !Number.isFinite(countedQty) || countedQty < 0) {
    throw new Error("Line ID and non-negative count required");
  }
  // R27-L9: cap countedQty so an accidental or malicious
  // MAX_SAFE_INTEGER submission doesn't overflow the integer
  // inventory_adjustments.delta column (PG int range ±2.1B) and
  // corrupt stock reports. 10M is well above any legitimate physical
  // count — sanity cap, not a tight bound.
  if (countedQty > 10_000_000) {
    throw new Error("Counted quantity exceeds sanity limit (10 million).");
  }

  const ctx = await requireAdminPermission("inventory.adjust");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const { rows: lineRow } = await client.query(
        `SELECT sl.id, sl.expected_qty, sl.stocktake_id, s.location_id, s.status
         FROM stocktake_lines sl
         JOIN stocktakes s ON s.id = sl.stocktake_id
         WHERE sl.id = $1 AND s.organization_id = $2
         FOR UPDATE`,
        [lineId, orgId],
      );
      if (lineRow.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Line not found");
      }
      // R31-H1: enforce the same location-assignment gate the
      // create-action applies. Without this, a non-manager at store A
      // who learns a store-B stocktake line UUID can record arbitrary
      // counts that will then be applied via accept (see below).
      const stocktakeLocationId = lineRow[0].location_id as string;
      const stocktakeStatus = lineRow[0].status as string;
      const isManagerOrOwner = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
      if (!isManagerOrOwner && !(ctx.employee.locationIds ?? []).includes(stocktakeLocationId)) {
        await client.query("ROLLBACK");
        throw new Error("Line not found");
      }
      // R31-L1: refuse counts on finalized stocktakes. The prior shape
      // let a caller UPDATE counted_qty on already-accepted/cancelled
      // stocktake lines, dirtying variance reports.
      if (stocktakeStatus !== "in_progress" && stocktakeStatus !== "pending_review") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot record count on ${stocktakeStatus} stocktake`);
      }
      const expected = Number(lineRow[0].expected_qty) || 0;
      const variance = Math.trunc(countedQty) - expected;
      // check-pool-org-filter: scoped-by-parent-stocktake-org-verified-line-154
      await client.query(
        `UPDATE stocktake_lines
           SET counted_qty = $1, variance = $2, counted_by = $3, counted_at = NOW()
         WHERE id = $4`,
        [Math.trunc(countedQty), variance, ctx.employee.id, lineId],
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
      const line = store.stocktakeLines.find((l) => l.id === lineId);
      if (!line) throw new Error("Line not found");
      line.countedQty = countedQty;
      line.variance = countedQty - line.expectedQty;
      line.countedBy = ctx.employee.id;
      line.countedAt = new Date().toISOString();
    });
  }

  revalidatePath("/admin");
}

export async function acceptStocktakeAction(stocktakeId: string, actorPassword?: string) {
  const ctx = await requireAdminPermission("inventory.adjust");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;

    // R49: step-up re-auth on stocktake accept. Accept applies every
    // counted_qty to inventory_levels in ABSOLUTE mode (the per-line
    // cap at adjustInventoryAction is bypassed here — only the
    // stocktake-internal 5k/500 cap applies). A compromised manager
    // cookie could doctor counted_qty on every high-value SKU before
    // accept. Step-up bounds the attack to the step-up bucket cap.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: ctx.employee.id,
      orgId,
      actorPassword,
      bucketKey: 'stocktake-accept-stepup',
    });
    if (!stepUp.ok) {
      throw new Error(stepUp.error);
    }

    const client = await orgTx(orgId);
    try {
      const { rows: st } = await client.query(
        `SELECT id, status, location_id FROM stocktakes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [stocktakeId, orgId],
      );
      if (st.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Stocktake not found");
      }
      // R31-H1: non-manager callers must be assigned to the
      // stocktake's location. Prior shape skipped this check and let
      // a non-manager accept a foreign-location stocktake — driving
      // ABSOLUTE-mode writes into inventory_levels rows they shouldn't
      // touch, bypassing the per-adjust ±1000 cap in
      // adjustInventoryAction.
      {
        const stocktakeLocationId = st[0].location_id as string;
        const isManagerOrOwner = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
        if (!isManagerOrOwner && !(ctx.employee.locationIds ?? []).includes(stocktakeLocationId)) {
          await client.query("ROLLBACK");
          throw new Error("Stocktake not found");
        }
      }
      if (st[0].status !== "in_progress" && st[0].status !== "pending_review") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot accept ${st[0].status} stocktake`);
      }
      const locationId = st[0].location_id as string;

      // Load counted lines with variance. Apply each variance to inventory_levels
      // and log an inventory_adjustments row.
      // check-pool-org-filter: scoped-by-parent-stocktake-org-verified-line-202
      const { rows: lines } = await client.query(
        `SELECT id, product_variant_id, expected_qty, counted_qty
         FROM stocktake_lines
         WHERE stocktake_id = $1 AND counted_qty IS NOT NULL`,
        [stocktakeId],
      );

      // Switch to ABSOLUTE-mode accept: set on_hand = counted_qty, compute
      // the applied delta from the row's actual on_hand at lock time rather
      // than the stale expected_qty snapshot. Previously, if inventory
      // dropped during the stocktake (e.g. sales continued while counting),
      // the variance-as-delta approach `on_hand = on_hand + variance` would
      // double-count the between-times sales and silently destroy stock.
      // Locking FOR UPDATE gives us the row's actual value at apply time.
      // The audit row now records the TRUE applied delta and the pre/post
      // values, so reconciliation can reconstruct the sequence correctly
      // (R10-H-4 + R10-H-5).
      //
      // R25-perf-1: the prior shape did 3 queries per line (SELECT FOR
      // UPDATE + UPDATE + INSERT) → 500-line stocktake = 1500 round-trips
      // ≈ 22-45 seconds of UI freeze. New shape uses 3 queries total:
      //   1. Lock every candidate inventory_levels row with
      //      WHERE product_variant_id = ANY($1) ... FOR UPDATE
      //   2. Batch UPDATE via CTE + unnest
      //   3. Batch INSERT inventory_adjustments via unnest
      // 500× speedup, same correctness (per-row priorOnHand snapshot,
      // rows still locked before mutation).
      const typedLines = lines as Array<{ id: string; product_variant_id: string; expected_qty: number; counted_qty: number }>;
      const variantIds = typedLines.map((l) => l.product_variant_id);

      const { rows: lockedRows } = await client.query(
        `SELECT id, product_variant_id, on_hand FROM inventory_levels
         WHERE product_variant_id = ANY($1::uuid[]) AND location_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [variantIds, locationId, orgId],
      );
      const lockedMap = new Map<string, { id: string; priorOnHand: number }>();
      for (const row of lockedRows as Array<{ id: string; product_variant_id: string; on_hand: number }>) {
        lockedMap.set(row.product_variant_id, {
          id: row.id,
          priorOnHand: Number(row.on_hand) || 0,
        });
      }

      // R38-A-F9: cap per-line applied delta, matching the
      // `adjustInventoryAction` pattern. Without this, a clerk (or
      // compromised clerk credential) could submit `counted_qty = 0`
      // on every high-value SKU and accept — wiping the ledger in a
      // single step. Conversely, `counted_qty = expected + 1_000_000`
      // mints phantom stock an accomplice can then sell. The cap mirrors
      // the manager-role cap used for adjustments (5,000 units), but
      // tighter than `receivingQuantity` because accepts apply to
      // EVERY line in one commit rather than an itemized receive. Non-
      // manager callers cap at 500; manager/owner cap at 5,000.
      const isManagerOrOwner2 = ctx.employee.roleKey === 'owner' || ctx.employee.roleKey === 'manager';
      const perLineDeltaCap = isManagerOrOwner2 ? 5_000 : 500;

      const updateIds: string[] = [];
      const updateCounts: number[] = [];
      const adjInvLevelIds: string[] = [];
      const adjVariantIds: string[] = [];
      const adjDeltas: number[] = [];
      const adjResulting: number[] = [];
      for (const line of typedLines) {
        const locked = lockedMap.get(line.product_variant_id);
        if (!locked) continue; // no inventory row for this variant — skip
        const counted = Number(line.counted_qty) || 0;
        const appliedDelta = counted - locked.priorOnHand;
        if (appliedDelta === 0) continue;
        if (Math.abs(appliedDelta) > perLineDeltaCap) {
          await client.query('ROLLBACK');
          throw new Error(
            `Stocktake line delta ${appliedDelta} exceeds per-line cap ${perLineDeltaCap}. ` +
            `Split the count into smaller buckets or escalate to a manager.`,
          );
        }
        updateIds.push(locked.id);
        updateCounts.push(counted);
        adjInvLevelIds.push(locked.id);
        adjVariantIds.push(line.product_variant_id);
        adjDeltas.push(appliedDelta);
        adjResulting.push(counted);
      }

      if (updateIds.length > 0) {
        await client.query(
          `UPDATE inventory_levels il
             SET on_hand = delta.counted, updated_at = NOW()
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::int[]) AS counted) AS delta
           WHERE il.id = delta.id AND il.organization_id = $3`,
          [updateIds, updateCounts, orgId],
        );
        // Schema: inventory_adjustments(id, inventory_level_id, product_variant_id,
        // R32-D6: inventory_adjustments now has organization_id
        // (migration 063). Every INSERT carries the caller's verified
        // org explicitly; prior RLS-JOIN-based tenancy was fragile.
        await client.query(
          `INSERT INTO inventory_adjustments
             (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
           SELECT $7, unnest($1::uuid[]), unnest($2::uuid[]), $3, $4, 'stocktake_adjustment',
                  unnest($5::int[]), unnest($6::int[])`,
          [adjInvLevelIds, adjVariantIds, locationId, ctx.employee.id, adjDeltas, adjResulting, orgId],
        );
      }

      await client.query(
        `UPDATE stocktakes
           SET status = 'accepted', accepted_by = $1, accepted_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND organization_id = $3`,
        [ctx.employee.id, stocktakeId, orgId],
      );
      // R49: audit INSIDE the tx. stocktake_accepted wipes/adds stock
      // via ABSOLUTE-mode counted_qty — the highest-blast-radius inv
      // write in the system. Post-commit audit fails silently; in-tx
      // audit rolls back with the write if either fails.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'stocktake', $5, 'stocktake_accepted', $6, now())`,
        [
          randomUUID(), orgId, locationId, ctx.employee.id, stocktakeId,
          JSON.stringify({ variance_lines: lines.length }),
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
      const stocktake = store.stocktakes.find((s) => s.id === stocktakeId);
      if (!stocktake) throw new Error("Stocktake not found");
      if (stocktake.status !== "in_progress" && stocktake.status !== "pending_review") {
        throw new Error(`Cannot accept ${stocktake.status} stocktake`);
      }

      const now = new Date().toISOString();
      stocktake.status = "accepted";
      stocktake.acceptedBy = ctx.employee.id;
      stocktake.acceptedAt = now;
      stocktake.updatedAt = now;

      const lines = store.stocktakeLines.filter((l) => l.stocktakeId === stocktakeId && l.countedQty != null);
      for (const line of lines) {
        const variance = (line.countedQty ?? 0) - line.expectedQty;
        if (variance === 0) continue;

        const inv = store.inventory.find(
          (i) => i.productVariantId === line.productVariantId && i.locationId === stocktake.locationId,
        );
        if (inv) {
          inv.onHand = Math.max(0, inv.onHand + variance);
          inv.updatedAt = now;
          store.inventoryAdjustments.push({
            id: crypto.randomUUID(),
            inventoryLevelId: inv.id,
            productVariantId: line.productVariantId,
            locationId: stocktake.locationId,
            employeeId: ctx.employee.id,
            reason: "stocktake_adjustment",
            delta: variance,
            resultingOnHand: inv.onHand,
            createdAt: now,
          });
        }
      }
    });
  }

  revalidatePath("/admin");
}

export async function cancelStocktakeAction(stocktakeId: string) {
  const ctx = await requireAdminPermission("inventory.adjust");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R31-H1: location-assignment gate before mutating state.
      await requireStocktakeLocationAccess(client, stocktakeId, orgId, ctx.employee);
      const { rows } = await client.query(
        `UPDATE stocktakes SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND status IN ('in_progress', 'pending_review')
         RETURNING id`,
        [stocktakeId, orgId],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Stocktake cannot be cancelled in its current state");
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const stocktake = store.stocktakes.find((s) => s.id === stocktakeId);
      if (!stocktake) throw new Error("Stocktake not found");
      stocktake.status = "cancelled";
      stocktake.updatedAt = new Date().toISOString();
    });
  }

  revalidatePath("/admin");
}
