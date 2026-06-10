import "server-only";
import { readStore } from "@/lib/persistence/store";
import type { LocalStoreData } from "@/lib/persistence/types";

/**
 * readStore with every array field guaranteed present. RSC serialization can
 * drop `undefined` fields and Neon connection drops can produce partial store
 * data — the same defaults admin/page.tsx and admin-console.tsx apply inline.
 * Used by the dedicated feature pages (gift cards, layaways, transfers,
 * stocktakes) that render store-fed manager components.
 */
const ARRAY_DEFAULTS: Record<string, unknown[]> = {
  locations: [], employees: [], categories: [], products: [], variants: [],
  inventory: [], customers: [], modifierGroups: [], modifiers: [],
  authCredentials: [], sessions: [], shifts: [], registerSessions: [],
  payInOuts: [], promoCodes: [], roles: [],
  inventoryAdjustments: [], transactionEventPlaceholders: [],
  transactionTenderPlaceholders: [], transactionExceptionPlaceholders: [],
  giftCards: [], giftCardTransactions: [], storeCreditLedger: [],
  behaviorFlags: [], layaways: [], layawayPayments: [],
  stocktakes: [], stocktakeLines: [], transfers: [], transferLines: [],
  timeClockEntries: [], promoRedemptions: [], bundles: [],
  suppliers: [], purchaseOrders: [], registers: [], recountSchedules: [],
};

export async function readSafeStore(organizationId: string): Promise<LocalStoreData> {
  const raw = await readStore(organizationId);
  // Strip explicit `undefined` values so they don't override the defaults.
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  return { ...ARRAY_DEFAULTS, ...clean } as LocalStoreData;
}
