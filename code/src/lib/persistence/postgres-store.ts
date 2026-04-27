import 'server-only';
import pool, { orgTx } from '@/lib/db';
import type { Category, Customer, Employee, InventoryLevel, Product, ProductVariant, RegisterSessionRecord, ShiftRecord } from '@/lib/domain/types';
import type { AuthCredentialRecord, InventoryAdjustmentRecord } from '@/lib/persistence/types';
import { safeErr } from '@/lib/logging/safe-err';
// Static import: the Workers runtime flag `no_handle_cross_request_promise_resolution`
// cancels in-flight Promises when the response returns. A previous
// `void import('...').then(invalidateStoreCache)` pattern would drop the
// cascade on cold-worker first-use (R11-H-2). postgres-read-store has no
// dependency on this file, so no cycle.
import { invalidateStoreCache } from '@/lib/persistence/postgres-read-store';

// Generic TTL cache for read functions
// Caches the result for TTL_MS, then refetches.
// Call the invalidate function after any mutation.
const PG_READ_TTL_MS = 30_000;

interface CacheEntry<T> { data: T; expiresAt: number; }

// Per-org caches
const _employeesCache = new Map<string, CacheEntry<Employee[]>>();
const _productsCache = new Map<string, CacheEntry<Product[]>>();
const _variantsCache = new Map<string, CacheEntry<ProductVariant[]>>();
const _inventoryCache = new Map<string, CacheEntry<InventoryLevel[]>>();
const _locationsCache = new Map<string, CacheEntry<import('@/lib/domain/types').Location[]>>();
const _categoriesCache = new Map<string, CacheEntry<Category[]>>();

// ── Helpers ───────────────────────────────────────────────────────────

