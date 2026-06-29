import 'server-only';
import { defaultApprovalThresholds } from '@/lib/config/thresholds';
import { roleDefinitions } from '@/lib/domain/permissions';
import type { LocalStoreData } from '@/lib/persistence/types';
import type { Organization, Location, ModifierGroup, Modifier, TenderType, Employee, Category, Product, ProductVariant, InventoryLevel, Customer, CustomerPreference, PromoCode, PromoCodeStatus, TransactionTenderPlaceholder, TransactionEventPlaceholder, AuditEventKind, ProductBundle, BundleItem, Stocktake, StocktakeLine } from '@/lib/domain/types';

// In-memory cache with stale-while-revalidate to prevent cache stampedes.
// On expiry, one request refreshes while others continue serving stale data.
const STORE_CACHE_TTL_MS = 30_000;
const _storeCache = new Map<string, { data: LocalStoreData; expiresAt: number }>();
const _inflight = new Map<string, Promise<LocalStoreData>>(); // prevents stampede

function _getCachedStore(orgId: string): LocalStoreData | null {
  const cached = _storeCache.get(orgId);
  if (!cached) return null;
  // Return stale data even if expired — the caller will trigger a background refresh
  return cached.data;
}

function _isCacheExpired(orgId: string): boolean {
  const cached = _storeCache.get(orgId);
  return !cached || Date.now() > cached.expiresAt;
}

// R32-D2: `orgId` is now REQUIRED. The prior optional+no-arg path
// cleared every tenant's cache on every call — a login in org A then
// re-fetched the `get_full_store` RPC for every OTHER active tenant
// on their next request (cache-stampede amplifier). Also let a
// compromised actor within org A evict caches for org B. Callers
// that truly need to nuke everything (e.g., a catalog-schema
// migration) should clear `_storeCache` directly via a new
// `_forceInvalidateAll` helper rather than abuse the public API.
export function invalidateStoreCache(orgId: string): void {
  _storeCache.delete(orgId);
  _inflight.delete(orgId);
}

/**
 * R32-D2: reserved for schema-migration scripts that must nuke every
 * tenant's cache after a DB structural change. DO NOT call from any
 * request handler — use `invalidateStoreCache(orgId)` instead.
 */
export function _forceInvalidateAllStoreCache(): void {
  _storeCache.clear();
  _inflight.clear();
}

// ── Row mappers ──────────────────────────────────────────────────────────────

