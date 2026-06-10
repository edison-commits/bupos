import "server-only";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { decryptSecret } from "./crypto";
import { getChannelProvider } from "./index";
import type { ChannelCredentials, OrderLine } from "./types";

export interface IntegrationRow {
  id: string;
  organization_id: string;
  provider: string;
  shop_domain: string | null;
  access_token_ciphertext: string | null;
  webhook_secret_ciphertext: string | null;
  fulfillment_location_id: string | null;
  shopify_location_id: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  connected_by_employee_id: string | null;
  sync_prices: boolean;
}

/** Load the org's (single) channel integration row, or null. */
export async function loadIntegration(orgId: string, provider = "shopify"): Promise<IntegrationRow | null> {
  const { rows } = await orgQuery(
    orgId,
    `SELECT * FROM channel_integrations WHERE organization_id = $1 AND provider = $2 LIMIT 1`,
    [orgId, provider],
  );
  return (rows[0] as IntegrationRow) ?? null;
}

/** Decrypt the stored credentials. Returns null if the token can't be decrypted. */
export async function decryptCreds(row: IntegrationRow): Promise<ChannelCredentials | null> {
  if (!row.shop_domain || !row.access_token_ciphertext) return null;
  const accessToken = await decryptSecret(row.access_token_ciphertext);
  if (!accessToken) return null;
  const webhookSecret = (await decryptSecret(row.webhook_secret_ciphertext)) ?? undefined;
  return { shopDomain: row.shop_domain, accessToken, webhookSecret };
}

/**
 * Resolve the employee to attribute online inventory adjustments to. Prefer the
 * connector; fall back to any active owner so a missing/deactivated connector
 * never blocks a real online sale. (inventory_adjustments.employee_id is NOT NULL.)
 */
export async function resolveOnlineActor(orgId: string, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const { rows } = await orgQuery(
      orgId,
      `SELECT id FROM employees WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1`,
      [preferred, orgId],
    );
    if (rows[0]) return rows[0].id as string;
  }
  const { rows } = await orgQuery(
    orgId,
    `SELECT id FROM employees WHERE organization_id = $1 AND is_active = true AND role_key = 'owner' ORDER BY created_at ASC LIMIT 1`,
    [orgId],
  );
  return (rows[0]?.id as string) ?? null;
}

export interface DecrementResult {
  applied: { variantId: string; requested: number; resultingOnHand: number; oversold: boolean }[];
}

/**
 * Decrement on_hand at the fulfillment location for resolved online-order lines,
 * recording an inventory_adjustments row per variant (reason 'online_sale').
 * Reuses the exact checkout-action.ts batched pattern (GREATEST(0, …) clamp +
 * adjustments). Must be called inside an open orgTx `client`.
 */
export async function applyOnlineDecrement(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  orgId: string,
  fulfillmentLocationId: string,
  actorEmployeeId: string,
  lines: { variantId: string; qty: number }[],
): Promise<DecrementResult> {
  if (lines.length === 0) return { applied: [] };
  const variantIds = lines.map((l) => l.variantId);
  const decrements = lines.map((l) => -Math.abs(Math.floor(l.qty))); // negative deltas
  const { rows } = await client.query(
    `WITH updated AS (
       UPDATE inventory_levels il
       SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
       FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
       WHERE il.product_variant_id = delta.variant_id
         AND il.location_id = $3
         AND il.organization_id = $5
       RETURNING il.id AS inventory_level_id, il.product_variant_id, il.on_hand, delta.qty AS delta_qty
     )
     INSERT INTO inventory_adjustments
       (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
     SELECT $5, inventory_level_id, product_variant_id, $3, $4, 'online_sale', delta_qty, on_hand
     FROM updated
     RETURNING product_variant_id, delta, resulting_on_hand`,
    [variantIds, decrements, fulfillmentLocationId, actorEmployeeId, orgId],
  );
  const byVariant = new Map(lines.map((l) => [l.variantId, Math.abs(Math.floor(l.qty))]));
  return {
    applied: (rows as { product_variant_id: string; delta: number; resulting_on_hand: number }[]).map((r) => {
      const requested = byVariant.get(r.product_variant_id) ?? Math.abs(r.delta);
      // Oversold when the clamp ate part of the decrement (floor at 0).
      const oversold = Math.abs(r.delta) < requested;
      return { variantId: r.product_variant_id, requested, resultingOnHand: r.resulting_on_hand, oversold };
    }),
  };
}

/**
 * Restock on_hand at the fulfillment location (positive delta) for refunded/
 * restocked online-order lines, with an inventory_adjustments row per variant
 * (reason 'online_refund'). Mirror of applyOnlineDecrement. Inside an orgTx.
 */