function toCategory(row: Record<string, unknown>): Category {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    slug: row.slug as string,
    parentCategoryId: (row.parent_category_id as string) ?? undefined,
    sortOrder: row.sort_order as number,
    imageUrl: (row.image_url as string) ?? undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    categoryId: row.category_id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string) ?? undefined,
    imageUrl: (row.image_url as string) ?? undefined,
    isActive: row.is_active as boolean,
    isTouchFavorite: row.is_touch_favorite as boolean,
    defaultVariantId: (row.default_variant_id as string) ?? undefined,
    modifierGroupIds: (row.modifier_group_ids as string[]) ?? [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toVariant(row: Record<string, unknown>): ProductVariant {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    productId: row.product_id as string,
    sku: row.sku as string,
    barcode: (row.barcode as string) ?? undefined,
    name: row.name as string,
    sizeLabel: (row.size_label as string) ?? undefined,
    colorLabel: (row.color_label as string) ?? undefined,
    price: Number(row.price),
    compareAtPrice: row.compare_at_price != null ? Number(row.compare_at_price) : undefined,
    cost: row.cost != null ? Number(row.cost) : undefined,
    isActive: row.is_active as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toInventory(row: Record<string, unknown>): InventoryLevel {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    locationId: row.location_id as string,
    productVariantId: row.product_variant_id as string,
    onHand: row.on_hand as number,
    reserved: row.reserved as number,
    reorderPoint: row.reorder_point as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toEmployee(row: Record<string, unknown>): Employee {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    locationIds: (row.location_ids as string[]) ?? [],
    roleKey: row.role_key as Employee['roleKey'],
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    displayName: row.display_name as string,
    email: (row.email as string) ?? undefined,
    pinHint: (row.pin_hint as string) ?? '',
    isActive: row.is_active as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Categories ────────────────────────────────────────────────────────

export async function pgReadCategories(orgId: string): Promise<Category[]> {
  const cached = _categoriesCache.get(orgId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const { rows } = await pool.query(
    `SELECT id, organization_id, name, slug, parent_category_id, sort_order, image_url, created_at, updated_at
     FROM categories WHERE organization_id = $1 ORDER BY sort_order`,
    [orgId],
  );
  const data = rows.map(toCategory);
  _categoriesCache.set(orgId, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateCategoriesCache(): void { _categoriesCache.clear(); }

export async function pgCreateCategory(data: {
  id: string; organizationId: string; name: string; slug: string;
  sortOrder: number; imageUrl?: string; parentCategoryId?: string;
}): Promise<Category> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO categories (id, organization_id, slug, name, sort_order, image_url, parent_category_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [data.id, data.organizationId, data.slug, data.name, data.sortOrder, data.imageUrl ?? null, data.parentCategoryId ?? null, ts],
  );
  return toCategory(rows[0]);
}

// R30-C3: `organizationId` is REQUIRED (not optional). Every live caller
// in src/app/admin/actions.ts already passes it. Prior shape had an
// `organizationId?` signature with a fallback that ran the query
// WITHOUT an org filter — a future test or caller that forgot to pass
// orgId would silently operate cross-tenant.
export async function pgUpdateCategory(id: string, data: Partial<{ name: string; slug: string; sortOrder: number; imageUrl: string | null }>, organizationId: string): Promise<Category | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
  if (data.slug !== undefined) { sets.push(`slug = $${i++}`); vals.push(data.slug); }
  if (data.sortOrder !== undefined) { sets.push(`sort_order = $${i++}`); vals.push(data.sortOrder); }
  if (data.imageUrl !== undefined) { sets.push(`image_url = $${i++}`); vals.push(data.imageUrl); }
  if (sets.length === 0) return null;
  sets.push(`updated_at = $${i++}`);
  vals.push(new Date().toISOString());
  vals.push(id);
  vals.push(organizationId);
  const { rows } = await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`, vals);
  return rows[0] ? toCategory(rows[0]) : null;
}

export async function pgDeleteCategory(id: string, organizationId: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1 AND organization_id = $2', [id, organizationId]);
  return (rowCount ?? 0) > 0;
}

// ── Products ──────────────────────────────────────────────────────────

// NOTE: callers should be updated to pass ORG_ID (organizationId) from their request context.

export async function pgReadProducts(organizationId: string): Promise<Product[]> {
  const cached = _productsCache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const { rows } = await pool.query(
    `SELECT p.id, p.organization_id, p.category_id, p.name, p.slug, p.description, p.image_url,
            p.is_active, p.is_touch_favorite, p.default_variant_id, p.created_at, p.updated_at,
            COALESCE(array_agg(pmg.modifier_group_id) FILTER (WHERE pmg.modifier_group_id IS NOT NULL), '{}') AS modifier_group_ids
     FROM products p LEFT JOIN product_modifier_groups pmg ON p.id = pmg.product_id
     WHERE p.organization_id = $1
     GROUP BY p.id ORDER BY p.name`,
    [organizationId],
  );
  const data = rows.map(toProduct);
  _productsCache.set(organizationId, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateProductsCache(orgId?: string): void {
  if (orgId) {
    _productsCache.delete(orgId);
    // Cascade into the full-store cache so POS terminals (which read
    // through get_full_store) don't serve stale product lists for up
    // to 30 seconds after an admin create/update/delete. Matches the
    // employees + locations pattern.
    // R32-D2: scoped cascade — no-arg wipe is an architectural
    // mistake we closed in that round.
    invalidateStoreCache(orgId);
  } else {
    _productsCache.clear();
  }
}

export async function pgCreateProduct(data: {
  id: string; organizationId: string; categoryId: string; name: string; slug: string;
  description?: string; imageUrl?: string; isActive: boolean; isTouchFavorite: boolean;
  defaultVariantId?: string; modifierGroupIds: string[];
}): Promise<Product> {
  const ts = new Date().toISOString();
  const client = await orgTx(data.organizationId);
  try {
    const { rows } = await client.query(
      `INSERT INTO products (id, organization_id, category_id, slug, name, description, image_url, is_active, is_touch_favorite, default_variant_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
      [data.id, data.organizationId, data.categoryId, data.slug, data.name, data.description ?? null, data.imageUrl ?? null, data.isActive, data.isTouchFavorite, data.defaultVariantId ?? null, ts],
    );
    // R25-perf-5: was N sequential INSERTs inside the tx — one RTT per
    // modifier group. A product with 10 groups paid 10× 15-30ms. Batch
    // via unnest: single INSERT regardless of group count.
    if (data.modifierGroupIds.length > 0) {
      await client.query(
        `INSERT INTO product_modifier_groups (product_id, modifier_group_id)
         SELECT $1, unnest($2::uuid[])`,
        [data.id, data.modifierGroupIds],
      );
    }
    await client.query('COMMIT');
    return { ...toProduct(rows[0]), modifierGroupIds: data.modifierGroupIds };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// R30-C3: `organizationId` is REQUIRED. See pgUpdateCategory for the
// rationale — `organizationId?` fallbacks that ran queries without an
// org filter have been the source of silent cross-tenant writes
// historically. Every caller in src/app/admin/actions.ts passes the
// actor's orgId already.
export async function pgUpdateProduct(id: string, data: Partial<{
  name: string; slug: string; categoryId: string; description: string | null;
  imageUrl: string | null; isActive: boolean; isTouchFavorite: boolean; defaultVariantId: string | null;
}>, organizationId: string): Promise<Product | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
  if (data.slug !== undefined) { sets.push(`slug = $${i++}`); vals.push(data.slug); }
  if (data.categoryId !== undefined) { sets.push(`category_id = $${i++}`); vals.push(data.categoryId); }
  if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
  if (data.imageUrl !== undefined) { sets.push(`image_url = $${i++}`); vals.push(data.imageUrl); }
  if (data.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.isActive); }
  if (data.isTouchFavorite !== undefined) { sets.push(`is_touch_favorite = $${i++}`); vals.push(data.isTouchFavorite); }
  if (data.defaultVariantId !== undefined) { sets.push(`default_variant_id = $${i++}`); vals.push(data.defaultVariantId); }
  if (sets.length === 0) return null;
  sets.push(`updated_at = $${i++}`);
  vals.push(new Date().toISOString());
  vals.push(id);
  vals.push(organizationId);
  const { rows } = await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`, vals);
  if (!rows[0]) return null;
  // product_modifier_groups is FK-scoped through products; product_id
  // just verified in-org by the UPDATE above.
  // check-pool-org-filter: scoped-by-just-verified-product-org
  const mgRows = await pool.query('SELECT modifier_group_id FROM product_modifier_groups WHERE product_id = $1', [id]);
  return { ...toProduct(rows[0]), modifierGroupIds: mgRows.rows.map((r: Record<string, unknown>) => r.modifier_group_id as string) };
}

export async function pgDeleteProduct(id: string, organizationId: string): Promise<boolean> {
  // R30-C3: required organizationId — no more post-hoc orgId lookup
  // fallback. The DELETE is both correct AND protected.
  const { rowCount } = await pool.query(
    'DELETE FROM products WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  );
  invalidateProductsCache(organizationId);
  return (rowCount ?? 0) > 0;
}

// ── Variants ──────────────────────────────────────────────────────────

// NOTE: callers should be updated to pass ORG_ID (organizationId) from their request context.

export async function pgReadVariants(organizationId: string): Promise<ProductVariant[]> {
  const cached = _variantsCache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const { rows } = await pool.query(
    `SELECT id, organization_id, product_id, sku, barcode, name, size_label, color_label,
            price, compare_at_price, cost, is_active, created_at, updated_at
     FROM product_variants WHERE organization_id = $1 ORDER BY name`,
    [organizationId],
  );
  const data = rows.map(toVariant);
  _variantsCache.set(organizationId, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateVariantsCache(orgId?: string): void {
  if (orgId) {
    _variantsCache.delete(orgId);
    // Cascade into the full-store cache. Variant price/cost/active
    // changes need to reach the POS within seconds, not after 30s TTL.
    // R32-D2: scoped cascade.
    invalidateStoreCache(orgId);
  } else {
    _variantsCache.clear();
  }
}

export async function pgCreateVariant(data: {
  id: string; organizationId: string; productId: string; sku: string; barcode?: string;
  name: string; sizeLabel?: string; colorLabel?: string; price: number; cost?: number;
  compareAtPrice?: number; isActive: boolean;
}): Promise<ProductVariant> {
  const ts = new Date().toISOString();
  try {
    const { rows } = await pool.query(
      `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
      [data.id, data.organizationId, data.productId, data.sku, data.barcode ?? null, data.name, data.sizeLabel ?? null, data.colorLabel ?? null, data.price, data.compareAtPrice ?? null, data.cost ?? null, data.isActive, ts],
    );
    invalidateVariantsCache(data.organizationId);
    return toVariant(rows[0]);
  } catch (err) {
    // R22-M-1: migration 051 added partial unique indexes on
    // (organization_id, sku) and (organization_id, barcode) WHERE is_active.
    // R22-M-1 + R23-M-2: exact-match the known partial-unique index
    // names. Prior shape fell through to `field = "both"` on any
    // unmatched constraint (e.g., `product_variants_pkey` on a UUID
    // collision, or a future unique index added by a later migration),
    // producing misleading user-facing copy. If the constraint isn't
    // one of the two we own, re-throw so the caller sees the real
    // error with its actual constraint name in logs.
    const e = err as { code?: string; constraint?: string };
    if (e.code === "23505") {
      if (e.constraint === "uniq_product_variants_org_sku_active") {
        throw new VariantUniquenessConflictError("sku");
      }
      if (e.constraint === "uniq_product_variants_org_barcode_active") {
        throw new VariantUniquenessConflictError("barcode");
      }
      // Unknown unique constraint — surface the raw error for the log.
      // The admin action will catch it and render a generic 500; ops
      // can see the real constraint name in the structured log.
    }
    throw err;
  }
}

/**
 * R22-M-1: A distinct sentinel error so the edit UI can surface a
 * specific "SKU/barcode already used by another active variant" message
 * instead of leaking a raw `duplicate key value violates unique
 * constraint` 500. Thrown when the new `uniq_product_variants_org_*
 * _active` partial indexes from migration 051 collide on a
 * reactivation/rename path.
 */
export class VariantUniquenessConflictError extends Error {
  readonly code = "VARIANT_UNIQUENESS_CONFLICT";
  // R23-M-2: the "both" case was only reachable via the old
  // fall-through on unknown constraint names. Now that we exact-match
  // the two known constraints and re-throw everything else, the type
  // is strictly `"sku" | "barcode"`.
  constructor(public readonly field: "sku" | "barcode") {
    super(`Another active variant already uses this ${field}.`);
    this.name = "VariantUniquenessConflictError";
  }
}

// R30-C3: `organizationId` is REQUIRED. See pgUpdateCategory above.
export async function pgUpdateVariant(id: string, data: Partial<{
  name: string; sku: string; barcode: string | null; sizeLabel: string | null;
  colorLabel: string | null; price: number; compareAtPrice: number | null;
  cost: number | null; isActive: boolean;
}>, organizationId: string): Promise<ProductVariant | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
  if (data.sku !== undefined) { sets.push(`sku = $${i++}`); vals.push(data.sku); }
  if (data.barcode !== undefined) { sets.push(`barcode = $${i++}`); vals.push(data.barcode); }
  if (data.sizeLabel !== undefined) { sets.push(`size_label = $${i++}`); vals.push(data.sizeLabel); }
  if (data.colorLabel !== undefined) { sets.push(`color_label = $${i++}`); vals.push(data.colorLabel); }
  if (data.price !== undefined) { sets.push(`price = $${i++}`); vals.push(data.price); }
  if (data.compareAtPrice !== undefined) { sets.push(`compare_at_price = $${i++}`); vals.push(data.compareAtPrice); }
  if (data.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(data.cost); }
  if (data.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.isActive); }
  if (sets.length === 0) return null;
  sets.push(`updated_at = $${i++}`);
  vals.push(new Date().toISOString());
  vals.push(id);
  vals.push(organizationId);
  try {
    const { rows } = await pool.query(
      `UPDATE product_variants SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      vals,
    );
    invalidateVariantsCache(organizationId);
    return rows[0] ? toVariant(rows[0]) : null;
  } catch (err) {
    // R22-M-1: unique partial indexes from migration 051 fire 23505 on
    // rename/reactivate paths when another active variant now uses the
    // same SKU/barcode. Translate to a typed error so the UI can surface
    // actionable copy.
    // R22-M-1 + R23-M-2: exact-match the known partial-unique index
    // names. Prior shape fell through to `field = "both"` on any
    // unmatched constraint (e.g., `product_variants_pkey` on a UUID
    // collision, or a future unique index added by a later migration),
    // producing misleading user-facing copy. If the constraint isn't
    // one of the two we own, re-throw so the caller sees the real
    // error with its actual constraint name in logs.
    const e = err as { code?: string; constraint?: string };
    if (e.code === "23505") {
      if (e.constraint === "uniq_product_variants_org_sku_active") {
        throw new VariantUniquenessConflictError("sku");
      }
      if (e.constraint === "uniq_product_variants_org_barcode_active") {
        throw new VariantUniquenessConflictError("barcode");
      }
      // Unknown unique constraint — surface the raw error for the log.
      // The admin action will catch it and render a generic 500; ops
      // can see the real constraint name in the structured log.
    }
    throw err;
  }
}

export async function pgDeleteVariant(id: string, organizationId: string): Promise<boolean> {
  // R30-C3: required organizationId — no orgId lookup fallback.
  const { rowCount } = await pool.query(
    'DELETE FROM product_variants WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  );
  invalidateVariantsCache(organizationId);
  return (rowCount ?? 0) > 0;
}

// ── Inventory ─────────────────────────────────────────────────────────

// NOTE: callers should be updated to pass ORG_ID (organizationId) from their request context.

export async function pgReadInventory(organizationId: string, locationId?: string): Promise<InventoryLevel[]> {
  // When locationId is provided (e.g. POS terminal), only load that location's inventory
  // to avoid fetching and transmitting inventory for all locations.
  const cacheKey = locationId ? `${organizationId}:${locationId}` : organizationId;
  const cached = _inventoryCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const { rows } = locationId
    ? await pool.query(
        `SELECT id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at
         FROM inventory_levels WHERE organization_id = $1 AND location_id = $2`,
        [organizationId, locationId],
      )
    : await pool.query(
        `SELECT id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at
         FROM inventory_levels WHERE organization_id = $1`,
        [organizationId],
      );
  const data = rows.map(toInventory);
  _inventoryCache.set(cacheKey, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateInventoryCache(orgId?: string): void {
  if (orgId) {
    // Clear both org-level and location-specific cache keys (e.g. "orgId:locationId")
    for (const key of _inventoryCache.keys()) {
      if (key === orgId || key.startsWith(`${orgId}:`)) _inventoryCache.delete(key);
    }
  } else {
    _inventoryCache.clear();
  }
}

export async function pgCreateInventoryLevel(data: {
  id: string; organizationId: string; locationId: string; productVariantId: string;
  onHand: number; reserved: number; reorderPoint: number;
}): Promise<InventoryLevel> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO inventory_levels (id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [data.id, data.organizationId, data.locationId, data.productVariantId, data.onHand, data.reserved, data.reorderPoint, ts],
  );
  return toInventory(rows[0]);
}

export async function pgAdjustInventory(inventoryLevelId: string, delta: number, employeeId: string, reason: string, organizationId: string): Promise<{ level: InventoryLevel; adjustment: InventoryAdjustmentRecord }> {
  // Cross-tenant guard: the inventory level's organization_id MUST match
  // the caller's verified organization. Previously we derived the org from
  // the inventory row itself and trusted it — which meant any admin could
  // submit an inventoryLevelId from another tenant and mutate their stock.
  // We now require the caller to pass their verified org (from session
  // context) and refuse to operate if the ids don't match.
  const { rows: invCheckRows } = await pool.query(
    'SELECT organization_id FROM inventory_levels WHERE id = $1 AND organization_id = $2',
    [inventoryLevelId, organizationId],
  );
  if (!invCheckRows[0]) throw new Error('Inventory level not found');

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    // Lock first so we can compute the actual applied delta (the requested
    // delta may be clamped by GREATEST(0, ...) if it would drive on_hand
    // below zero). Recording the pre-clamp delta would produce audit rows
    // whose math doesn't add up (R10-H-5).
    // R26-F1: defense-in-depth explicit org filter. The pre-check
    // above already proved the row belongs to `organizationId`, but
    // including it here eliminates the sole remaining window (a
    // concurrent transfer of the row to another tenant — not
    // possible today, but cheap insurance).
    const { rows: lockedRows } = await client.query(
      `SELECT on_hand FROM inventory_levels
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [inventoryLevelId, organizationId],
    );
    if (!lockedRows[0]) throw new Error('Inventory row not found');
    const priorOnHand = Number(lockedRows[0].on_hand) || 0;
    const newOnHand = Math.max(0, priorOnHand + delta);
    const appliedDelta = newOnHand - priorOnHand;

    const { rows: invRows } = await client.query(
      `UPDATE inventory_levels SET on_hand = $1, updated_at = $2
       WHERE id = $3 AND organization_id = $4 RETURNING *`,
      [newOnHand, ts, inventoryLevelId, organizationId],
    );
    if (!invRows[0]) throw new Error('Inventory row not found');
    const level = toInventory(invRows[0]);

    const adjId = crypto.randomUUID();
    // Schema: inventory_adjustments(id, inventory_level_id, product_variant_id,
    // location_id, employee_id, reason, delta, resulting_on_hand, created_at).
    // R32-D6: `organization_id` was added in migration 063 —
    // previously tenancy derived via location_id JOIN in RLS. Every
    // INSERT now carries the caller's verified org explicitly.
    // Column names are `reason` and `delta`, not `reason_code`/`quantity_delta`.
    // The pre-R11 version used all three wrong column names and would 500
    // on every admin inventory-adjust form submission (R11-C-2).
    await client.query(
      `INSERT INTO inventory_adjustments (id, organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [adjId, organizationId, inventoryLevelId, level.productVariantId, level.locationId, employeeId, reason, appliedDelta, newOnHand, ts],
    );

    await client.query('COMMIT');
    // Invalidate the full-store cache so POS terminals see the on_hand
    // change before the 30s TTL expires (R10-H-3).
    invalidateStoreCache(organizationId);
    const adjustment: InventoryAdjustmentRecord = {
      id: adjId, inventoryLevelId, productVariantId: level.productVariantId,
      locationId: level.locationId, employeeId, reason, delta: appliedDelta,
      resultingOnHand: level.onHand, createdAt: ts,
    };
    return { level, adjustment };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Employees ─────────────────────────────────────────────────────────

export async function pgReadEmployees(organizationId: string): Promise<Employee[]> {
  const cached = _employeesCache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const { rows } = await pool.query(
    `SELECT id, organization_id, role_key, first_name, last_name, display_name, email,
            pin_hint, is_active, location_ids, created_at, updated_at
     FROM employees WHERE organization_id = $1 ORDER BY last_name`,
    [organizationId],
  );
  const data = rows.map(toEmployee);
  _employeesCache.set(organizationId, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateEmployeesCache(orgId?: string): void {
  if (orgId) {
    _employeesCache.delete(orgId);
    invalidateStoreCache(orgId);
  } else {
    _employeesCache.clear();
  }
}

export async function pgCreateEmployee(data: {
  id: string; organizationId: string; roleKey: string; firstName: string; lastName: string;
  displayName: string; email?: string; pinHash: string; passwordHash?: string; pinHint: string;
  isActive: boolean; locationIds: string[];
}): Promise<Employee> {
  const client = await orgTx(data.organizationId);
  const ts = new Date().toISOString();
  try {
    const { rows } = await client.query(
      `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $11) RETURNING *`,
      [data.id, data.organizationId, data.roleKey, data.firstName, data.lastName, data.displayName, data.email ?? null, data.pinHint, data.isActive, data.locationIds, ts],
    );
    // check-pool-org-filter: scoped-by-just-created-employee
    // employee_id was just INSERTed above into this org. auth_credentials
    // has no organization_id column (tenancy derives through employees FK).
    await client.query(
      `INSERT INTO auth_credentials (employee_id, email, password_hash, pin_hash, pin_last_rotated_at, failed_pin_attempts, last_failed_pin_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, $5, $5)`,
      [data.id, data.email ?? null, data.passwordHash ?? null, data.pinHash, ts],
    );
    await client.query('COMMIT');
    invalidateEmployeesCache(data.organizationId);
    return toEmployee(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgToggleEmployee(id: string, organizationId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row so concurrent toggle attempts are serialised AND refuse
    // the update if the target employee doesn't belong to the caller's org.
    // Without the org filter a manager at ORG A could toggle employees at
    // ORG B (denial-of-service via account lockout).
    const { rows: employeeRows } = await client.query(
      `SELECT id, organization_id FROM employees WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, organizationId],
    );
    if (employeeRows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const { rowCount } = await client.query(
      `UPDATE employees SET is_active = NOT is_active, updated_at = $1 WHERE id = $2 AND organization_id = $3`,
      [new Date().toISOString(), id, organizationId],
    );
    await client.query('COMMIT');
    invalidateEmployeesCache(organizationId);
    return (rowCount ?? 0) > 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ISO-LOW3: organizationId is REQUIRED. Prior shape kept an optional
// fallback for "auth-lookup callers that don't yet know the org" but
// every actual auth-lookup goes through inline `pool.query` in
// session.ts (which carries its own scoped-by-session-auth-lookup
// suppression comment). The optional branch had zero live callers in
// production code — only a stale comment reference at admin/actions.ts:
// 774. Removing it eliminates a footgun for any future caller that
// might forget the orgId.
export async function pgReadEmployeeById(id: string, organizationId: string): Promise<Employee | null> {
  const { rows } = await pool.query(
    `SELECT * FROM employees WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

// ── Auth credential helpers ───────────────────────────────────────────

export async function pgFindCredentialByEmail(email: string): Promise<(AuthCredentialRecord & { passwordHash?: string }) | null> {
  // Pre-auth login lookup — caller can't prove org yet, so tenancy is
  // resolved by email (unique index on lower(email), migration 051).
  // check-pool-org-filter: scoped-by-email-global-unique
  const { rows } = await pool.query(
    `SELECT ac.employee_id, ac.email, ac.password_hash, ac.pin_hash, ac.pin_last_rotated_at
     FROM auth_credentials ac JOIN employees e ON ac.employee_id = e.id
     WHERE LOWER(ac.email) = LOWER($1) AND e.is_active = true`,
    [email],
  );
  if (!rows[0]) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    employeeId: r.employee_id as string,
    email: (r.email as string) ?? undefined,
    passwordHash: (r.password_hash as string) ?? undefined,
    pinHash: (r.pin_hash as string) ?? undefined,
    pinLastRotatedAt: r.pin_last_rotated_at ? String(r.pin_last_rotated_at) : undefined,
  };
}

export async function pgFindCredentialByPin(pin: string, orgId?: string): Promise<AuthCredentialRecord | null> {
  // Compute SHA-256 prefix of the raw PIN for fast pre-filtering via indexed column.
  // This narrows candidates from N employees to typically 1 before running expensive scrypt.
  let pinPrefix: string | null = null;
  try {
    const { createHash } = await import("node:crypto");
    pinPrefix = createHash("sha256").update(pin).digest("hex").slice(0, 8);
  } catch {
    // Fallback: no prefix filtering (scan all employees)
  }

  // Fetch pin_hash rows scoped to org with current failed-attempt state.
  // NB: `pin_hash_prefix` was added by migration 017 as an index-friendly
  // fast-path filter, but no code path writes it on INSERT/UPDATE, so
  // existing rows have pin_hash_prefix IS NULL. Apply the filter as
  // `(prefix = $N OR prefix IS NULL)` so we match both backfilled rows and
  // legacy rows. Once a row matches and the real scrypt verify passes, the
  // caller can optionally backfill on next password/PIN rotation.
  const prefixFilter = pinPrefix
    ? ` AND (ac.pin_hash_prefix = $${orgId ? '2' : '1'} OR ac.pin_hash_prefix IS NULL)`
    : '';
  const params: unknown[] = orgId ? [orgId] : [];
  if (pinPrefix) params.push(pinPrefix);

  const { rows } = await pool.query(
    `SELECT ac.employee_id, ac.email, ac.pin_hash, ac.pin_last_rotated_at,
            ac.failed_pin_attempts, ac.last_failed_pin_at
     FROM auth_credentials ac
     JOIN employees e ON ac.employee_id = e.id
     WHERE e.is_active = true AND ac.pin_hash IS NOT NULL
       ${orgId ? 'AND e.organization_id = $1' : ''}${prefixFilter}`,
    params,
  );

  // Verify PINs serially with early exit.
  //
  // R15-M-1: previously fanned N concurrent scrypt verifies via
  // `Promise.all`. Under N=50 employees that burned ~2.5-5s CPU per
  // attempt — a DoS vector.
  //
  // R16-M-3 + R17-INFO-1: this function is a scan-all-candidates-for-PIN
  // lookup (used by approval-action). Per-employee `failed_pin_attempts`
  // semantics don't apply here — neither the previous incrementing nor
  // the lockout read made sense in a scan context, and in fact no path
  // in the repo writes `failed_pin_attempts` so the lockout read was
  // dead defense that falsely suggested protection. Brute-force defense
  // for scan paths lives at the CALLER level
  // (`checkRateLimit("approval:...")`). Dropped both here.
  let match: Record<string, unknown> | null = null;
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    if (!row.pin_hash) continue;
    if (await verifySecretAsync(pin, row.pin_hash as string)) {
      match = row;
      break;
    }
  }

  if (!match) return null;
  return {
    employeeId: match.employee_id as string,
    email: (match.email as string) ?? undefined,
    pinHash: (match.pin_hash as string) ?? undefined,
    pinLastRotatedAt: match.pin_last_rotated_at ? String(match.pin_last_rotated_at) : undefined,
  };
}

/** Verify PIN/secret using the same PBKDF2 algorithm as hashSecret in crypto.ts. */
async function verifySecretAsync(secret: string, encoded: string): Promise<boolean> {
  const { verifySecret } = await import("@/lib/auth/crypto");
  return verifySecret(secret, encoded);
}

// ── Customers ─────────────────────────────────────────────────────────
//
// Moved from postgres-phase2.ts (R8-H-10) — that file was ~896 lines of
// dead code that shipped in the Workers bundle, and its helpers duplicated
// RLS-bypass logic we've since centralized in orgTx. Only `pgCreateCustomer`
// was actually imported anywhere in the app.

function toCustomerRow(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    email: (r.email as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    loyaltyPoints: Number(r.loyalty_points),
    totalSpend: Number(r.total_spend),
    visitCount: Number(r.visit_count),
    storeCreditBalance: Number(r.store_credit_balance ?? 0),
    notes: (r.notes as string) ?? undefined,
    taxExempt: (r.tax_exempt as boolean) ?? false,
    isActive: r.is_active as boolean,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function pgCreateCustomer(data: {
  id: string; organizationId: string; firstName: string; lastName: string;
  email?: string; phone?: string; notes?: string;
}): Promise<Customer> {
  const ts = new Date().toISOString();
  // Explicit column list on RETURNING — never echo `notes` back to the
  // caller (staff-only field per round 5 H-4 fix on the REST route).
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id, organization_id, first_name, last_name, email, phone,
                 loyalty_points, total_spend, visit_count, store_credit_balance,
                 tax_exempt, is_active, created_at, updated_at`,
      [data.id, data.organizationId, data.firstName, data.lastName, data.email ?? null, data.phone ?? null, data.notes ?? null, ts],
    );
    return toCustomerRow(rows[0]);
  } catch (e) {
    // R74-I: the (organization_id, LOWER(email)) unique index on
    // customers (migration 005) fires 23505 when two customers in
    // the same org share an email. Prior shape let this bubble as a
    // raw pg error — callers (register-side quick-create, etc) had
    // to parse the driver error string to distinguish a duplicate
    // email from a real DB failure. Throw a typed, actionable error
    // that UIs can map to a 409 / field error. Mirrors the REST
    // POST + PUT 23505 handlers from R74-C.
    const err = e as { code?: string };
    if (err?.code === "23505") {
      const typed = new Error("A customer with this email already exists in your organization.");
      (typed as Error & { code?: string }).code = "23505";
      throw typed;
    }
    throw e;
  }
}

