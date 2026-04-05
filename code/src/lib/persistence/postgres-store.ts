import 'server-only';
import pool, { orgTx } from '@/lib/db';
import type { Category, Employee, InventoryLevel, Product, ProductVariant, RegisterSessionRecord, ShiftRecord } from '@/lib/domain/types';
import type { AuthCredentialRecord, InventoryAdjustmentRecord } from '@/lib/persistence/types';

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
let _locationsCache: CacheEntry<import('@/lib/domain/types').Location[]> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _orgCache: CacheEntry<any> | null = null;
let _categoriesCache: CacheEntry<Category[]> | null = null;

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

export async function pgReadCategories(): Promise<Category[]> {
  if (_categoriesCache && Date.now() < _categoriesCache.expiresAt) return _categoriesCache.data;
  const { rows } = await pool.query(
    `SELECT id, organization_id, name, slug, parent_category_id, sort_order, image_url, created_at, updated_at
     FROM categories ORDER BY sort_order`,
  );
  const data = rows.map(toCategory);
  _categoriesCache = { data, expiresAt: Date.now() + PG_READ_TTL_MS };
  return data;
}

export function invalidateCategoriesCache(): void { _categoriesCache = null; }

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

export async function pgUpdateCategory(id: string, data: Partial<{ name: string; slug: string; sortOrder: number; imageUrl: string | null }>): Promise<Category | null> {
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
  const { rows } = await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return rows[0] ? toCategory(rows[0]) : null;
}

export async function pgDeleteCategory(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [id]);
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
  if (orgId) _productsCache.delete(orgId);
  else _productsCache.clear();
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
    for (const mgId of data.modifierGroupIds) {
      await client.query('INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1, $2)', [data.id, mgId]);
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

export async function pgUpdateProduct(id: string, data: Partial<{
  name: string; slug: string; categoryId: string; description: string | null;
  imageUrl: string | null; isActive: boolean; isTouchFavorite: boolean; defaultVariantId: string | null;
}>): Promise<Product | null> {
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
  const { rows } = await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  if (!rows[0]) return null;
  const mgRows = await pool.query('SELECT modifier_group_id FROM product_modifier_groups WHERE product_id = $1', [id]);
  return { ...toProduct(rows[0]), modifierGroupIds: mgRows.rows.map((r: Record<string, unknown>) => r.modifier_group_id as string) };
}

export async function pgDeleteProduct(id: string): Promise<boolean> {
  // Look up orgId before delete for cache invalidation
  const [productRow] = await pool.query<{ organization_id: string }>('SELECT organization_id FROM products WHERE id = $1', [id]).then(r => r.rows);
  const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
  if (productRow) invalidateProductsCache(productRow.organization_id);
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
  if (orgId) _variantsCache.delete(orgId);
  else _variantsCache.clear();
}

export async function pgCreateVariant(data: {
  id: string; organizationId: string; productId: string; sku: string; barcode?: string;
  name: string; sizeLabel?: string; colorLabel?: string; price: number; cost?: number;
  compareAtPrice?: number; isActive: boolean;
}): Promise<ProductVariant> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
    [data.id, data.organizationId, data.productId, data.sku, data.barcode ?? null, data.name, data.sizeLabel ?? null, data.colorLabel ?? null, data.price, data.compareAtPrice ?? null, data.cost ?? null, data.isActive, ts],
  );
  invalidateVariantsCache(data.organizationId);
  return toVariant(rows[0]);
}

