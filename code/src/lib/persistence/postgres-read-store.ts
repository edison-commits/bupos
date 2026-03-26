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
  pgReadGiftCards,
  pgReadBehaviorFlags,
  pgReadLayaways,
  pgReadStocktakes,
  pgReadTransfers,
} from '@/lib/persistence/postgres-phase2';
import {
  pgReadPromoCodes,
} from '@/lib/persistence/postgres-phase3';
import type { LocalStoreData } from '@/lib/persistence/types';
import type { TransactionExceptionPlaceholder } from '@/lib/domain/types';
import type { Organization, Location, ModifierGroup, Modifier, TenderType, AuditEventKind } from '@/lib/domain/types';

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
 * This lets all page components that depend on `readStore()` work
 * when running in PG mode (including Cloudflare Workers).
 */
export async function readStoreFromPg(): Promise<LocalStoreData> {
  // Read path uses pool.query directly — RLS fallback policy allows access
  // when no org context is set. Write paths use orgTx() for strict isolation.
  // CRITICAL: Run all queries in parallel to avoid Cloudflare Worker CPU timeouts.

  const { rows: orgRows } = await pool.query('SELECT * FROM organizations LIMIT 1');
  const org = toOrg(orgRows[0]);
  const orgId = org.id;

  // Run ALL remaining queries in parallel
  const [
    locResult,
    employees,
    categories,
    products,
    variants,
    inventory,
    customers,
    promoCodes,
    mgResult,
    modResult,
    authResult,
    sessResult,
    shiftResult,
    rsResult,
    pioResult,
    tenderResult,
    eventResult,
    excResult,
  ] = await Promise.all([
    pool.query('SELECT * FROM locations WHERE organization_id = $1 AND is_active = true ORDER BY name', [orgId]),
    pgReadEmployees(),
    pgReadCategories(),
    pgReadProducts(),
    pgReadVariants(),
    pgReadInventory(),
    pgReadCustomers(orgId),
    pgReadPromoCodes(orgId),
    pool.query('SELECT * FROM modifier_groups WHERE organization_id = $1 ORDER BY name', [orgId]),
    pool.query('SELECT * FROM modifiers WHERE organization_id = $1 ORDER BY sort_order', [orgId]),
    pool.query('SELECT * FROM auth_credentials'),
    pool.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 100'),
    pool.query('SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 200'),
    pool.query('SELECT * FROM register_sessions ORDER BY started_at DESC LIMIT 200'),
    pool.query('SELECT * FROM pay_in_outs ORDER BY created_at DESC LIMIT 500'),
    pool.query('SELECT * FROM transaction_tenders ORDER BY created_at DESC LIMIT 1000'),
    pool.query('SELECT * FROM transaction_events ORDER BY created_at DESC LIMIT 1000'),
    pool.query('SELECT * FROM transaction_exceptions ORDER BY created_at DESC LIMIT 500'),
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

  const transactionTenderPlaceholders = tenderResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    transactionId: r.transaction_id as string,
    tenderType: r.tender_type as TenderType,
    amount: Number(r.amount),
    metadata: (r.metadata as Record<string, string>) ?? undefined,
  }));

  const transactionEventPlaceholders = eventResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    transactionId: r.transaction_id as string,
    eventKind: r.event_kind as AuditEventKind,
    actorEmployeeId: r.actor_employee_id as string,
    notes: (r.notes as string) ?? undefined,
    payload: (r.payload as Record<string, string>) ?? undefined,
    createdAt: String(r.created_at),
  }));

  const transactionExceptionPlaceholders = excResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    transactionId: r.transaction_id as string,
    exceptionCode: r.exception_code as TransactionExceptionPlaceholder['exceptionCode'],
    requiresManagerApproval: r.requires_manager_approval as boolean,
    resolvedAt: r.resolved_at ? String(r.resolved_at) : undefined,
  }));

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

  return {
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
}
