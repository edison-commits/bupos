/**
 * Thin sales-channel provider seam. Phase 1 has exactly one implementation
 * (Shopify) selected by `getChannelProvider()` in ./index.ts; the interface
 * exists so a future provider can be added without rewriting the routes — it
 * is deliberately NOT a plugin registry.
 */

export interface ChannelCredentials {
  shopDomain: string;
  accessToken: string;
  webhookSecret?: string;
}

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
}

export interface ChannelLocation {
  id: string; // Shopify location GID
  name: string;
}

export interface VariantMatch {
  externalVariantId: string;
  externalInventoryItemId: string;
  sku: string;
}

/** Discriminated result for a SKU lookup (Shopify SKUs aren't guaranteed unique). */
export type VariantLookup =
  | { kind: "unique"; match: VariantMatch }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

export interface OrderLine {
  sku: string | null;
  quantity: number;
  title: string;
  externalVariantId: string | null;
  price: number | null;
}

export interface ParsedOrder {
  externalOrderId: string;
  orderNumber: string | null;
  financialStatus: string | null;
  currency: string | null;
  subtotal: number | null;
  total: number | null;
  lines: OrderLine[];
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

export interface ChannelProvider {
  /** Validate the token + return shop identity and the shop's locations. */
  validate(creds: ChannelCredentials): Promise<{ shop: ShopInfo; locations: ChannelLocation[] }>;
  /** Resolve a SKU to its Shopify variant + inventory item (for the push map). */
  findVariantBySku(creds: ChannelCredentials, sku: string): Promise<VariantLookup>;
  /** Set the ABSOLUTE on_hand for an inventory item at a location (POS authoritative). */
  setInventory(
    creds: ChannelCredentials,
    inventoryItemId: string,
    shopifyLocationId: string,
    onHand: number,
  ): Promise<OpResult>;
  /** Register the orders/create webhook pointing at our public endpoint. */
  registerOrderWebhook(creds: ChannelCredentials, callbackUrl: string): Promise<OpResult>;
  /** Constant-time verify a webhook HMAC computed over the RAW request body. */
  verifyWebhookHmac(rawBody: string, hmacHeader: string | null, webhookSecret: string): Promise<boolean>;
  /** Parse an orders/create payload into normalized line items. */
  parseOrderPayload(rawBody: string): ParsedOrder | null;
}
