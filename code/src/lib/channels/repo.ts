import "server-only";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { decryptSecret } from "./crypto";
import { getChannelProvider } from "./index";
import type { ChannelCredentials, OrderLine } from "./types";
import { buildPublishInput, type PublishCandidateVariant } from "./publish-mapping";

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

export interface ReconciliationItem {
  productVariantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  buposOnHand: number;
  shopifyOnHand: number | null;
  drift: number | null;
  status: "in_sync" | "needs_attention" | "error";
  error?: string;
}
export interface InventoryReconciliationReport {
  summary: { total: number; inSync: number; needsAttention: number; errors: number; checkedAt: string };
  items: ReconciliationItem[];
}

/** Compare BUPOS fulfillment-location on-hand to live Shopify available quantity. */
export async function getInventoryReconciliation(
  row: IntegrationRow,
  creds: ChannelCredentials,
  limit = 100,
): Promise<InventoryReconciliationReport> {
  const checkedAt = new Date().toISOString();
  const report: InventoryReconciliationReport = { summary: { total: 0, inSync: 0, needsAttention: 0, errors: 0, checkedAt }, items: [] };
  if (!row.fulfillment_location_id) return report;
  const provider = getChannelProvider(row.provider);
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT m.product_variant_id, m.sku, m.external_inventory_item_id, m.shopify_location_id,
            p.name AS product_name, pv.name AS variant_name, COALESCE(il.on_hand, 0)::int AS bupos_on_hand
       FROM channel_product_map m
       JOIN product_variants pv ON pv.id = m.product_variant_id AND pv.organization_id = $1
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
       LEFT JOIN inventory_levels il
         ON il.product_variant_id = m.product_variant_id
        AND il.location_id = $3
        AND il.organization_id = $1
      WHERE m.organization_id = $1 AND m.channel_integration_id = $2
      ORDER BY ABS(COALESCE(il.on_hand, 0) - COALESCE(m.last_pushed_on_hand, 0)) DESC, p.name ASC
      LIMIT $4`,
    [row.organization_id, row.id, row.fulfillment_location_id, limit],
  );

  for (const r of rows as { product_variant_id: string; sku: string; external_inventory_item_id: string; shopify_location_id: string; product_name: string; variant_name: string | null; bupos_on_hand: number }[]) {
    const remote = await provider.getInventoryQuantity(creds, r.external_inventory_item_id, r.shopify_location_id);
    if (!remote.ok || typeof remote.quantity !== "number") {
      report.summary.errors++;
      report.items.push({ productVariantId: r.product_variant_id, sku: r.sku, productName: r.product_name, variantName: r.variant_name, buposOnHand: Number(r.bupos_on_hand), shopifyOnHand: null, drift: null, status: "error", error: remote.error ?? "Shopify inventory unavailable" });
      continue;
    }
    const buposOnHand = Number(r.bupos_on_hand);
    const shopifyOnHand = Number(remote.quantity);
    const drift = shopifyOnHand - buposOnHand;
    const status = drift === 0 ? "in_sync" : "needs_attention";
    if (status === "in_sync") report.summary.inSync++; else report.summary.needsAttention++;
    report.items.push({ productVariantId: r.product_variant_id, sku: r.sku, productName: r.product_name, variantName: r.variant_name, buposOnHand, shopifyOnHand, drift, status });
  }
  report.summary.total = report.items.length;
  return report;
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

// ─────────────────────────── Phase 3c: product publishing ───────────────────────────

export interface PublishableProduct {
  productId: string;
  name: string;
  variantCount: number;
  hasImage: boolean;
  minPrice: number;
  maxPrice: number;
}

/** Active products with ≥1 active SKU'd variant that aren't on the channel yet. */
export async function listPublishableProducts(row: IntegrationRow, limit = 200): Promise<PublishableProduct[]> {
  const { rows } = await orgQuery(
    row.organization_id,
    `SELECT p.id, p.name, (p.image_url IS NOT NULL AND p.image_url <> '') AS has_image,
            count(pv.id)::int AS variant_count,
            min(pv.price)::float8 AS min_price, max(pv.price)::float8 AS max_price
       FROM products p
       JOIN product_variants pv
         ON pv.product_id = p.id AND pv.organization_id = $1 AND pv.is_active = true AND pv.sku <> ''
      WHERE p.organization_id = $1 AND p.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM channel_product_map m
            JOIN product_variants pv2 ON pv2.id = m.product_variant_id AND pv2.organization_id = $1
           WHERE m.channel_integration_id = $2 AND pv2.product_id = p.id
        )
      GROUP BY p.id, p.name, p.image_url
      ORDER BY p.name ASC
      LIMIT $3`,
    [row.organization_id, row.id, limit],
  );
  return (rows as { id: string; name: string; has_image: boolean; variant_count: number; min_price: number; max_price: number }[]).map((r) => ({
    productId: r.id,
    name: r.name,
    variantCount: r.variant_count,
    hasImage: r.has_image,
    minPrice: Number(r.min_price),
    maxPrice: Number(r.max_price),
  }));
}

export interface PublishProductsSummary {
  published: { productId: string; name: string; variants: number; warnings: string[] }[];
  failed: { productId: string; name: string; error: string }[];
}

/**
 * Publish selected BuPOS products to the channel, then map each created variant
 * back into channel_product_map (so inventory/price sync flows thereafter). The
 * seeded on_hand becomes last_pushed_on_hand to avoid an immediate redundant push.
 */
export async function publishProducts(row: IntegrationRow, creds: ChannelCredentials, productIds: string[]): Promise<PublishProductsSummary> {
  const summary: PublishProductsSummary = { published: [], failed: [] };
  if (!row.fulfillment_location_id || !row.shopify_location_id) return summary;
  const provider = getChannelProvider(row.provider);

  for (const productId of productIds) {
    const pr = await orgQuery(
      row.organization_id,
      `SELECT name, description FROM products WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1`,
      [productId, row.organization_id],
    );
    const product = pr.rows[0] as { name: string; description: string | null } | undefined;
    if (!product) { summary.failed.push({ productId, name: "(unknown)", error: "product not found" }); continue; }

    const vr = await orgQuery(
      row.organization_id,
      `SELECT pv.id, pv.sku, pv.price::float8 AS price, pv.compare_at_price::float8 AS compare_at_price,
              pv.name, pv.size_label, pv.color_label, COALESCE(il.on_hand, 0) AS on_hand
         FROM product_variants pv
         LEFT JOIN inventory_levels il
           ON il.product_variant_id = pv.id AND il.location_id = $3 AND il.organization_id = $1
        WHERE pv.organization_id = $1 AND pv.product_id = $2 AND pv.is_active = true AND pv.sku <> ''
        ORDER BY pv.created_at ASC`,
      [row.organization_id, productId, row.fulfillment_location_id],
    );
    const candidates: PublishCandidateVariant[] = (vr.rows as { id: string; sku: string; price: number; compare_at_price: number | null; name: string; size_label: string | null; color_label: string | null; on_hand: number }[]).map((r) => ({
      variantId: r.id,
      sku: r.sku,
      price: Number(r.price),
      compareAtPrice: r.compare_at_price != null ? Number(r.compare_at_price) : null,
      name: r.name,
      sizeLabel: r.size_label,
      colorLabel: r.color_label,
      onHand: Number(r.on_hand),
    }));
    if (candidates.length === 0) { summary.failed.push({ productId, name: product.name, error: "no active variants with a SKU" }); continue; }

    const input = buildPublishInput(product, candidates, row.shopify_location_id);
    const res = await provider.publishProduct(creds, input);
    if (!res.ok || !res.variants) { summary.failed.push({ productId, name: product.name, error: res.error ?? "publish failed" }); continue; }

    const bySku = new Map(candidates.map((c) => [c.sku, c]));
    for (const pubVar of res.variants) {
      const cand = bySku.get(pubVar.sku);
      if (!cand) continue;
      await orgQuery(
        row.organization_id,
        `INSERT INTO channel_product_map
           (organization_id, channel_integration_id, product_variant_id, sku, external_variant_id, external_inventory_item_id, external_product_id, shopify_location_id, last_pushed_on_hand, last_pushed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (channel_integration_id, product_variant_id) DO UPDATE SET
           external_variant_id = EXCLUDED.external_variant_id,
           external_inventory_item_id = EXCLUDED.external_inventory_item_id,
           external_product_id = EXCLUDED.external_product_id,
           shopify_location_id = EXCLUDED.shopify_location_id,
           sku = EXCLUDED.sku, last_pushed_on_hand = EXCLUDED.last_pushed_on_hand, updated_at = now()`,
        [row.organization_id, row.id, cand.variantId, cand.sku, pubVar.externalVariantId, pubVar.externalInventoryItemId, pubVar.externalProductId, row.shopify_location_id, cand.onHand],
      );
    }
    summary.published.push({ productId, name: product.name, variants: res.variants.length, warnings: res.warnings ?? [] });
  }
  return summary;
}

export { orgTx };