export async function applyOnlineRestock(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  orgId: string,
  fulfillmentLocationId: string,
  actorEmployeeId: string,
  lines: { variantId: string; qty: number }[],
): Promise<string[]> {
  if (lines.length === 0) return [];
  const variantIds = lines.map((l) => l.variantId);
  const increments = lines.map((l) => Math.abs(Math.floor(l.qty))); // positive deltas
  const { rows } = await client.query(
    `WITH updated AS (
       UPDATE inventory_levels il
       SET on_hand = il.on_hand + delta.qty, updated_at = now()
       FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
       WHERE il.product_variant_id = delta.variant_id
         AND il.location_id = $3
         AND il.organization_id = $5
       RETURNING il.id AS inventory_level_id, il.product_variant_id, il.on_hand, delta.qty AS delta_qty
     )
     INSERT INTO inventory_adjustments
       (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
     SELECT $5, inventory_level_id, product_variant_id, $3, $4, 'online_refund', delta_qty, on_hand
     FROM updated
     RETURNING product_variant_id`,
    [variantIds, increments, fulfillmentLocationId, actorEmployeeId, orgId],
  );
  return (rows as { product_variant_id: string }[]).map((r) => r.product_variant_id);
}

/** Resolve order line SKUs → active BuPOS variants (is_active only — SKU uniqueness is active-only). */
export async function resolveSkus(
  orgId: string,
  lines: OrderLine[],
): Promise<{ resolved: { variantId: string; qty: number }[]; unresolved: string[] }> {
  const resolved: { variantId: string; qty: number }[] = [];
  const unresolved: string[] = [];
  for (const line of lines) {
    if (!line.sku || line.quantity <= 0) {
      if (line.sku) unresolved.push(line.sku);
      continue;
    }
    const { rows } = await orgQuery(
      orgId,
      `SELECT id FROM product_variants WHERE organization_id = $1 AND sku = $2 AND is_active = true LIMIT 1`,
      [orgId, line.sku],
    );
    if (rows[0]) resolved.push({ variantId: rows[0].id as string, qty: line.quantity });
    else unresolved.push(line.sku);
  }
  return { resolved, unresolved };
}

export interface MapSummary { mapped: number; unresolved: string[]; ambiguous: string[]; alreadyMapped: number }

/**
 * Lazily build the BuPOS variant -> Shopify map for active variants with a SKU
 * that aren't mapped yet. Bounded per call (Shopify rate limits); re-run to
 * continue. Only the PUSH direction needs this — order intake resolves SKUs
 * against the local DB.
 */
