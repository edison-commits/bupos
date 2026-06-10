import "server-only";
import type { ChannelProvider, VariantLookup } from "./types";
import { shopifyProvider } from "./shopify";

/**
 * In-memory mock provider for tests (selected when CHANNEL_PROVIDER_MOCK=1).
 * The NETWORK ops are stubbed; the crypto + payload parsing reuse the REAL
 * implementation so webhook-HMAC and order-parsing tests exercise production
 * code paths.
 */

export const MOCK_LOCATION_ID = "gid://shopify/Location/1";

/** Recorded inventory pushes — test assertion hook. Reset between tests. */
export const mockInventorySetCalls: { inventoryItemId: string; locationId: string; onHand: number }[] = [];
/** Recorded price pushes — test assertion hook. */
export const mockPriceSetCalls: { productId: string; variantId: string; price: number; compareAt: number | null }[] = [];
/** SKUs the mock should report as not-found (test the unresolved path). */
export const mockUnresolvedSkus = new Set<string>();
/** SKUs the mock should report as ambiguous. */
export const mockAmbiguousSkus = new Set<string>();

export function resetMock(): void {
  mockInventorySetCalls.length = 0;
  mockPriceSetCalls.length = 0;
  mockUnresolvedSkus.clear();
  mockAmbiguousSkus.clear();
}

export const mockProvider: ChannelProvider = {
  async validate() {
    return {
      shop: { name: "Mock Store", myshopifyDomain: "mock-store.myshopify.com", currencyCode: "USD" },
      locations: [{ id: MOCK_LOCATION_ID, name: "Mock Location" }],
    };
  },
  async findVariantBySku(_creds, sku): Promise<VariantLookup> {
    if (mockUnresolvedSkus.has(sku)) return { kind: "none" };
    if (mockAmbiguousSkus.has(sku)) return { kind: "ambiguous", count: 2 };
    return {
      kind: "unique",
      match: {
        externalVariantId: `gid://shopify/ProductVariant/${sku}`,
        externalInventoryItemId: `gid://shopify/InventoryItem/${sku}`,
        externalProductId: `gid://shopify/Product/${sku}`,
        sku,
      },
    };
  },
  async setInventory(_creds, inventoryItemId, locationId, onHand) {
    mockInventorySetCalls.push({ inventoryItemId, locationId, onHand });
    return { ok: true };
  },
  async setVariantPrice(_creds, productId, variantId, price, compareAt) {
    mockPriceSetCalls.push({ productId, variantId, price, compareAt });
    return { ok: true };
  },
  async registerWebhooks() {
    return { ok: true };
  },
  // Real crypto + parsing — so tests exercise production code.
  verifyWebhookHmac: shopifyProvider.verifyWebhookHmac,
  parseOrderPayload: shopifyProvider.parseOrderPayload,
  parseRefundPayload: shopifyProvider.parseRefundPayload,
};

/** Test helper: produce a valid Shopify X-Shopify-Hmac-Sha256 (base64) for a body+secret. */
export async function signWebhookBody(rawBody: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}
