export interface CartPayload {
  employeeId?: string;
  registerSessionId?: string;
  customerId?: string;
  loyaltyPointsEarned?: number;
  discountMode?: "percent" | "fixed";
  discountAmount?: number;
  items?: CartLineItem[];
  [key: string]: unknown;
}

export interface CartLineItem {
  productVariantId: string;
  quantity: number;
  overridePrice?: number;
  unitPrice?: number;
  modifierTotal?: number;
  lineDiscount?: {
    mode: "percent" | "fixed";
    value: number;
  };
  /** Present iff this line is a bundle. See src/lib/cart/types.ts. */
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  /** Present iff this line is a free-with-purchase promo redemption. */
  promoCodeId?: string;
  [key: string]: unknown;
}

export interface OfflineTender {
  type: "cash" | "card" | "store_credit" | "loyalty" | "gift_card";
  amount: number;
  metadata?: {
    gift_card_id?: string;
    [key: string]: unknown;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TENDER_TYPES = ["cash", "card", "store_credit", "loyalty", "gift_card"] as const;

export type OfflinePayloadValidation =
  | { ok: true }
  | { ok: false; error: string };

export function validateOfflineSyncPayload(cart: CartPayload, tenders: OfflineTender[]): OfflinePayloadValidation {
  // cart is an object { items, employeeId, registerSessionId, discountMode, discountAmount, ... }
  // tenders is an array [{ tenderType, amount }, ...]
  if (!cart || typeof cart !== "object" || Array.isArray(cart)) {
    return { ok: false, error: "Invalid sync payload: cart must be an object" };
  }
  if (!Array.isArray(tenders)) {
    return { ok: false, error: "Invalid sync payload: tenders must be an array" };
  }
  if (tenders.length === 0) {
    return { ok: false, error: "Invalid payload" };
  }

  // Structural validation — offlineSyncSchema uses z.unknown() for tenders,
  // so we validate shape + sign + finiteness here before any arithmetic.
  for (const t of tenders) {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      return { ok: false, error: "Invalid tender entry" };
    }
    const tt = t as { type?: unknown; amount?: unknown; metadata?: unknown };
    if (typeof tt.type !== "string" || !ALLOWED_TENDER_TYPES.includes(tt.type as OfflineTender["type"])) {
      return { ok: false, error: "Invalid tender type" };
    }
    if (typeof tt.amount !== "number" || !Number.isFinite(tt.amount) || tt.amount <= 0 || tt.amount > 10_000_000) {
      return { ok: false, error: "Invalid tender amount" };
    }
    if (tt.metadata !== undefined && (tt.metadata === null || typeof tt.metadata !== "object" || Array.isArray(tt.metadata))) {
      return { ok: false, error: "Invalid tender metadata" };
    }
    // CRIT-AUDIT11: value-backed tenders must carry the server-verified
    // backing identifier/customer before the payload can satisfy tender
    // sufficiency. Prior shape accepted loyalty/store_credit without a
    // customer and gift_card without gift_card_id; the sale was recorded as
    // paid while no balance/points were deducted.
    if ((tt.type === "loyalty" || tt.type === "store_credit") && typeof cart.customerId !== "string") {
      return { ok: false, error: `${tt.type} tender requires a customer` };
    }
    if (tt.type === "gift_card") {
      const metadata = tt.metadata as { gift_card_id?: unknown } | undefined;
      if (typeof metadata?.gift_card_id !== "string" || !UUID_RE.test(metadata.gift_card_id)) {
        return { ok: false, error: "Gift card tender requires gift_card_id metadata" };
      }
    }
  }

  return { ok: true };
}