// ── Audit events ──────────────────────────────────────────────────────

export async function pgInsertAuditEvent(
  orgId: string, locationId: string | null, employeeId: string | null,
  entityType: string, entityId: string | null, eventKind: string, payload: Record<string, unknown> = {},
) {
  try {
    // Route through orgTx so `app.current_org_id` is set and the WITH CHECK
    // policy on audit_events can validate the row. Using pool.query() alone
    // bypasses RLS (postgres role has BYPASSRLS), which means a caller-bug
    // that passes the wrong orgId writes an audit row into the wrong tenant
    // with no database-level check. Also keeps us on the per-call Pool
    // facade for Workers' "one websocket per request" constraint.
    const { orgTx } = await import("@/lib/supabase-rest");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, locationId, employeeId, entityType, entityId, eventKind, JSON.stringify(payload)],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    // R21-H-2: wrap err with safeErr so the structured audit-failure log
    // doesn't leak query text / bound parameters.
    // R25-ops-M-1: structured JSON so Logpush/log-based alerts can
    // fire on `event = "audit_insert_failed"`. Audit-trail drops are
    // a compliance event — we want an alert within minutes, not a
    // grep through the next quarterly log review. The outer wrapping
    // `try/catch` still swallows (audit failure must not crash the
    // request), but the emission is noisy + queryable.
    console.error(JSON.stringify({
      level: "error",
      at: new Date().toISOString(),
      event: "audit_insert_failed",
      orgId, entityType, entityId, eventKind,
      error: safeErr(err),
    }));
  }
}