export async function ensureMapped(row: IntegrationRow, creds: ChannelCredentials, limit = 250): Promise<MapSummary> {
  const summary: MapSummary = { mapped: 0, unresolved: [], ambiguous: [], alreadyMapped: 0 };
  if (!row.fulfillment_location_id || !row.shopify_location_id) return summary;
  const provider = getChannelProvider(row.provider);
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT pv.id, pv.sku
       FROM product_variants pv
      WHERE pv.organization_id = $1 AND pv.is_active = true
        AND pv.sku IS NOT NULL AND pv.sku <> ''
        AND NOT EXISTS (
          SELECT 1 FROM channel_product_map m
           WHERE m.channel_integration_id = $2 AND m.product_variant_id = pv.id
        )
      ORDER BY pv.updated_at DESC
      LIMIT $3`,
    [row.organization_id, row.id, limit],
  );
  for (const r of rows as { id: string; sku: string }[]) {
    const lookup = await provider.findVariantBySku(creds, r.sku);
    if (lookup.kind === "none") { summary.unresolved.push(r.sku); continue; }
    if (lookup.kind === "ambiguous") { summary.ambiguous.push(r.sku); continue; }
    await orgQuery(
      row.organization_id,
      `INSERT INTO channel_product_map
         (organization_id, channel_integration_id, product_variant_id, sku, external_variant_id, external_inventory_item_id, external_product_id, shopify_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (channel_integration_id, product_variant_id) DO UPDATE SET
         external_variant_id = EXCLUDED.external_variant_id,
         external_inventory_item_id = EXCLUDED.external_inventory_item_id,
         external_product_id = EXCLUDED.external_product_id,
         shopify_location_id = EXCLUDED.shopify_location_id,
         sku = EXCLUDED.sku, updated_at = now()`,
      [row.organization_id, row.id, r.id, r.sku, lookup.match.externalVariantId, lookup.match.externalInventoryItemId, lookup.match.externalProductId, row.shopify_location_id],
    );
    summary.mapped++;
  }
  return summary;
}

export interface PushSummary { pushed: number; skipped: number; failed: number; errors: string[] }

/**
 * Push absolute on_hand (at the fulfillment location) to Shopify for mapped
 * variants. `onlyVariantIds` limits the set (post-order pushback / reconcile);
 * null = all mapped. Skips no-ops (on_hand === last_pushed_on_hand).
 */
export async function pushInventory(
  row: IntegrationRow,
  creds: ChannelCredentials,
  onlyVariantIds: string[] | null,
): Promise<PushSummary> {
  const summary: PushSummary = { pushed: 0, skipped: 0, failed: 0, errors: [] };
  if (!row.fulfillment_location_id) return summary;
  const provider = getChannelProvider(row.provider);

  const params: unknown[] = [row.organization_id, row.id, row.fulfillment_location_id];
  let filter = "";
  if (onlyVariantIds && onlyVariantIds.length) {
    params.push(onlyVariantIds);
    filter = ` AND m.product_variant_id = ANY($4::uuid[])`;
  }
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT m.id AS map_id, m.product_variant_id, m.external_inventory_item_id, m.shopify_location_id,
            m.last_pushed_on_hand, COALESCE(il.on_hand, 0) AS on_hand
       FROM channel_product_map m
       LEFT JOIN inventory_levels il
         ON il.product_variant_id = m.product_variant_id
        AND il.location_id = $3
        AND il.organization_id = $1
      WHERE m.organization_id = $1 AND m.channel_integration_id = $2${filter}`,
    params,
  );

  for (const r of rows as { map_id: string; external_inventory_item_id: string; shopify_location_id: string; last_pushed_on_hand: number | null; on_hand: number }[]) {
    if (r.last_pushed_on_hand !== null && Number(r.last_pushed_on_hand) === Number(r.on_hand)) {
      summary.skipped++;
      continue;
    }
    const res = await provider.setInventory(creds, r.external_inventory_item_id, r.shopify_location_id, Number(r.on_hand));
    if (res.ok) {
      summary.pushed++;
      await orgQuery(
        row.organization_id,
        `UPDATE channel_product_map SET last_pushed_on_hand = $1, last_pushed_at = now(), updated_at = now() WHERE id = $2 AND organization_id = $3`,
        [Number(r.on_hand), r.map_id, row.organization_id],
      );
    } else {
      summary.failed++;
      if (res.error) summary.errors.push(res.error);
    }
  }
  return summary;
}

/**
 * Push variant prices (+ compare-at) to Shopify for mapped variants whose price
 * changed since the last push. POS-authoritative. `onlyVariantIds` limits the
 * set; null = all mapped. Backfills external_product_id for any pre-Phase-2 map
 * rows (productVariantsBulkUpdate needs the product GID).
 */
