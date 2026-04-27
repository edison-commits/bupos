import { hashSecret } from "@/lib/auth/crypto";
import { seedBundle } from "@/lib/data/mock-data";
import type { LocalStoreData } from "@/lib/persistence/types";

const now = new Date().toISOString();

const orgId = () => seedBundle.organization.id;

// TST-M2: hard fail-closed in production. The legacy in-memory store
// (the `else` branch of `isPg()`) is the only consumer; prod sets
// USE_POSTGRES=true so this is unreachable. But the file ships in the
// OpenNext bundle, so a deploy without USE_POSTGRES (preview build,
// env-var rotation drop) would otherwise silently seed `ownerpass` /
// `managerpass` / PINs `1111`/`2222`/`3333` into the JSON-file store
// on the first request. Explicit refusal makes that fail loud.
function assertNotProd(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[seed.ts] createSeedStore() called in production. The legacy ' +
      'mock-data seed must never run on a prod deploy — set ' +
      'USE_POSTGRES=true to route through the canonical Postgres path.',
    );
  }
  // Workers runtime check — `globalThis.WebSocketPair` is the standard
  // Cloudflare Workers tell. If we're on Workers and USE_POSTGRES is
  // missing, refuse rather than seed the bundled creds.
  const isWorkers = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'function';
  if (isWorkers && !process.env.USE_POSTGRES) {
    throw new Error(
      '[seed.ts] running on Cloudflare Workers without USE_POSTGRES — ' +
      'refusing to seed mock credentials. Provision USE_POSTGRES=true.',
    );
  }
}

export async function createSeedStore(): Promise<LocalStoreData> {
  assertNotProd();
  return {
    ...seedBundle,
    customers: [
      { id: "cust-001", organizationId: orgId(), firstName: "Maria", lastName: "Santos", email: "maria.santos@email.com", phone: "(562) 555-0101", loyaltyPoints: 1250, totalSpend: 842.50, visitCount: 14, storeCreditBalance: 0, isActive: true, createdAt: now, updatedAt: now },
      { id: "cust-002", organizationId: orgId(), firstName: "James", lastName: "Chen", email: "james.chen@email.com", phone: "(562) 555-0102", loyaltyPoints: 780, totalSpend: 523.00, visitCount: 9, storeCreditBalance: 15.00, isActive: true, createdAt: now, updatedAt: now },
      { id: "cust-003", organizationId: orgId(), firstName: "Aisha", lastName: "Johnson", phone: "(562) 555-0103", loyaltyPoints: 2100, totalSpend: 1456.75, visitCount: 22, storeCreditBalance: 0, isActive: true, createdAt: now, updatedAt: now },
      { id: "cust-004", organizationId: orgId(), firstName: "David", lastName: "Park", email: "david.park@email.com", loyaltyPoints: 340, totalSpend: 228.00, visitCount: 5, storeCreditBalance: 0, isActive: true, createdAt: now, updatedAt: now },
      { id: "cust-005", organizationId: orgId(), firstName: "Sarah", lastName: "Williams", email: "sarah.w@email.com", phone: "(562) 555-0105", loyaltyPoints: 50, totalSpend: 67.99, visitCount: 2, storeCreditBalance: 0, notes: "Prefers receipts emailed", isActive: true, createdAt: now, updatedAt: now },
    ],
    inventoryAdjustments: [],
    shifts: [],
    payInOuts: [],
    registerSessions: [],
    authCredentials: [
      {
        employeeId: seedBundle.employees[0].id,
        email: "owner@basicuniformpos.local",
        passwordHash: await hashSecret("ownerpass"),
        pinHash: await hashSecret("1111"),
        passwordLastRotatedAt: now,
        pinLastRotatedAt: now,
      },
      {
        employeeId: seedBundle.employees[1].id,
        email: "manager@basicuniformpos.local",
        passwordHash: await hashSecret("managerpass"),
        pinHash: await hashSecret("2222"),
        passwordLastRotatedAt: now,
        pinLastRotatedAt: now,
      },
      {
        employeeId: seedBundle.employees[2].id,
        pinHash: await hashSecret("3333"),
        pinLastRotatedAt: now,
      },
    ],
    sessions: [],
    // Phase 2 entities
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
    // Phase 3
    timeClockEntries: [],
    promoCodes: seedPromoCodes(orgId()),
    promoRedemptions: [],
  };
}

function seedPromoCodes(orgId: string): import("@/lib/domain/types").PromoCode[] {
  const ts = new Date().toISOString();
  return [
    {
      id: "promo_welcome10",
      organizationId: orgId,
      code: "WELCOME10",
      description: "10% off first purchase",
      type: "percent",
      value: 10,
      minimumPurchase: 20,
      maxRedemptions: 100,
      currentRedemptions: 3,
      status: "active",
      startsAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z",
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "promo_save5",
      organizationId: orgId,
      code: "SAVE5",
      description: "$5 off orders over $30",
      type: "fixed",
      value: 5,
      minimumPurchase: 30,
      maxRedemptions: 200,
      currentRedemptions: 12,
      status: "active",
      startsAt: "2025-06-01T00:00:00.000Z",
      expiresAt: "2026-06-30T23:59:59.000Z",
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "promo_bogo_tees",
      organizationId: orgId,
      code: "BOGOTEE",
      description: "Buy one get one free tees",
      type: "bogo",
      value: 0,
      minimumPurchase: 0,
      maxRedemptions: 50,
      currentRedemptions: 0,
      status: "active",
      startsAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-04-30T23:59:59.000Z",
      createdAt: ts,
      updatedAt: ts,
    },
  ];
}