// ── Organization ──────────────────────────────────────────────────────

// `organizationId` is both the row id AND the tenancy scope for the
// organizations table — they're the same value. Naming the param
// organizationId (not just `id`) satisfies the pg-helpers-require-org
// lint rule AND makes the intent explicit to callers.
export async function pgUpdateOrganization(organizationId: string, data: Partial<{
  name: string; legalName: string; phone: string; email: string; website: string;
  receiptHeader: string; receiptFooter: string;
}>) {
  const map: Record<string, string> = {
    name: 'name', legalName: 'legal_name', phone: 'phone', email: 'email',
    website: 'website', receiptHeader: 'receipt_header', receiptFooter: 'receipt_footer',
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    const v = data[key as keyof typeof data];
    if (v !== undefined) { sets.push(`${col} = $${i++}`); vals.push(v); }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${i++}`); vals.push(new Date().toISOString());
  vals.push(organizationId);
  // The `organizations` table itself has no `organization_id` column
  // (it's the root of the tenancy tree); `id = organizationId` IS the
  // tenant scope here.
  // check-pool-org-filter: scoped-by-id-is-org-id-on-organizations-table
  await pool.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
}

export async function pgReadLocations(organizationId?: string) {
  if (!organizationId) {
    throw new Error("pgReadLocations requires explicit organizationId");
  }
  const cached = _locationsCache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  // Column name is `address1` (no underscore). Querying `address_1` 500'd
  // the /api/clock-in-data endpoint, producing empty location/employee
  // dropdowns in the admin clock-in page.
  const { rows } = await pool.query(
    `SELECT id, organization_id, name, code, address1, city, region, postal_code, phone,
            tax_rate, is_active, created_at, updated_at
     FROM locations WHERE organization_id = $1 AND is_active = true ORDER BY name`,
    [organizationId],
  );
  const data = rows.map((r: Record<string, unknown>) => ({
    id: r.id as string, organizationId: r.organization_id as string,
    name: r.name as string, code: r.code as string,
    address1: r.address1 as string, city: r.city as string,
    region: r.region as string, postalCode: r.postal_code as string,
    phone: (r.phone as string) ?? '',
    taxRate: Number(r.tax_rate ?? 0.1025),
    isActive: r.is_active as boolean,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
  _locationsCache.set(organizationId, { data, expiresAt: Date.now() + PG_READ_TTL_MS });
  return data;
}

export function invalidateLocationsCache(orgId?: string): void {
  if (orgId) {
    _locationsCache.delete(orgId);
    invalidateStoreCache(orgId);
  } else {
    _locationsCache.clear();
  }
}

// R30-C3: `organizationId` is REQUIRED. Same rationale as
// pgUpdateCategory — the `organizationId?` optional branch ran a
// WHERE-id-only UPDATE that could hit any tenant's location row.
export async function pgUpdateLocation(id: string, data: Partial<{
  name: string; address1: string; city: string; region: string;
  postalCode: string; phone: string; taxRate: number;
}>, organizationId: string) {
  // Column name is `address1` in the locations schema, not `address_1`.
  // `pgReadLocations` has a comment warning about this; pgUpdateLocation
  // had the bug anyway — any updateLocationAction call carrying an
  // address1 field 500s with `column "address_1" does not exist`.
  const map: Record<string, string> = {
    name: 'name', address1: 'address1', city: 'city', region: 'region',
    postalCode: 'postal_code', phone: 'phone', taxRate: 'tax_rate',
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    const v = data[key as keyof typeof data];
    if (v !== undefined) { sets.push(`${col} = $${i++}`); vals.push(v); }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${i++}`); vals.push(new Date().toISOString());
  vals.push(id);
  vals.push(organizationId);
  await pool.query(`UPDATE locations SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`, vals);
  invalidateLocationsCache(organizationId);
}

