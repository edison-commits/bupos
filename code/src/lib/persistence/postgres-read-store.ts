import 'server-only';
import { defaultApprovalThresholds } from '@/lib/config/thresholds';
import { roleDefinitions } from '@/lib/domain/permissions';
import type { LocalStoreData } from '@/lib/persistence/types';
import type { Organization, Location, ModifierGroup, Modifier, TenderType, Employee, Category, Product, ProductVariant, InventoryLevel, Customer, PromoCode, PromoCodeStatus } from '@/lib/domain/types';

// In-memory cache
const STORE_CACHE_TTL_MS = 30_000;
const _storeCache = new Map<string, { data: LocalStoreData; expiresAt: number }>();

function _getCachedStore(orgId: string): LocalStoreData | null {
  const cached = _storeCache.get(orgId);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) { _storeCache.delete(orgId); return null; }
  return cached.data;
}

export function invalidateStoreCache(orgId?: string): void {
  if (orgId) { _storeCache.delete(orgId); return; }
  _storeCache.clear();
}

// ── Row mappers ──────────────────────────────────────────────────────────────

function toOrg(r: Record<string, unknown>): Organization {
  return { id: r.id as string, name: r.name as string, slug: r.slug as string, legalName: (r.legal_name as string) ?? undefined, timezone: r.timezone as string, currencyCode: r.currency_code as string, phone: (r.phone as string) ?? '', email: (r.email as string) ?? '', website: (r.website as string) ?? '', receiptHeader: (r.receipt_header as string) ?? '', receiptFooter: (r.receipt_footer as string) ?? 'Thank you for shopping with us!', createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
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
  return { id: r.id as string, organizationId: r.organization_id as string, locationId: r.location_id as string, productVariantId: r.variant_id as string, onHand: Number(r.quantity_on_hand), reserved: Number(r.quantity_reserved ?? 0), reorderPoint: Number(r.reorder_point ?? 0), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function toCustomer(r: Record<string, unknown>): Customer {
  return { id: r.id as string, organizationId: r.organization_id as string, firstName: r.first_name as string, lastName: r.last_name as string, email: (r.email as string) ?? undefined, phone: (r.phone as string) ?? undefined, loyaltyPoints: Number(r.loyalty_points ?? 0), totalSpend: Number(r.total_spend ?? 0), visitCount: Number(r.visit_count ?? 0), storeCreditBalance: Number(r.store_credit_balance ?? 0), isActive: r.is_active as boolean, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
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
  const cached = _getCachedStore(orgId);
  if (cached) return cached;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL/key not configured');

  // Single HTTP POST to Supabase RPC
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_full_store`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ org_id: orgId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`get_full_store RPC failed: ${res.status} ${text}`);
  }

  const row = await res.json() as Record<string, unknown>;
  if (!row.org) throw new Error(`Organization ${orgId} not found`);

  const org = toOrg(row.org as Record<string, unknown>);
  const locations = parseArray<Record<string, unknown>>(row.locations).map(toLocation);
  const employees = parseArray<Record<string, unknown>>(row.employees).map(toEmployee);
  const categories = parseArray<Record<string, unknown>>(row.categories).map(toCategory);
  const products = parseArray<Record<string, unknown>>(row.products).map(toProduct);
  const variants = parseArray<Record<string, unknown>>(row.variants).map(toVariant);
  const inventory = parseArray<Record<string, unknown>>(row.inventory).map(toInventory);
  const customers = parseArray<Record<string, unknown>>(row.customers).map(toCustomer);
  const promoCodes = parseArray<Record<string, unknown>>(row.promo_codes).map((r) => ({
    id: r.id as string, organizationId: r.organization_id as string,
    code: r.code as string, description: (r.description as string) ?? '',
    type: r.type as PromoCode['type'], value: Number(r.value),
    minimumPurchase: Number(r.minimum_purchase ?? 0), maxRedemptions: Number(r.max_redemptions ?? 0),
    currentRedemptions: Number(r.current_redemptions ?? 0), status: r.status as PromoCodeStatus,
    startsAt: String(r.starts_at), expiresAt: r.expires_at ? String(r.expires_at) : undefined,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
  const modifierGroups = parseArray<Record<string, unknown>>(row.modifier_groups).map(toModifierGroup);
  const modifiers = parseArray<Record<string, unknown>>(row.modifiers).map(toModifier);
  const authCredentials = parseArray<Record<string, unknown>>(row.auth_credentials).map((r) => ({
    employeeId: r.employee_id as string, email: (r.email as string) ?? undefined,
    passwordHash: (r.password_hash as string) ?? undefined, pinHash: (r.pin_hash as string) ?? undefined,
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
    transactionTenderPlaceholders: [], transactionEventPlaceholders: [], transactionExceptionPlaceholders: [],
    authCredentials, sessions, promoCodes,
    giftCards: [], giftCardTransactions: [], storeCreditLedger: [], behaviorFlags: [],
    layaways: [], layawayPayments: [], stocktakes: [], stocktakeLines: [],
    transfers: [], transferLines: [], timeClockEntries: [],
    promoRedemptions: [], bundles: [], suppliers: [],
    purchaseOrders: [], registers: [], recountSchedules: [],
  };

  _storeCache.set(orgId, { data: result, expiresAt: Date.now() + STORE_CACHE_TTL_MS });
  return result;
}
