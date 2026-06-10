import "server-only";
import { safeErr } from "@/lib/logging/safe-err";
import type {
  ChannelProvider,
  ChannelCredentials,
  ChannelLocation,
  OpResult,
  ParsedOrder,
  ShopInfo,
  VariantLookup,
} from "./types";

// Pin the Admin API version (bump deliberately; Shopify supports ~1yr windows).
const API_VERSION = "2025-01";
// Scopes the custom-app token must be granted (surfaced in the connect UI).
export const REQUIRED_SHOPIFY_SCOPES = [
  "read_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_orders",
];

function endpoint(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
}

interface GqlResult<T> { data?: T; errors?: unknown; userErrorsTop?: unknown }

async function gql<T>(creds: ChannelCredentials, query: string, variables?: Record<string, unknown>): Promise<GqlResult<T>> {
  try {
    const res = await fetch(endpoint(creds.shopDomain), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": creds.accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { errors: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) return { errors: json.errors };
    return { data: json.data };
  } catch (err) {
    console.error("[channels/shopify] gql error:", safeErr(err));
    return { errors: "network" };
  }
}

function base64Std(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function constantTimeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const shopifyProvider: ChannelProvider = {
  async validate(creds): Promise<{ shop: ShopInfo; locations: ChannelLocation[] }> {
    const q = `query {
      shop { name myshopifyDomain currencyCode }
      locations(first: 50) { edges { node { id name } } }
    }`;
    const r = await gql<{
      shop: { name: string; myshopifyDomain: string; currencyCode: string };
      locations: { edges: { node: { id: string; name: string } }[] };
    }>(creds, q);
    if (!r.data?.shop) throw new Error(typeof r.errors === "string" ? r.errors : "Shopify validation failed");
    return {
      shop: {
        name: r.data.shop.name,
        myshopifyDomain: r.data.shop.myshopifyDomain,
        currencyCode: r.data.shop.currencyCode,
      },
      locations: (r.data.locations?.edges ?? []).map((e) => ({ id: e.node.id, name: e.node.name })),
    };
  },

  async findVariantBySku(creds, sku): Promise<VariantLookup> {
    const q = `query($q: String!) {
      productVariants(first: 5, query: $q) {
        edges { node { id sku inventoryItem { id } } }
      }
    }`;
    // Quote the SKU to avoid query-syntax surprises with special chars.
    const r = await gql<{ productVariants: { edges: { node: { id: string; sku: string; inventoryItem: { id: string } } }[] } }>(
      creds,
      q,
      { q: `sku:'${sku.replace(/'/g, "")}'` },
    );
    const edges = (r.data?.productVariants?.edges ?? []).filter((e) => e.node.sku === sku);
    if (edges.length === 0) return { kind: "none" };
    if (edges.length > 1) return { kind: "ambiguous", count: edges.length };
    const node = edges[0].node;
    return {
      kind: "unique",
      match: { externalVariantId: node.id, externalInventoryItemId: node.inventoryItem.id, sku: node.sku },
    };
  },

  async setInventory(creds, inventoryItemId, shopifyLocationId, onHand): Promise<OpResult> {
    const m = `mutation($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { field message } }
    }`;
    const r = await gql<{ inventorySetQuantities: { userErrors: { field: string[]; message: string }[] } }>(creds, m, {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        referenceDocumentUri: `bupos://inventory-sync/${Math.floor(onHand)}`,
        quantities: [{ inventoryItemId, locationId: shopifyLocationId, quantity: Math.max(0, Math.floor(onHand)) }],
      },
    });
    if (r.errors) return { ok: false, error: typeof r.errors === "string" ? r.errors : "graphql error" };
    const ue = r.data?.inventorySetQuantities?.userErrors ?? [];
    if (ue.length) return { ok: false, error: ue.map((e) => e.message).join("; ") };
    return { ok: true };
  },

  async registerOrderWebhook(creds, callbackUrl): Promise<OpResult> {
    const m = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`;
    const r = await gql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(creds, m, {
      topic: "ORDERS_CREATE",
      sub: { callbackUrl, format: "JSON" },
    });
    if (r.errors) return { ok: false, error: typeof r.errors === "string" ? r.errors : "graphql error" };
    const ue = r.data?.webhookSubscriptionCreate?.userErrors ?? [];
    // A duplicate subscription is not an error for our purposes.
    const fatal = ue.filter((e) => !/already (been )?taken|exists/i.test(e.message));
    if (fatal.length) return { ok: false, error: fatal.map((e) => e.message).join("; ") };
    return { ok: true };
  },

  async verifyWebhookHmac(rawBody, hmacHeader, webhookSecret): Promise<boolean> {
    if (!hmacHeader || !webhookSecret) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
    const computed = base64Std(sig); // Shopify sends standard base64
    return constantTimeEqStr(computed, hmacHeader.trim());
  },

  parseOrderPayload(rawBody): ParsedOrder | null {
    try {
      const o = JSON.parse(rawBody) as {
        id?: number | string;
        admin_graphql_api_id?: string;
        name?: string;
        order_number?: number | string;
        financial_status?: string;
        currency?: string;
        subtotal_price?: string;
        total_price?: string;
        line_items?: { sku?: string; quantity?: number; title?: string; variant_id?: number | string; price?: string }[];
      };
      const externalOrderId = String(o.admin_graphql_api_id ?? o.id ?? "");
      if (!externalOrderId) return null;
      return {
        externalOrderId,
        orderNumber: o.name ?? (o.order_number != null ? String(o.order_number) : null),
        financialStatus: o.financial_status ?? null,
        currency: o.currency ?? null,
        subtotal: o.subtotal_price != null ? Number(o.subtotal_price) : null,
        total: o.total_price != null ? Number(o.total_price) : null,
        lines: (o.line_items ?? []).map((l) => ({
          sku: l.sku && l.sku.trim() ? l.sku.trim() : null,
          quantity: Number(l.quantity ?? 0),
          title: l.title ?? "",
          externalVariantId: l.variant_id != null ? String(l.variant_id) : null,
          price: l.price != null ? Number(l.price) : null,
        })),
      };
    } catch {
      return null;
    }
  },
};