// ── Register Sessions ─────────────────────────────────────────────────

function toRegisterSession(r: Record<string, unknown>): RegisterSessionRecord {
  return {
    id: r.id as string,
    authSessionId: r.auth_session_id as string,
    employeeId: r.employee_id as string,
    locationId: r.location_id as string,
    status: r.status as 'active' | 'ended',
    startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
    activeShiftId: (r.active_shift_id as string) ?? undefined,
    lastCartId: (r.last_cart_id as string) ?? undefined,
    lastTransactionId: (r.last_transaction_id as string) ?? undefined,
    pendingExceptionIds: (r.pending_exception_ids as string[]) ?? [],
  };
}

function toShift(r: Record<string, unknown>): ShiftRecord {
  return {
    id: r.id as string,
    locationId: r.location_id as string,
    employeeId: r.employee_id as string,
    registerSessionId: r.register_session_id as string,
    status: r.status as 'open' | 'closed',
    openedAt: String(r.opened_at),
    openingFloat: Number(r.opening_float),
    openedNote: (r.opened_note as string) ?? undefined,
    closedAt: r.closed_at ? String(r.closed_at) : undefined,
    closingExpectedCash: r.closing_expected_cash != null ? Number(r.closing_expected_cash) : undefined,
    closingDeclaredCash: r.closing_declared_cash != null ? Number(r.closing_declared_cash) : undefined,
    closingVariance: r.closing_variance != null ? Number(r.closing_variance) : undefined,
    closedNote: (r.closed_note as string) ?? undefined,
  };
}

