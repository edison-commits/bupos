import type { CartDraft } from "@/lib/offline/idb-store";

export const CART_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CartDraftScope {
  registerSessionId: string;
  employeeId: string;
  locationId: string;
  deviceId: string;
}

export function buildCartDraftKey(input: CartDraftScope): string {
  return `cart-draft:${input.locationId}:${input.registerSessionId}:${input.employeeId}:${input.deviceId}`;
}

export function isRestorableCartDraft(draft: CartDraft | null, now = Date.now(), expectedScope?: CartDraftScope): draft is CartDraft {
  if (!draft) return false;
  const savedAt = Date.parse(draft.savedAt);
  if (!Number.isFinite(savedAt)) return false;
  if (now - savedAt > CART_DRAFT_TTL_MS) return false;
  if (expectedScope) {
    if (draft.registerSessionId !== expectedScope.registerSessionId) return false;
    if (draft.employeeId !== expectedScope.employeeId) return false;
    if (draft.locationId !== expectedScope.locationId) return false;
    if (draft.deviceId !== expectedScope.deviceId) return false;
  }
  const cart = draft.cart as { items?: unknown[] } | null;
  return Array.isArray(cart?.items) && cart.items.length > 0;
}

export function shouldAutosaveCartDraft(input: {
  restoreCheckComplete: boolean;
  hasPendingRestorableDraft: boolean;
  screen: "selling" | "tender" | "receipt";
  hasReceipt: boolean;
}): boolean {
  if (!input.restoreCheckComplete) return false;
  if (input.hasPendingRestorableDraft) return false;
  if (input.screen === "receipt" || input.hasReceipt) return false;
  return true;
}
