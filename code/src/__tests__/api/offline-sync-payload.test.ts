import { describe, expect, it } from "vitest";
import { validateOfflineSyncPayload, type CartPayload, type OfflineTender } from "@/app/api/offline-sync/payload";

const cart = (overrides: Partial<CartPayload> = {}): CartPayload => ({
  employeeId: "employee-1",
  registerSessionId: "session-1",
  items: [],
  ...overrides,
});

const tender = (overrides: Partial<OfflineTender> = {}): OfflineTender => ({
  type: "cash",
  amount: 12.34,
  ...overrides,
});

describe("offline-sync payload validation", () => {
  it("accepts ordinary cash/card tenders", () => {
    expect(validateOfflineSyncPayload(cart(), [tender()])).toEqual({ ok: true });
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "card" })])).toEqual({ ok: true });
  });

  it("rejects malformed tender shape before arithmetic", () => {
    expect(validateOfflineSyncPayload(cart(), [])).toEqual({ ok: false, error: "Invalid payload" });
    expect(validateOfflineSyncPayload(cart(), [null as unknown as OfflineTender])).toEqual({ ok: false, error: "Invalid tender entry" });
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "cash", amount: Number.NaN })])).toEqual({ ok: false, error: "Invalid tender amount" });
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "cash", amount: 10_000_001 })])).toEqual({ ok: false, error: "Invalid tender amount" });
  });

  it("keeps value-backed tenders tied to backing customer/card metadata", () => {
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "loyalty" })])).toEqual({ ok: false, error: "loyalty tender requires a customer" });
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "store_credit" })])).toEqual({ ok: false, error: "store_credit tender requires a customer" });
    expect(validateOfflineSyncPayload(cart({ customerId: "customer-1" }), [tender({ type: "loyalty" })])).toEqual({ ok: true });
    expect(validateOfflineSyncPayload(cart(), [tender({ type: "gift_card" })])).toEqual({ ok: false, error: "Gift card tender requires gift_card_id metadata" });
    expect(validateOfflineSyncPayload(cart(), [tender({
      type: "gift_card",
      metadata: { gift_card_id: "11111111-1111-4111-8111-111111111111" },
    })])).toEqual({ ok: true });
  });
});
