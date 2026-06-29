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
  externalProductId: string; // productVariantsBulkUpdate needs the product GID
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

export interface ParsedRefund {
  externalOrderId: string; // the parent order GID
  /** Lines Shopify restocked (restock_type != no_restock) → restock in BuPOS. */
  restockLines: { sku: string; quantity: number }[];
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

/** One variant to publish: SKU, pricing, its option coordinates, and seed stock. */
export interface PublishVariantInput {
  sku: string;
  price: number;
  compareAtPrice: number | null;
  /** Maps this variant to the product's options, e.g. [{optionName:"Size", name:"M"}]. */
  optionValues: { optionName: string; name: string }[];
  onHand: number;
}
/** A whole BuPOS product to create on Shopify as one product with its variants. */
export interface PublishProductInput {
  title: string;
  descriptionHtml: string | null;
  status: "ACTIVE" | "DRAFT";
  /** Product options (e.g. Size, Color) with their full value lists. */
  options: { name: string; values: string[] }[];
  variants: PublishVariantInput[];
  shopifyLocationId: string;
}
export interface PublishedVariant {
  sku: string;
  externalVariantId: string;
  externalInventoryItemId: string;
  externalProductId: string;
}
export interface PublishResult {
  ok: boolean;
  error?: string;
  externalProductId?: string;
  variants?: PublishedVariant[];
  /** Non-fatal issues (e.g. couldn't publish to the Online Store channel). */
  warnings?: string[];
}

export interface ChannelProvider {
  /** Validate the token + return shop identity and the shop's locations. */
  validate(creds: ChannelCredentials): Promise<{ shop: ShopInfo; locations: ChannelLocation[] }>;
  /** Resolve a SKU to its Shopify variant + inventory item (for the push map). */
  findVariantBySku(creds: ChannelCredentials, sku: string): Promise<VariantLookup>;
  /** Read current available quantity from the channel for reconciliation. */
  getInventoryQuantity(
    creds: ChannelCredentials,
    inventoryItemId: string,
    shopifyLocationId: string,
  ): Promise<{ ok: boolean; quantity?: number; error?: string }>;
  /** Set the ABSOLUTE on_hand for an inventory item at a location (POS authoritative). */
  setInventory(
    creds: ChannelCredentials,
    inventoryItemId: string,
    shopifyLocationId: string,
    onHand: number,
  ): Promise<OpResult>;
  /** Set a variant's price (+ optional compare-at) — POS is authoritative. */
  setVariantPrice(
    creds: ChannelCredentials,
    externalProductId: string,
    externalVariantId: string,
    price: number,
    compareAtPrice: number | null,
  ): Promise<OpResult>;
  /** Create a BuPOS product on the channel as a product with all its variants. */
  publishProduct(creds: ChannelCredentials, input: PublishProductInput): Promise<PublishResult>;
  /** Register all needed webhooks (orders/create, refunds/create, orders/cancelled, app/uninstalled). */
  registerWebhooks(creds: ChannelCredentials, callbackUrl: string): Promise<OpResult>;
  /** Constant-time verify a webhook HMAC computed over the RAW request body. */
  verifyWebhookHmac(rawBody: string, hmacHeader: string | null, webhookSecret: string): Promise<boolean>;
  /** Parse an orders/create payload into normalized line items. */
  parseOrderPayload(rawBody: string): ParsedOrder | null;
  /** Parse a refunds/create payload into the lines Shopify restocked. */
  parseRefundPayload(rawBody: string): ParsedRefund | null;
}