// pgCreateRegisterSession was removed as dead code — register session
// creation goes through the `register_login_create_session` RPC (see
// src/app/api/auth/register-login/route.ts). No caller depended on this
// helper; keeping it invited someone to wire a new route up to a helper
// that doesn't accept an organizationId for cross-tenant scope.

export async function pgFindActiveRegisterSession(authSessionId: string): Promise<RegisterSessionRecord | null> {
  // authSessionId comes from the validated HttpOnly session cookie —
  // server-minted random UUID that IS the tenancy proof. Caller then
  // cross-checks the returned employee_id/location_id against the org.
  // check-pool-org-filter: scoped-by-session-cookie
  const { rows } = await pool.query(
    `SELECT id, auth_session_id, employee_id, location_id, status, started_at, ended_at,
            active_shift_id, last_cart_id, last_transaction_id, pending_exception_ids,
            created_at, updated_at
     FROM register_sessions
     WHERE auth_session_id = $1 AND status = 'active' LIMIT 1`,
    [authSessionId],
  );
  return rows[0] ? toRegisterSession(rows[0]) : null;
}

// pgEndRegisterSession removed as dead code — sign-out goes through the
// `register_sign_out` RPC (see /api/auth/logout paths). Any future caller
// should use a helper that takes organizationId so the UPDATE is
// scoped cross-tenant-safely.

