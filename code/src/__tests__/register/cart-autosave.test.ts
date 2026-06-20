import { describe, expect, it } from "vitest";
import type { CartDraft } from "@/lib/offline/idb-store";
import { CART_DRAFT_TTL_MS, buildCartDraftKey, isRestorableCartDraft } from "@/components/register/cart-autosave";

function draft(overrides: Partial<CartDraft> = {}): CartDraft {
  return {
    key: "cart-draft:loc-1:session-1:employee-1:device-1",
    cart: { id: "cart-1", items: [{ id: "line-1" }] },
    approvedExceptions: [],
    appliedPromo: null,
    exchangeCredit: null,
    pendingApprovalIntent: null,
    screen: "selling",
    savedAt: "2026-06-19T12:00:00.000Z",
    registerSessionId: "session-1",
    employeeId: "employee-1",
    locationId: "loc-1",
    deviceId: "device-1",
    ...overrides,
  };
}

describe("cart autosave helpers", () => {
  it("scopes draft keys by location, register session, employee, and device", () => {
    expect(buildCartDraftKey({
      locationId: "loc-1",
      registerSessionId: "session-1",
      employeeId: "employee-1",
      deviceId: "device-1",
    })).toBe("cart-draft:loc-1:session-1:employee-1:device-1");
  });

  it("accepts a non-expired draft with cart items", () => {
    const savedAt = Date.parse("2026-06-19T12:00:00.000Z");
    expect(isRestorableCartDraft(draft(), savedAt + CART_DRAFT_TTL_MS - 1)).toBe(true);
  });

  it("rejects empty cart drafts", () => {
    const savedAt = Date.parse("2026-06-19T12:00:00.000Z");
    expect(isRestorableCartDraft(draft({ cart: { id: "cart-1", items: [] } }), savedAt)).toBe(false);
  });

  it("rejects expired drafts", () => {
    const savedAt = Date.parse("2026-06-19T12:00:00.000Z");
    expect(isRestorableCartDraft(draft(), savedAt + CART_DRAFT_TTL_MS + 1)).toBe(false);
  });

  it("rejects malformed savedAt timestamps", () => {
    expect(isRestorableCartDraft(draft({ savedAt: "not-a-date" }), Date.now())).toBe(false);
  });
});