export async function pushPrices(
  row: IntegrationRow,
  creds: ChannelCredentials,
  onlyVariantIds: string[] | null,
): Promise<PushSummary> {
  const summary: PushSummary = { pushed: 0, skipped: 0, failed: 0, errors: [] };
  const provider = getChannelProvider(row.provider);

  const params: unknown[] = [row.organization_id, row.id];
  let filter = "";
  if (onlyVariantIds && onlyVariantIds.length) {
    params.push(onlyVariantIds);
    filter = ` AND m.product_variant_id = ANY($3::uuid[])`;
  }
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT m.id AS map_id, m.product_variant_id, m.external_product_id, m.external_variant_id, m.sku,
            m.last_pushed_price, m.last_pushed_compare_at,
            pv.price::numeric AS price, pv.compare_at_price::numeric AS compare_at
       FROM channel_product_map m
       JOIN product_variants pv ON pv.id = m.product_variant_id AND pv.organization_id = $1
      WHERE m.organization_id = $1 AND m.channel_integration_id = $2${filter}`,
    params,
  );

  for (const r of rows as { map_id: string; sku: string; external_product_id: string | null; external_variant_id: string; last_pushed_price: number | null; last_pushed_compare_at: number | null; price: number; compare_at: number | null }[]) {
    const price = Number(r.price);
    const compareAt = r.compare_at != null ? Number(r.compare_at) : null;
    if (r.last_pushed_price !== null && Number(r.last_pushed_price) === price
        && Number(r.last_pushed_compare_at ?? NaN) === Number(compareAt ?? NaN)) {
      summary.skipped++;
      continue;
    }
    let productId = r.external_product_id;
    if (!productId) {
      // Backfill the product GID for a pre-Phase-2 map row.
      const lookup = await provider.findVariantBySku(creds, r.sku);
      if (lookup.kind !== "unique") { summary.failed++; continue; }
      productId = lookup.match.externalProductId;
      await orgQuery(row.organization_id, `UPDATE channel_product_map SET external_product_id=$1, updated_at=now() WHERE id=$2 AND organization_id=$3`, [productId, r.map_id, row.organization_id]);
    }
    const res = await provider.setVariantPrice(creds, productId, r.external_variant_id, price, compareAt);
    if (res.ok) {
      summary.pushed++;
      await orgQuery(row.organization_id, `UPDATE channel_product_map SET last_pushed_price=$1, last_pushed_compare_at=$2, updated_at=now() WHERE id=$3 AND organization_id=$4`, [price, compareAt, r.map_id, row.organization_id]);
    } else {
      summary.failed++;
      if (res.error) summary.errors.push(res.error);
    }
  }
  return summary;
}

export interface OnlineOrderRow {
  externalOrderNumber: string | null;
  financialStatus: string | null;
  total: number | null;
  currency: string | null;
  decrementStatus: string;
  unresolvedCount: number;
  createdAt: string;
}
export interface OnlineSalesReport {
  summary: { orderCount: number; revenue: number; refundedCount: number; needsAttention: number; currency: string | null };
  orders: OnlineOrderRow[];
}

/**
 * Dedicated "Online Sales" report, fed from online_orders only — deliberately
 * separate from the in-store `transactions` table so online revenue never
 * lands in a cashier's drawer/shift reconciliation (online has no cash drawer).
 * Org-scoped + date-ranged. `revenue` excludes cancelled orders; needsAttention
 * counts orders with an unmatched SKU or a partial inventory decrement.
 */
export async function getOnlineSalesReport(orgId: string, sinceIso: string, limit = 100): Promise<OnlineSalesReport> {
  const s = await orgQuery(
    orgId,
    `SELECT
        count(*)::int AS order_count,
        COALESCE(SUM(total) FILTER (WHERE financial_status IS DISTINCT FROM 'cancelled'), 0)::float8 AS revenue,
        count(*) FILTER (WHERE financial_status = 'refunded')::int AS refunded_count,
        count(*) FILTER (WHERE decrement_status = 'partial' OR jsonb_array_length(unresolved_skus) > 0)::int AS needs_attention,
        (SELECT currency FROM online_orders
          WHERE organization_id = $1 AND created_at >= $2::timestamptz AND currency IS NOT NULL
          ORDER BY created_at DESC LIMIT 1) AS currency
      FROM online_orders
      WHERE organization_id = $1 AND created_at >= $2::timestamptz`,
    [orgId, sinceIso],
  );
  const sum = (s.rows[0] as { order_count: number; revenue: number; refunded_count: number; needs_attention: number; currency: string | null })
    ?? { order_count: 0, revenue: 0, refunded_count: 0, needs_attention: 0, currency: null };

  const o = await orgQuery(
    orgId,
    `SELECT external_order_number, financial_status, total::float8 AS total, currency, decrement_status,
            jsonb_array_length(unresolved_skus)::int AS unresolved_count, created_at
       FROM online_orders
      WHERE organization_id = $1 AND created_at >= $2::timestamptz
      ORDER BY created_at DESC
      LIMIT $3`,
    [orgId, sinceIso, limit],
  );
  return {
    summary: {
      orderCount: sum.order_count,
      revenue: Number(sum.revenue),
      refundedCount: sum.refunded_count,
      needsAttention: sum.needs_attention,
      currency: sum.currency,
    },
    orders: (o.rows as {
      external_order_number: string | null; financial_status: string | null; total: number | null;
      currency: string | null; decrement_status: string; unresolved_count: number; created_at: string;
    }[]).map((r) => ({
      externalOrderNumber: r.external_order_number,
      financialStatus: r.financial_status,
      total: r.total != null ? Number(r.total) : null,
      currency: r.currency,
      decrementStatus: r.decrement_status,
      unresolvedCount: r.unresolved_count,
      createdAt: r.created_at,
    })),
  };
}

/** Variants (mapped) whose on_hand OR price changed since last_sync, for the reconcile cron. */
export async function changedSinceLastSync(row: IntegrationRow): Promise<string[]> {
  const since = row.last_sync_at ?? "epoch";
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT DISTINCT m.product_variant_id
       FROM channel_product_map m
       JOIN product_variants pv ON pv.id = m.product_variant_id AND pv.organization_id = $1
       LEFT JOIN inventory_levels il
         ON il.product_variant_id = m.product_variant_id
        AND il.location_id = $3
        AND il.organization_id = $1
      WHERE m.organization_id = $1 AND m.channel_integration_id = $2
        AND ( (il.updated_at IS NOT NULL AND il.updated_at > $4::timestamptz)
              OR pv.updated_at > $4::timestamptz )`,
    [row.organization_id, row.id, row.fulfillment_location_id, since],
  );
  return (rows as { product_variant_id: string }[]).map((r) => r.product_variant_id);
}

export { orgTx };
