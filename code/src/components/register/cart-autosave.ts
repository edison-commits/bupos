import type { CartDraft } from "@/lib/offline/idb-store";

export const CART_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function buildCartDraftKey(input: {
  registerSessionId: string;
  employeeId: string;
  locationId: string;
  deviceId: string;
}): string {
  return `cart-draft:${input.locationId}:${input.registerSessionId}:${input.employeeId}:${input.deviceId}`;
}

export function isRestorableCartDraft(draft: CartDraft | null, now = Date.now()): draft is CartDraft {
  if (!draft) return false;
  const savedAt = Date.parse(draft.savedAt);
  if (!Number.isFinite(savedAt)) return false;
  if (now - savedAt > CART_DRAFT_TTL_MS) return false;
  const cart = draft.cart as { items?: unknown[] } | null;
  return Array.isArray(cart?.items) && cart.items.length > 0;
}
