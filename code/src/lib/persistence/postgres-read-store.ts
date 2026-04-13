import 'server-only';
import pool from '@/lib/db';
import { defaultApprovalThresholds } from '@/lib/config/thresholds';
import { roleDefinitions } from '@/lib/domain/permissions';
import {
  pgReadCategories,
  pgReadProducts,
  pgReadVariants,
  pgReadInventory,
  pgReadEmployees,
} from '@/lib/persistence/postgres-store';
import {
  pgReadCustomers,
} from '@/lib/persistence/postgres-phase2';
import {
  pgReadPromoCodes,
} from '@/lib/persistence/postgres-phase3';
import type { LocalStoreData } from '@/lib/persistence/types';
import type { Organization, Location, ModifierGroup, Modifier, TenderType } from '@/lib/domain/types';

// In-memory cache — shared across all requests on the server process
// TTL of 30s means the first request pays the ~600ms Postgres cost,
// all subsequent requests for the next 30s are served from memory (~0ms).
const STORE_CACHE_TTL_MS = 30_000;
const _storeCache = new Map<string, { data: LocalStoreData; expiresAt: number }>();

function _getCachedStore(orgId: string): LocalStoreData | null {
  const cached = _storeCache.get(orgId);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    _storeCache.delete(orgId);
    return null;
  }
  return cached.data;
}

// Call this after any mutation that changes core store data
// to ensure the next read gets fresh data.
export function invalidateStoreCache(orgId?: string): void {
  if (orgId) {
    _storeCache.delete(orgId);
    return;
  }
  _storeCache.clear();
}