function toOrg(r: Record<string, unknown>): Organization {
  return { id: r.id as string, name: r.name as string, slug: r.slug as string, legalName: (r.legal_name as string) ?? undefined, timezone: r.timezone as string, currencyCode: r.currency_code as string, phone: (r.phone as string) ?? '', email: (r.email as string) ?? '', website: (r.website as string) ?? '', receiptHeader: (r.receipt_header as string) ?? '', receiptFooter: (r.receipt_footer as string) ?? 'Thank you for shopping with us!', customerDisplayDisplayName: (r.customer_display_display_name as string) ?? '', customerDisplayWelcomeText: (r.customer_display_welcome_text as string) ?? 'Welcome', customerDisplayIdleMessage: (r.customer_display_idle_message as string) ?? 'Ready to checkout', customerDisplayAccentColor: (r.customer_display_accent_color as string) ?? '#14b8a6', createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toLocation(r: Record<string, unknown>): Location {
  return { id: r.id as string, organizationId: r.organization_id as string, name: r.name as string, code: r.code as string, address1: (r.address1 as string) ?? '', city: (r.city as string) ?? '', region: (r.region as string) ?? '', postalCode: (r.postal_code as string) ?? '', phone: (r.phone as string) ?? '', taxRate: Number(r.tax_rate ?? 0.1025), isActive: r.is_active as boolean, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toModifierGroup(r: Record<string, unknown>): ModifierGroup {
  return { id: r.id as string, organizationId: r.organization_id as string, name: r.name as string, selectionMode: r.selection_mode as ModifierGroup['selectionMode'], minSelections: Number(r.min_selections), maxSelections: Number(r.max_selections), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toModifier(r: Record<string, unknown>): Modifier {
  return { id: r.id as string, organizationId: r.organization_id as string, modifierGroupId: r.modifier_group_id as string, name: r.name as string, priceDelta: Number(r.price_delta), sortOrder: Number(r.sort_order), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toEmployee(r: Record<string, unknown>): Employee {
  return { id: r.id as string, organizationId: r.organization_id as string, firstName: r.first_name as string, lastName: r.last_name as string, displayName: r.display_name as string, email: (r.email as string) ?? '', roleKey: r.role_key as Employee['roleKey'], isActive: r.is_active as boolean, locationIds: (r.location_ids as string[]) ?? [], pinHint: (r.pin_hint as string) ?? '', createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toCategory(r: Record<string, unknown>): Category {
  return { id: r.id as string, organizationId: r.organization_id as string, name: r.name as string, slug: r.slug as string, parentCategoryId: (r.parent_category_id as string) ?? undefined, sortOrder: Number(r.sort_order), imageUrl: (r.image_url as string) ?? undefined, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toProduct(r: Record<string, unknown>): Product {
  return { id: r.id as string, organizationId: r.organization_id as string, categoryId: r.category_id as string, name: r.name as string, slug: r.slug as string, description: (r.description as string) ?? '', imageUrl: (r.image_url as string) ?? '', isActive: r.is_active as boolean, isTouchFavorite: r.is_touch_favorite as boolean, defaultVariantId: (r.default_variant_id as string) ?? undefined, modifierGroupIds: (r.modifier_group_ids as string[]) ?? [], createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toVariant(r: Record<string, unknown>): ProductVariant {
  return { id: r.id as string, organizationId: r.organization_id as string, productId: r.product_id as string, sku: (r.sku as string) ?? '', barcode: (r.barcode as string) ?? '', name: r.name as string, sizeLabel: (r.size_label as string) ?? '', colorLabel: (r.color_label as string) ?? '', price: Number(r.price), compareAtPrice: r.compare_at_price != null ? Number(r.compare_at_price) : undefined, cost: r.cost != null ? Number(r.cost) : undefined, isActive: r.is_active as boolean, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toInventory(r: Record<string, unknown>): InventoryLevel {
  // Column names per inventory_levels schema: product_variant_id (not variant_id),
  // on_hand (not quantity_on_hand), reserved (not quantity_reserved). The old
  // mapper used legacy names and silently produced undefined productVariantId
  // on every row — which made every POS tile render "Out" of stock because
  // the inventory-by-variant lookup in usePOSTerminal returned nothing.
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    locationId: r.location_id as string,
    productVariantId: (r.product_variant_id ?? r.variant_id) as string,
    onHand: Number(r.on_hand ?? r.quantity_on_hand ?? 0),
    reserved: Number(r.reserved ?? r.quantity_reserved ?? 0),
    reorderPoint: Number(r.reorder_point ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function toCustomer(r: Record<string, unknown>): Customer {
  return { id: r.id as string, organizationId: r.organization_id as string, firstName: r.first_name as string, lastName: r.last_name as string, email: (r.email as string) ?? undefined, phone: (r.phone as string) ?? undefined, loyaltyPoints: Number(r.loyalty_points ?? 0), totalSpend: Number(r.total_spend ?? 0), visitCount: Number(r.visit_count ?? 0), storeCreditBalance: Number(r.store_credit_balance ?? 0), isActive: r.is_active as boolean, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toCustomerPreference(r: Record<string, unknown>): CustomerPreference {
  return { id: r.id as string, organizationId: r.organization_id as string, customerId: r.customer_id as string, category: r.category as string, sizeLabel: (r.size_label as string) ?? undefined, fitPreference: (r.fit_preference as string) ?? undefined, preferredColors: (r.preferred_colors as string[]) ?? [], preferredBrands: (r.preferred_brands as string[]) ?? [], styleNotes: (r.style_notes as string) ?? undefined, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}

function parseArray<T>(val: unknown): T[] {
  if (typeof val === 'string') return JSON.parse(val) as T[];
  if (Array.isArray(val)) return val as T[];
  return [];
}

/**
 * Build full LocalStoreData using Supabase RPC (single HTTP request).
 * Uses SECURITY DEFINER function that bypasses RLS.
 * No WebSocket connections — works perfectly on Cloudflare Workers.
 */
export async function readStoreFromPg(orgId?: string): Promise<LocalStoreData> {
  if (!orgId) throw new Error("readStoreFromPg requires explicit orgId");

  // Stale-while-revalidate: serve stale data while one request refreshes
  const cached = _getCachedStore(orgId);
  if (cached && !_isCacheExpired(orgId)) return cached;

  // R32-D11: bound how stale "stale-while-revalidate" is allowed to
  // go. If a refresh has been in-flight for longer than
  // MAX_STALE_WAIT_MS, stop returning the stale copy and await the
  // refresh instead. Prior shape had NO upper bound: a single slow
  // refresh (hung DB, stuck connection) served minutes-old data to
  // every concurrent caller indefinitely.
  const MAX_STALE_WAIT_MS = 30_000;
  const existing = _inflight.get(orgId);
  if (existing) {
    const entry = _storeCache.get(orgId);
    // If we have a cached copy and it's within the stale-window,
    // serve it. Otherwise, wait for the in-flight refresh.
    if (cached && entry && Date.now() - entry.expiresAt < MAX_STALE_WAIT_MS) {
      return cached;
    }
    return existing;
  }

  // This request becomes the refresher
  const refreshPromise = _doFetchStore(orgId);
  _inflight.set(orgId, refreshPromise);
  try {
    const result = await refreshPromise;
    return result;
  } finally {
    _inflight.delete(orgId);
  }
}

async function _doFetchStore(orgId: string): Promise<LocalStoreData> {
  // Direct DB pool — previously went through Supabase REST with the service
  // role key. Round 24 showed that relying on that key (or falling back to
  // anon) while the RPC has PUBLIC EXECUTE was a reachability bug. The
  // postgres role via DATABASE_URL has an explicit EXECUTE grant, so this
  // route is unaffected by the REVOKE that closed the anon path.
  // R25-perf-6: prior shape fired 3 concurrent `orgQuery`/`pool.query`
  // calls on remote, each opening a fresh Neon WebSocket pool. On a
  // cold isolate's first store-cache miss, that's 3× ~50-150ms
  // handshakes ≈ 150-450ms. Consolidate onto a single `orgTx` client
  // so we pay one handshake. Same three reads, now serial on one
  // connection — total cost bounded by slowest query, not 3×handshake.
  const { orgTx } = await import("@/lib/supabase-rest");
  const client = await orgTx(orgId);
  let rows: Array<{ result?: Record<string, unknown> | null }>;
  let bundleRowsRes: { rows: Record<string, unknown>[] };
  let bundleItemRowsRes: { rows: Record<string, unknown>[] };
  let stocktakeRowsRes: { rows: Record<string, unknown>[] };
  let stocktakeLineRowsRes: { rows: Record<string, unknown>[] };
  let customerPreferenceRowsRes: { rows: Record<string, unknown>[] };
  try {
    const storeRes = await client.query<{ result: Record<string, unknown> | null }>(
      `SELECT get_full_store($1::uuid) AS result`,
      [orgId],
    );
    rows = storeRes.rows;
    // R26-F2: explicit organization_id filters. Prior shape relied on
    // RLS policies to scope rows, but prod's `postgres` role has
    // `rolbypassrls = true` — FORCE RLS does NOT override role-level
    // BYPASSRLS. Verified against prod: a SELECT under `postgres` with
    // a bogus `app.current_org_id` returns all rows across all orgs.
    // Every raw query on an org-scoped table MUST include an explicit
    // `WHERE organization_id = $N` filter; RLS is a dev-only safety net.
    bundleRowsRes = await client.query<Record<string, unknown>>(
      `SELECT id, organization_id, name, slug, description, image_url,
              bundle_price, compare_at_price, is_active, created_at, updated_at
       FROM product_bundles
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [orgId],
    );
    bundleItemRowsRes = await client.query<Record<string, unknown>>(
      `SELECT bi.id, bi.bundle_id, bi.product_variant_id, bi.quantity, bi.created_at
         FROM bundle_items bi
         JOIN product_bundles pb ON pb.id = bi.bundle_id
        WHERE pb.organization_id = $1
        ORDER BY bi.created_at ASC`,
      [orgId],
    );
    stocktakeRowsRes = await client.query<Record<string, unknown>>(
      `SELECT id, organization_id, location_id, initiated_by, status, count_type,
              category_filter, notes, accepted_by, accepted_at, created_at, updated_at
       FROM stocktakes
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [orgId],
    );
    stocktakeLineRowsRes = await client.query<Record<string, unknown>>(
      `SELECT sl.id, sl.stocktake_id, sl.product_variant_id, sl.expected_qty,
              sl.counted_qty, sl.variance, sl.variance_reason, sl.counted_by,
              sl.counted_at, sl.created_at
       FROM stocktake_lines sl
       JOIN stocktakes st ON st.id = sl.stocktake_id
       WHERE st.organization_id = $1
       ORDER BY sl.created_at ASC`,
      [orgId],
    );
    customerPreferenceRowsRes = await client.query<Record<string, unknown>>(
      `SELECT id, organization_id, customer_id, category, size_label, fit_preference,
              preferred_colors, preferred_brands, style_notes, created_at, updated_at
         FROM customer_preferences
        WHERE organization_id = $1
        ORDER BY category ASC`,
      [orgId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const row = (rows[0]?.result ?? null) as Record<string, unknown> | null;
  if (!row || !row.org) throw new Error(`Organization ${orgId} not found`);

  const org = toOrg(row.org as Record<string, unknown>);
  const locations = parseArray<Record<string, unknown>>(row.locations).map(toLocation);
  const employees = parseArray<Record<string, unknown>>(row.employees).map(toEmployee);
  const categories = parseArray<Record<string, unknown>>(row.categories).map(toCategory);
  const products = parseArray<Record<string, unknown>>(row.products).map(toProduct);
  const variants = parseArray<Record<string, unknown>>(row.variants).map(toVariant);
  const inventory = parseArray<Record<string, unknown>>(row.inventory).map(toInventory);
  const customers = parseArray<Record<string, unknown>>(row.customers).map(toCustomer);
  const customerPreferences = customerPreferenceRowsRes.rows.map(toCustomerPreference);
  const preferencesByCustomer = new Map<string, CustomerPreference[]>();
  for (const preference of customerPreferences) {
    const existing = preferencesByCustomer.get(preference.customerId) ?? [];
    existing.push(preference);
    preferencesByCustomer.set(preference.customerId, existing);
  }
  for (const customer of customers) {
    customer.preferences = preferencesByCustomer.get(customer.id) ?? [];
  }
  const promoCodes = parseArray<Record<string, unknown>>(row.promo_codes).map((r) => ({
    id: r.id as string, organizationId: r.organization_id as string,
    code: r.code as string, description: (r.description as string) ?? '',
    type: r.type as PromoCode['type'], value: Number(r.value),
    minimumPurchase: Number(r.minimum_purchase ?? 0), maxRedemptions: Number(r.max_redemptions ?? 0),
    currentRedemptions: Number(r.current_redemptions ?? 0), status: r.status as PromoCodeStatus,
    startsAt: String(r.starts_at), expiresAt: r.expires_at ? String(r.expires_at) : undefined,
    // Present iff type === 'free_item'; enforced by DB CHECK. The store
    // cache ships the full row so register-side promo lookups can display
    // the free variant without an extra round-trip.
    freeVariantId: (r.free_variant_id as string) ?? undefined,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
  const modifierGroups = parseArray<Record<string, unknown>>(row.modifier_groups).map(toModifierGroup);
  const modifiers = parseArray<Record<string, unknown>>(row.modifiers).map(toModifier);
  // Strip sensitive credential hashes from the cached store — auth lookups
  // should use dedicated RPCs, not the full store cache.
  const authCredentials = parseArray<Record<string, unknown>>(row.auth_credentials).map((r) => ({
    employeeId: r.employee_id as string, email: (r.email as string) ?? undefined,
    passwordLastRotatedAt: r.password_last_rotated_at ? String(r.password_last_rotated_at) : undefined,
    pinLastRotatedAt: r.pin_last_rotated_at ? String(r.pin_last_rotated_at) : undefined,
  }));
  const sessions = parseArray<Record<string, unknown>>(row.sessions).map((r) => ({
    id: r.id as string, employeeId: r.employee_id as string,
    organizationId: r.organization_id as string, scope: r.scope as 'admin' | 'register',
    locationId: (r.location_id as string) ?? undefined, createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at), expiresAt: String(r.expires_at),
  }));
  const shifts = parseArray<Record<string, unknown>>(row.shifts).map((r) => ({
    id: r.id as string, locationId: r.location_id as string, employeeId: r.employee_id as string,
    registerSessionId: r.register_session_id as string, status: r.status as 'open' | 'closed',
    openedAt: String(r.opened_at), openingFloat: Number(r.opening_float),
    openedNote: (r.opened_note as string) ?? undefined,
    closedAt: r.closed_at ? String(r.closed_at) : undefined,
    closingExpectedCash: r.closing_expected_cash != null ? Number(r.closing_expected_cash) : undefined,
    closingDeclaredCash: r.closing_declared_cash != null ? Number(r.closing_declared_cash) : undefined,
    closingVariance: r.closing_variance != null ? Number(r.closing_variance) : undefined,
    closedNote: (r.closed_note as string) ?? undefined, blindClose: (r.blind_close as boolean) ?? undefined,
  }));
  const registerSessions = parseArray<Record<string, unknown>>(row.register_sessions).map((r) => ({
    id: r.id as string, authSessionId: r.auth_session_id as string,
    employeeId: r.employee_id as string, locationId: r.location_id as string,
    status: r.status as 'active' | 'ended', startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
    activeShiftId: (r.active_shift_id as string) ?? undefined,
    lastCartId: (r.last_cart_id as string) ?? undefined,
    lastTransactionId: (r.last_transaction_id as string) ?? undefined,
    pendingExceptionIds: (r.pending_exception_ids as string[]) ?? [],
  }));
  const payInOuts = parseArray<Record<string, unknown>>(row.pay_in_outs).map((r) => ({
    id: r.id as string, shiftId: r.shift_id as string, locationId: r.location_id as string,
    employeeId: r.employee_id as string, direction: r.direction as 'pay_in' | 'pay_out',
    amount: Number(r.amount), reason: (r.reason as string) ?? '',
    note: (r.note as string) ?? undefined, createdAt: String(r.created_at),
  }));

  // transaction_tenders + transaction_events are needed by register-console to
  // compute expected cash, sales total, and tender breakdown for the active
  // shift. Without these the UI always shows $0 / 0 transactions.
  const transactionTenderPlaceholders: TransactionTenderPlaceholder[] = parseArray<Record<string, unknown>>(row.transaction_tenders).map((r) => ({
    id: r.id as string,
    transactionId: r.transaction_id as string,
    tenderType: r.tender_type as TenderType,
    amount: Number(r.amount),
    metadata: (r.metadata as Record<string, string>) ?? {},
  }));
  const transactionEventPlaceholders: TransactionEventPlaceholder[] = parseArray<Record<string, unknown>>(row.transaction_events).map((r) => ({
    id: r.id as string,
    transactionId: r.transaction_id as string,
    eventKind: r.event_kind as AuditEventKind,
    actorEmployeeId: (r.actor_employee_id as string) ?? undefined,
    notes: (r.notes as string) ?? '',
    payload: (r.payload as Record<string, string>) ?? {},
    createdAt: String(r.created_at),
  }));

  // Shape bundles + their items. Grouping items once up-front is O(items)
  // instead of O(bundles × items) from repeated .filter() per bundle.
  const itemsByBundle = new Map<string, BundleItem[]>();
  for (const r of bundleItemRowsRes.rows as Record<string, unknown>[]) {
    const bundleId = r.bundle_id as string;
    const arr = itemsByBundle.get(bundleId) ?? [];
    arr.push({
      id: r.id as string,
      bundleId,
      productVariantId: r.product_variant_id as string,
      quantity: Number(r.quantity),
    });
    itemsByBundle.set(bundleId, arr);
  }
  const bundles: ProductBundle[] = (bundleRowsRes.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    slug: r.slug as string,
    description: (r.description as string) ?? undefined,
    imageUrl: (r.image_url as string) ?? undefined,
    bundlePrice: Number(r.bundle_price),
    compareAtPrice: r.compare_at_price != null ? Number(r.compare_at_price) : undefined,
    isActive: r.is_active as boolean,
    items: itemsByBundle.get(r.id as string) ?? [],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));

  const stocktakes: Stocktake[] = stocktakeRowsRes.rows.map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    locationId: r.location_id as string,
    initiatedBy: r.initiated_by as string,
    status: r.status as Stocktake['status'],
    countType: r.count_type as Stocktake['countType'],
    categoryFilter: (r.category_filter as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    acceptedBy: (r.accepted_by as string) ?? undefined,
    acceptedAt: r.accepted_at ? String(r.accepted_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
  const stocktakeLines: StocktakeLine[] = stocktakeLineRowsRes.rows.map((r) => ({
    id: r.id as string,
    stocktakeId: r.stocktake_id as string,
    productVariantId: r.product_variant_id as string,
    expectedQty: Number(r.expected_qty),
    countedQty: r.counted_qty != null ? Number(r.counted_qty) : undefined,
    variance: r.variance != null ? Number(r.variance) : undefined,
    varianceReason: (r.variance_reason as string) ?? undefined,
    countedBy: (r.counted_by as string) ?? undefined,
    countedAt: r.counted_at ? String(r.counted_at) : undefined,
    createdAt: String(r.created_at),
  }));

  const result: LocalStoreData = {
    organization: org, locations, employees, roles: roleDefinitions,
    categories, modifierGroups, modifiers, products, variants, inventory, customers,
    inventoryAdjustments: [],
    registerConfiguration: {
      locationId: locations[0]?.id ?? '', noReceiptEnabled: true,
      receiptMode: 'browser-print' as const,
      supportedTenders: ['cash', 'card', 'store_credit', 'loyalty', 'gift_card', 'split'] as TenderType[],
      approvalThresholds: defaultApprovalThresholds,
      loyalty: { earnRatePerDollar: 1, redemptionValuePerPoint: 0.01, minimumRedemption: 100 },
    },
    shifts, payInOuts, registerSessions,
    transactionTenderPlaceholders, transactionEventPlaceholders, transactionExceptionPlaceholders: [],
    authCredentials, sessions, promoCodes,
    giftCards: [], giftCardTransactions: [], storeCreditLedger: [], behaviorFlags: [],
    layaways: [], layawayPayments: [], stocktakes, stocktakeLines,
    transfers: [], transferLines: [], timeClockEntries: [],
    promoRedemptions: [], bundles, suppliers: [],
    purchaseOrders: [], registers: [], recountSchedules: [],
  };

  _storeCache.set(orgId, { data: result, expiresAt: Date.now() + STORE_CACHE_TTL_MS });
  return result;
}