export async function pgUpdateVariant(id: string, data: Partial<{
  name: string; sku: string; barcode: string | null; sizeLabel: string | null;
  colorLabel: string | null; price: number; compareAtPrice: number | null;
  cost: number | null; isActive: boolean;
}>): Promise<ProductVariant | null> {
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
  // Look up orgId for cache invalidation before the update
  const [variantRow] = await pool.query<{ organization_id: string }>('SELECT organization_id FROM product_variants WHERE id = $1', [id]).then(r => r.rows);
  const { rows } = await pool.query(`UPDATE product_variants SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  if (variantRow) invalidateVariantsCache(variantRow.organization_id);
  return rows[0] ? toVariant(rows[0]) : null;
}

export async function pgDeleteVariant(id: string): Promise<boolean> {
  // Look up orgId before delete for cache invalidation
  const [variantRow] = await pool.query<{ organization_id: string }>('SELECT organization_id FROM product_variants WHERE id = $1', [id]).then(r => r.rows);
  const { rowCount } = await pool.query('DELETE FROM product_variants WHERE id = $1', [id]);
  if (variantRow) invalidateVariantsCache(variantRow.organization_id);
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
  if (orgId) _inventoryCache.delete(orgId);
  else _inventoryCache.clear();
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

export async function pgAdjustInventory(inventoryLevelId: string, delta: number, employeeId: string, reason: string): Promise<{ level: InventoryLevel; adjustment: InventoryAdjustmentRecord }> {
  // Get organizationId from inventory level first
  const { rows: invCheckRows } = await pool.query(
    'SELECT organization_id FROM inventory_levels WHERE id = $1',
    [inventoryLevelId],
  );
  if (!invCheckRows[0]) throw new Error('Inventory level not found');
  const organizationId = invCheckRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows: invRows } = await client.query(
      `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand + $1), updated_at = $2 WHERE id = $3 RETURNING *`,
      [delta, ts, inventoryLevelId],
    );
    if (!invRows[0]) throw new Error('Inventory row not found');
    const level = toInventory(invRows[0]);

    const adjId = crypto.randomUUID();
    await client.query(
      `INSERT INTO inventory_adjustments (id, organization_id, location_id, product_variant_id, employee_id, quantity_delta, reason_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [adjId, level.organizationId, level.locationId, level.productVariantId, employeeId, delta, reason, ts],
    );

    await client.query('COMMIT');
    const adjustment: InventoryAdjustmentRecord = {
      id: adjId, inventoryLevelId, productVariantId: level.productVariantId,
      locationId: level.locationId, employeeId, reason, delta, resultingOnHand: level.onHand, createdAt: ts,
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
  if (orgId) _employeesCache.delete(orgId);
  else _employeesCache.clear();
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
    await client.query(
      `INSERT INTO auth_credentials (employee_id, email, password_hash, pin_hash, pin_last_rotated_at, failed_pin_attempts, last_failed_pin_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, $5, $5)`,
      [data.id, data.email ?? null, data.passwordHash ?? null, data.pinHash, ts],
    );
    await client.query('COMMIT');
    return toEmployee(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgToggleEmployee(id: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row so concurrent toggle attempts are serialised.
    await client.query(`SELECT id FROM employees WHERE id = $1 FOR UPDATE`, [id]);
    const { rowCount } = await client.query(
      `UPDATE employees SET is_active = NOT is_active, updated_at = $1 WHERE id = $2`,
      [new Date().toISOString(), id],
    );
    await client.query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadEmployeeById(id: string): Promise<Employee | null> {
  const { rows } = await pool.query(
    `SELECT * FROM employees WHERE id = $1`,
    [id],
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

// ── Auth credential helpers ───────────────────────────────────────────

export async function pgFindCredentialByEmail(email: string): Promise<(AuthCredentialRecord & { passwordHash?: string }) | null> {
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

export async function pgFindCredentialByPin(pin: string): Promise<AuthCredentialRecord | null> {
  const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const RATE_LIMIT_MAX_ATTEMPTS = 5;

  // Fetch all pin_hash rows with current failed-attempt state.
  // crypto.scrypt runs in the Node.js thread pool (not on the Workers main thread),
  // so parallel verification across all employees doesn't block the event loop.
  const { rows } = await pool.query(
    `SELECT ac.employee_id, ac.email, ac.pin_hash, ac.pin_last_rotated_at,
            ac.failed_pin_attempts, ac.last_failed_pin_at
     FROM auth_credentials ac
     JOIN employees e ON ac.employee_id = e.id
     WHERE e.is_active = true AND ac.pin_hash IS NOT NULL
     LIMIT 20`,
  );

  // Verify all PINs in parallel — each scrypt call runs in the thread pool.
  // Per-employee rate limiting: check BEFORE incrementing to avoid incrementing
  // locked accounts. If a specific employee is already locked (>=5 attempts within
  // 15 min), reject only that employee — other employees are unaffected.
  const results = await Promise.all(
    rows.map(async (r) => {
      const row = r as Record<string, unknown>;
      if (!row.pin_hash) return null;

      const employeeId = row.employee_id as string;
      const prevAttempts = (row.failed_pin_attempts as number) ?? 0;
      const lastAttempt = row.last_failed_pin_at as Date | null;
      const now = Date.now();

      // Check per-employee rate limit BEFORE incrementing.
      // If this specific employee has >=5 failed attempts within the window,
      // reject only this employee (not all candidates).
      if (
        prevAttempts >= RATE_LIMIT_MAX_ATTEMPTS &&
        lastAttempt &&
        now - new Date(lastAttempt).getTime() < RATE_LIMIT_WINDOW_MS
      ) {
        return null;
      }

      // Not locked — increment the counter first (sets the provisional count).
      await pool.query(
        `UPDATE auth_credentials
           SET failed_pin_attempts = failed_pin_attempts + 1,
               last_failed_pin_at = NOW()
           WHERE employee_id = $1`,
        [employeeId],
      );

      const valid = await verifySecretAsync(pin, row.pin_hash as string);

      if (valid) {
        await pool.query(
          `UPDATE auth_credentials SET failed_pin_attempts = 0, last_failed_pin_at = NULL
           WHERE employee_id = $1`,
          [employeeId],
        );
        return row;
      }

      // Failed: counter is already incremented above; leave it there.
      return null;
    }),
  );

  const match = results.find((r) => r !== null);
  if (!match) return null;
  return {
    employeeId: match.employee_id as string,
    email: (match.email as string) ?? undefined,
    pinHash: (match.pin_hash as string) ?? undefined,
    pinLastRotatedAt: match.pin_last_rotated_at ? String(match.pin_last_rotated_at) : undefined,
  };
}

/** Async scrypt verify — runs in Node.js thread pool, does not block the Workers main thread. */
async function verifySecretAsync(secret: string, encoded: string): Promise<boolean> {
  const { scrypt, timingSafeEqual } = await import("node:crypto");
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return false;
  const KEY_LENGTH = 64;
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(secret, salt, KEY_LENGTH, (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      });
    });
    return timingSafeEqual(derived, Buffer.from(stored, "hex"));
  } catch {
    return false;
  }
}

// ── Audit events ──────────────────────────────────────────────────────

export async function pgInsertAuditEvent(
  orgId: string, locationId: string | null, employeeId: string | null,
  entityType: string, entityId: string | null, eventKind: string, payload: Record<string, unknown> = {},
) {
  try {
    await pool.query(
      `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, locationId, employeeId, entityType, entityId, eventKind, JSON.stringify(payload)],
    );
  } catch (err) {
    console.error('[pgInsertAuditEvent] failed:', err);
  }
}

// ── Organization ──────────────────────────────────────────────────────

export async function pgReadOrganization() {
  const { rows } = await pool.query(
    `SELECT id, name, slug, legal_name, timezone, currency_code, phone, email, website,
            receipt_header, receipt_footer, created_at, updated_at
     FROM organizations LIMIT 1`,
  );
  if (!rows[0]) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: r.id as string, name: r.name as string, slug: r.slug as string,
    legalName: r.legal_name as string, timezone: r.timezone as string,
    currencyCode: r.currency_code as string,
    phone: (r.phone as string) ?? '', email: (r.email as string) ?? '',
    website: (r.website as string) ?? '',
    receiptHeader: (r.receipt_header as string) ?? '',
    receiptFooter: (r.receipt_footer as string) ?? 'Thank you for shopping with us!',
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export async function pgUpdateOrganization(id: string, data: Partial<{
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
  vals.push(id);
  await pool.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
}

export async function pgReadLocations() {
  if (_locationsCache && Date.now() < _locationsCache.expiresAt) return _locationsCache.data;
  const { rows } = await pool.query(
    `SELECT id, organization_id, name, code, address_1, city, region, postal_code, phone,
            tax_rate, is_active, created_at, updated_at
     FROM locations WHERE is_active = true ORDER BY name`,
  );
  const data = rows.map((r: Record<string, unknown>) => ({
    id: r.id as string, organizationId: r.organization_id as string,
    name: r.name as string, code: r.code as string,
    address1: r.address_1 as string, city: r.city as string,
    region: r.region as string, postalCode: r.postal_code as string,
    phone: (r.phone as string) ?? '',
    taxRate: Number(r.tax_rate ?? 0.1025),
    isActive: r.is_active as boolean,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
  _locationsCache = { data, expiresAt: Date.now() + PG_READ_TTL_MS };
  return data;
}

export function invalidateLocationsCache(): void { _locationsCache = null; }

export async function pgUpdateLocation(id: string, data: Partial<{
  name: string; address1: string; city: string; region: string;
  postalCode: string; phone: string; taxRate: number;
}>) {
  const map: Record<string, string> = {
    name: 'name', address1: 'address_1', city: 'city', region: 'region',
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
  await pool.query(`UPDATE locations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
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

export async function pgCreateRegisterSession(data: {
  id: string; authSessionId: string; employeeId: string; locationId: string;
}): Promise<RegisterSessionRecord> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO register_sessions (id, auth_session_id, employee_id, location_id, status, started_at, pending_exception_ids)
     VALUES ($1, $2, $3, $4, 'active', $5, '[]'::jsonb) RETURNING *`,
    [data.id, data.authSessionId, data.employeeId, data.locationId, ts],
  );
  return toRegisterSession(rows[0]);
}

export async function pgFindActiveRegisterSession(authSessionId: string): Promise<RegisterSessionRecord | null> {
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

export async function pgEndRegisterSession(id: string): Promise<void> {
  const ts = new Date().toISOString();
  await pool.query(
    `UPDATE register_sessions SET status = 'ended', ended_at = $1, active_shift_id = NULL WHERE id = $2`,
    [ts, id],
  );
}

export async function pgOpenShift(data: {
  id: string; locationId: string; employeeId: string; registerSessionId: string | null;
  openingFloat: number; openedNote?: string; idempotencyKey?: string | null;
}): Promise<ShiftRecord> {
  // Get organizationId from location
  const { rows: locRows } = await pool.query(
    'SELECT organization_id FROM locations WHERE id = $1',
    [data.locationId],
  );
  if (!locRows[0]) throw new Error('Location not found');
  const organizationId = locRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows } = await client.query(
      `INSERT INTO shifts (id, location_id, employee_id, register_session_id, status, opened_at, opening_float, opened_note, idempotency_key)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8) RETURNING *`,
      [data.id, data.locationId, data.employeeId, data.registerSessionId, ts, data.openingFloat, data.openedNote ?? null, data.idempotencyKey ?? null],
    );
    // Only update register_sessions if a register session is provided (admin-initiated shifts have none)
    if (data.registerSessionId) {
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
}): Promise<ShiftRecord> {
  // Get organizationId from shift via location
  const { rows: shiftRows } = await pool.query(
    'SELECT l.organization_id FROM shifts s JOIN locations l ON s.location_id = l.id WHERE s.id = $1',
    [shiftId],
  );
  if (!shiftRows[0]) throw new Error('Shift not found');
  const organizationId = shiftRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const variance = Number((data.closingDeclaredCash - data.closingExpectedCash).toFixed(2));
    const { rows } = await client.query(
      `UPDATE shifts SET status = 'closed', closed_at = $1, closing_expected_cash = $2,
       closing_declared_cash = $3, closing_variance = $4, closed_note = $5
       WHERE id = $6 AND status = 'open' RETURNING *`,
      [ts, data.closingExpectedCash, data.closingDeclaredCash, variance, data.closedNote ?? null, shiftId],
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

export async function pgFindOpenShift(shiftId: string): Promise<ShiftRecord | null> {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE id = $1 AND status = 'open' LIMIT 1`,
    [shiftId],
  );
  return rows[0] ? toShift(rows[0]) : null;
}

export async function pgAutoCloseShift(shiftId: string): Promise<void> {
  const ts = new Date().toISOString();
  await pool.query(
    `UPDATE shifts SET status = 'closed', closed_at = $1,
     closing_expected_cash = opening_float, closing_declared_cash = opening_float,
     closing_variance = 0, closed_note = 'Auto-closed because register session ended without manual shift close.'
     WHERE id = $2 AND status = 'open'`,
    [ts, shiftId],
  );
}

export async function pgGetCashDrawerBalance(registerSessionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT opening_float FROM shifts WHERE register_session_id = $1 AND status = 'open' LIMIT 1`,
    [registerSessionId],
  );
  return rows[0] ? Number(rows[0].opening_float) : 0;
}