function toOrg(r: Record<string, unknown>): Organization {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    legalName: (r.legal_name as string) ?? undefined,
    timezone: r.timezone as string,
    currencyCode: r.currency_code as string,
    phone: (r.phone as string) ?? '',
    email: (r.email as string) ?? '',
    website: (r.website as string) ?? '',
    receiptHeader: (r.receipt_header as string) ?? '',
    receiptFooter: (r.receipt_footer as string) ?? 'Thank you for shopping with us!',
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toLocation(r: Record<string, unknown>): Location {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    code: r.code as string,
    address1: (r.address1 as string) ?? '',
    city: (r.city as string) ?? '',
    region: (r.region as string) ?? '',
    postalCode: (r.postal_code as string) ?? '',
    phone: (r.phone as string) ?? '',
    taxRate: Number(r.tax_rate ?? 0.1025),
    isActive: r.is_active as boolean,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toModifierGroup(r: Record<string, unknown>): ModifierGroup {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    selectionMode: r.selection_mode as ModifierGroup['selectionMode'],
    minSelections: Number(r.min_selections),
    maxSelections: Number(r.max_selections),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toModifier(r: Record<string, unknown>): Modifier {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    modifierGroupId: r.modifier_group_id as string,
    name: r.name as string,
    priceDelta: Number(r.price_delta),
    sortOrder: Number(r.sort_order),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Build the full LocalStoreData from Postgres.
 * Results are cached in-memory for 30 seconds to avoid repeated
 * ~600ms Postgres round-trips on every API request.
 * Call invalidateStoreCache() after mutations to force a refresh.
 */
export async function readStoreFromPg(orgId?: string): Promise<LocalStoreData> {
  if (!orgId) {
    throw new Error("readStoreFromPg requires explicit orgId");
  }
  const cached = _getCachedStore(orgId);
  if (cached) return cached;
  // CRITICAL: Batch queries to avoid overwhelming neon serverless WebSocket
  // connections on Cloudflare Workers. Each pool.query opens a new WebSocket;
  // 15+ simultaneous connections causes "Connection closed" errors on edge.
  // Batch 1: core entities
  const { rows: orgRows } = await pool.query('SELECT id, name, slug, legal_name, timezone, currency_code, phone, email, website, receipt_header, receipt_footer, created_at, updated_at FROM organizations WHERE id = $1 LIMIT 1', [orgId]);
  const org = toOrg(orgRows[0]);

  const [
    locResult,
    employees,
    categories,
    products,
    variants,
    inventory,
    customers,
    promoCodes,
  ] = await Promise.all([
    pool.query('SELECT * FROM locations WHERE organization_id = $1 AND is_active = true ORDER BY name', [orgId]),
    pgReadEmployees(orgId),
    pgReadCategories(orgId),
    pgReadProducts(orgId),
    pgReadVariants(orgId),
    pgReadInventory(orgId),
    pgReadCustomers(orgId),
    pgReadPromoCodes(orgId),
  ]);

  // Batch 2: secondary entities
  const [
    mgResult,
    modResult,
    authResult,
    sessResult,
    shiftResult,
    rsResult,
    pioResult,
  ] = await Promise.all([
    pool.query('SELECT * FROM modifier_groups WHERE organization_id = $1 ORDER BY name', [orgId]),
    pool.query('SELECT * FROM modifiers WHERE organization_id = $1 ORDER BY sort_order', [orgId]),
    pool.query(
      `SELECT ac.* FROM auth_credentials ac
       JOIN employees e ON e.id = ac.employee_id
       WHERE e.organization_id = $1`,
      [orgId],
    ),
    pool.query('SELECT * FROM sessions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100', [orgId]),
    pool.query(
      `SELECT s.* FROM shifts s
       JOIN locations l ON l.id = s.location_id
       WHERE l.organization_id = $1
       ORDER BY s.opened_at DESC
       LIMIT 200`,
      [orgId],
    ),
    pool.query('SELECT * FROM register_sessions WHERE organization_id = $1 ORDER BY started_at DESC LIMIT 200', [orgId]),
    pool.query('SELECT * FROM pay_in_outs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 500', [orgId]),
  ]);

  const locations = locResult.rows.map(toLocation);
  const modifierGroups = mgResult.rows.map(toModifierGroup);
  const modifiers = modResult.rows.map(toModifier);

  const authCredentials = authResult.rows.map((r: Record<string, unknown>) => ({
    employeeId: r.employee_id as string,
    email: (r.email as string) ?? undefined,
    passwordHash: (r.password_hash as string) ?? undefined,
    pinHash: (r.pin_hash as string) ?? undefined,
    passwordLastRotatedAt: r.password_last_rotated_at ? String(r.password_last_rotated_at) : undefined,
    pinLastRotatedAt: r.pin_last_rotated_at ? String(r.pin_last_rotated_at) : undefined,
  }));

  const sessions = sessResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    employeeId: r.employee_id as string,
    organizationId: r.organization_id as string,
    scope: r.scope as 'admin' | 'register',
    locationId: (r.location_id as string) ?? undefined,
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
    expiresAt: String(r.expires_at),
  }));

  const shifts = shiftResult.rows.map((r: Record<string, unknown>) => ({
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
    blindClose: (r.blind_close as boolean) ?? undefined,
  }));

  const registerSessions = rsResult.rows.map((r: Record<string, unknown>) => ({
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
  }));

  const payInOuts = pioResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    shiftId: r.shift_id as string,
    locationId: r.location_id as string,
    employeeId: r.employee_id as string,
    direction: r.direction as 'pay_in' | 'pay_out',
    amount: Number(r.amount),
    reason: (r.reason as string) ?? '',
    note: (r.note as string) ?? undefined,
    createdAt: String(r.created_at),
  }));

  // Historical transaction placeholders are loaded on demand (see note above).
  const transactionTenderPlaceholders: LocalStoreData['transactionTenderPlaceholders'] = [];
  const transactionEventPlaceholders: LocalStoreData['transactionEventPlaceholders'] = [];
  const transactionExceptionPlaceholders: LocalStoreData['transactionExceptionPlaceholders'] = [];

  // Register configuration (static for now)
  const registerConfiguration = {
    locationId: locations[0]?.id ?? '',
    noReceiptEnabled: true,
    receiptMode: 'browser-print' as const,
    supportedTenders: ['cash', 'card', 'store_credit', 'loyalty', 'gift_card', 'split'] as TenderType[],
    approvalThresholds: defaultApprovalThresholds,
    loyalty: {
      earnRatePerDollar: 1,
      redemptionValuePerPoint: 0.01,
      minimumRedemption: 100,
    },
  };

  const result: LocalStoreData = {
    organization: org,
    locations,
    employees,
    roles: roleDefinitions,
    categories,
    modifierGroups,
    modifiers,
    products,
    variants,
    inventory,
    customers,
    inventoryAdjustments: [],
    registerConfiguration,
    shifts,
    payInOuts,
    registerSessions,
    transactionTenderPlaceholders,
    transactionEventPlaceholders,
    transactionExceptionPlaceholders,
    authCredentials,
    sessions,
    giftCards: [],
    giftCardTransactions: [],
    storeCreditLedger: [],
    behaviorFlags: [],
    layaways: [],
    layawayPayments: [],
    stocktakes: [],
    stocktakeLines: [],
    transfers: [],
    transferLines: [],
    timeClockEntries: [],
    promoCodes,
    promoRedemptions: [],
    bundles: [],
    suppliers: [],
    purchaseOrders: [],
    registers: [],
    recountSchedules: [],
  };

  // Cache the result
  _storeCache.set(orgId, { data: result, expiresAt: Date.now() + STORE_CACHE_TTL_MS });
  return result;
}