export async function pgOpenShift(data: {
  id: string; organizationId: string; locationId: string; employeeId: string; registerSessionId: string | null;
  openingFloat: number; openedNote?: string; idempotencyKey?: string | null;
}): Promise<ShiftRecord> {
  const client = await orgTx(data.organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows: existingShiftRows } = await client.query(
      `SELECT id
       FROM shifts
       WHERE organization_id = $1 AND employee_id = $2 AND status = 'open'
       FOR UPDATE`,
      [data.organizationId, data.employeeId],
    );
    if (existingShiftRows.length > 0) {
      throw new Error('Employee already has an open shift');
    }

    const { rows } = await client.query(
      `INSERT INTO shifts (id, organization_id, location_id, employee_id, register_session_id, status, opened_at, opening_float, opened_note, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9) RETURNING *`,
      [data.id, data.organizationId, data.locationId, data.employeeId, data.registerSessionId, ts, data.openingFloat, data.openedNote ?? null, data.idempotencyKey ?? null],
    );
    // Only update register_sessions if a register session is provided (admin-initiated shifts have none)
    if (data.registerSessionId) {
      await client.query(`SELECT id FROM register_sessions WHERE id = $1 FOR UPDATE`, [data.registerSessionId]);
      await client.query(
        `UPDATE register_sessions SET active_shift_id = $1 WHERE id = $2`,
        [data.id, data.registerSessionId],
      );
    }
    await client.query('COMMIT');
    return toShift(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgCloseShift(shiftId: string, registerSessionId: string, data: {
  closingExpectedCash: number; closingDeclaredCash: number; closedNote?: string;
}, organizationId: string): Promise<ShiftRecord> {
  // Cross-tenant guard (R11-M-4): require the caller to pass their verified
  // org and refuse to operate if the shift's org doesn't match. The pre-R11
  // code self-determined the org from the shift row itself, which is the
  // same anti-pattern round 6 closed on `pgAdjustInventory`/`pgToggleEmployee`.
  // Now any caller must pass ctx.orgId; the UPDATE also filters by org.
  const { rows: shiftRows } = await pool.query(
    `SELECT l.organization_id FROM shifts s JOIN locations l ON s.location_id = l.id
     WHERE s.id = $1 AND l.organization_id = $2`,
    [shiftId, organizationId],
  );
  if (!shiftRows[0]) throw new Error('Shift not found in this organization');

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const variance = Number((data.closingDeclaredCash - data.closingExpectedCash).toFixed(2));
    const { rows } = await client.query(
      `UPDATE shifts SET status = 'closed', closed_at = $1, closing_expected_cash = $2,
       closing_declared_cash = $3, closing_variance = $4, closed_note = $5
       WHERE id = $6 AND organization_id = $7 AND status = 'open' RETURNING *`,
      [ts, data.closingExpectedCash, data.closingDeclaredCash, variance, data.closedNote ?? null, shiftId, organizationId],
    );
    if (!rows[0]) throw new Error('Shift not found or already closed');
    await client.query(
      `UPDATE register_sessions SET active_shift_id = NULL WHERE id = $1`,
      [registerSessionId],
    );
    await client.query('COMMIT');
    return toShift(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// R26-F1: `pgFindOpenShift` + `pgGetCashDrawerBalance` removed as dead
// code — zero callers across src/. Both took a single id (shift id /
// register_session_id) without an organization_id filter. In the
// BYPASSRLS-postgres-role world (see check-rls-force-matching.mjs
// banner) that would have been a cross-tenant read surface if any
// caller had ever passed an id from the wrong tenant. The earlier
// `pgAutoCloseShift` removal note from R6 applies to these too: add
// back with mandatory organizationId param if needed.
