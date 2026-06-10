/**
 * R91 — Online Selling (Shopify channel) security invariants (source-grep,
 * matching the existing rNN-findings style). These guard the design the
 * security patterns depend on; the runtime crypto/HMAC/parse logic is covered
 * by src/__tests__/runtime/shopify-channel.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R91: channel secrets are encrypted + write-only", () => {
  it("crypto reads CHANNEL_ENC_KEY with a fail-closed getSecret (throws on Workers/prod)", () => {
    const src = read("src/lib/channels/crypto.ts");
    expect(src).toMatch(/process\.env\.CHANNEL_ENC_KEY/);
    expect(src).toMatch(/process\.env\.NODE_ENV === "production" \|\| isWorkersRuntime\(\)/);
    expect(src).toMatch(/throw new Error/);
  });
  it("the masked config GET exposes only a boolean, never the token", () => {
    const src = read("src/app/api/channels/shopify/config/route.ts");
    expect(src).toMatch(/has_token: !!row\.access_token_ciphertext/); // masked boolean
    expect(src).not.toContain("accessToken"); // config never decrypts the token
    // The ciphertext is only ever an SQL bind target, never a JSON response field.
    expect(src).not.toMatch(/access_token_ciphertext\s*:/);
  });
});

describe("R91: the public webhook is HMAC-authenticated, not cookie/Origin", () => {
  const src = read("src/app/api/channels/shopify/webhook/route.ts");
  it("reads the RAW body and verifies the HMAC before any DB write", () => {
    expect(src).toMatch(/await req\.text\(\)/);
    expect(src).toMatch(/verifyWebhookHmac/);
  });
  it("does NOT call checkOrigin (machine-to-machine has no Origin)", () => {
    expect(src).not.toMatch(/checkOrigin\(/); // the call, not the explanatory comment
  });
  it("resolves the tenant via the SECDEF RPC, not a raw cross-org select", () => {
    expect(src).toMatch(/resolve_channel_by_shop_domain/);
  });
  it("dedups replays on the Shopify webhook id", () => {
    expect(src).toMatch(/x-shopify-webhook-id/);
    expect(src).toMatch(/ON CONFLICT \(channel_integration_id, webhook_id\) DO NOTHING/);
  });
});

describe("R91: order intake correctness", () => {
  it("resolveSkus filters is_active (SKU is unique only among active variants)", () => {
    expect(read("src/lib/channels/repo.ts")).toMatch(/sku = \$2 AND is_active = true/);
  });
  it("the online decrement reuses the clamped checkout pattern with reason online_sale", () => {
    const src = read("src/lib/channels/repo.ts");
    expect(src).toMatch(/GREATEST\(0, il\.on_hand \+ delta\.qty\)/);
    expect(src).toMatch(/'online_sale'/);
  });
});

describe("R91: the reconcile endpoint is Bearer-gated, fail-closed, constant-time", () => {
  const src = read("src/app/api/internal/reconcile-channels/route.ts");
  it("fails closed if the secret is unset / <32 chars and compares constant-time", () => {
    expect(src).toMatch(/secret\.length < 32/);
    expect(src).toMatch(/function bearerMatches/);
    expect(src).toMatch(/diff \|= a\[i\] \^ b\[i\]/);
  });
  it("lists tenants via the SECDEF RPC", () => {
    expect(src).toMatch(/list_connected_channels/);
  });
});

describe("R91-P2: price sync (POS authoritative)", () => {
  it("the provider sets prices via productVariantsBulkUpdate + requires write_products", () => {
    const src = read("src/lib/channels/shopify.ts");
    expect(src).toMatch(/setVariantPrice/);
    expect(src).toMatch(/productVariantsBulkUpdate/);
    expect(src).toMatch(/write_products/);
  });
  it("pushPrices skips no-ops, tracks last_pushed_price, and backfills the product GID", () => {
    const src = read("src/lib/channels/repo.ts");
    expect(src).toMatch(/export async function pushPrices/);
    expect(src).toMatch(/last_pushed_price/);
    expect(src).toMatch(/Backfill the product GID/);
  });
  it("the reconcile diff also catches price edits (product_variants.updated_at)", () => {
    expect(read("src/lib/channels/repo.ts")).toMatch(/pv\.updated_at > \$4::timestamptz/);
  });
  it("migration 089 adds sync_prices + the price/product columns", () => {
    const src = read("supabase/migrations/089_channel_price_sync.sql");
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS sync_prices boolean NOT NULL DEFAULT true/);
    expect(src).toMatch(/last_pushed_price numeric/);
    expect(src).toMatch(/external_product_id text/);
  });
});

describe("R91-P3a: refund restock / cancel / uninstall", () => {
  it("the provider registers all four webhook topics", () => {
    const src = read("src/lib/channels/shopify.ts");
    expect(src).toMatch(/ORDERS_CREATE/);
    expect(src).toMatch(/REFUNDS_CREATE/);
    expect(src).toMatch(/ORDERS_CANCELLED/);
    expect(src).toMatch(/APP_UNINSTALLED/);
  });
  it("parseRefundPayload restocks only what Shopify restocked (skips no_restock)", () => {
    expect(read("src/lib/channels/shopify.ts")).toMatch(/restock_type !== "no_restock"/);
  });
  it("the restock helper uses a positive delta with reason online_refund", () => {
    const src = read("src/lib/channels/repo.ts");
    expect(src).toMatch(/export async function applyOnlineRestock/);
    expect(src).toMatch(/'online_refund'/);
    expect(src).toMatch(/il\.on_hand \+ delta\.qty/); // additive, not GREATEST(0, …) decrement
  });
  it("the webhook route branches on topic and disconnects on app/uninstalled", () => {
    const src = read("src/app/api/channels/shopify/webhook/route.ts");
    expect(src).toMatch(/x-shopify-topic/);
    expect(src).toMatch(/app\/uninstalled/);
    expect(src).toMatch(/status = 'disconnected'/);
    expect(src).toMatch(/applyOnlineRestock/);
    expect(src).toMatch(/orders\/cancelled/);
  });
});

describe("R91-P3b: online sales report stays separate from in-store transactions", () => {
  it("the report query reads online_orders (not the transactions table)", () => {
    const src = read("src/lib/channels/repo.ts");
    expect(src).toMatch(/export async function getOnlineSalesReport/);
    expect(src).toMatch(/FROM online_orders/);
    // The channel repo must never reach into the in-store money table.
    expect(src).not.toMatch(/FROM transactions\b/);
  });
  it("the orders route is permission-gated and org-scoped", () => {
    const src = read("src/app/api/channels/shopify/orders/route.ts");
    expect(src).toMatch(/withAdminAuth\("online\.manage"/);
    expect(src).toMatch(/getOnlineSalesReport/);
  });
});

describe("R91-P3c: product publishing", () => {
  it("the provider creates products via productCreate + productVariantsBulkCreate", () => {
    const src = read("src/lib/channels/shopify.ts");
    expect(src).toMatch(/productCreate/);
    expect(src).toMatch(/productVariantsBulkCreate/);
  });
  it("publishing requires read/write_publications scopes (publish to Online Store)", () => {
    const src = read("src/lib/channels/shopify.ts");
    expect(src).toMatch(/read_publications/);
    expect(src).toMatch(/write_publications/);
  });
  it("publishProducts maps created variants back into channel_product_map", () => {
    const src = read("src/lib/channels/repo.ts");
    expect(src).toMatch(/export async function publishProducts/);
    expect(src).toMatch(/INSERT INTO channel_product_map/);
    expect(src).toMatch(/export async function listPublishableProducts/);
  });
  it("the publish route is permission-gated, rate-limited, and validates product ids", () => {
    const src = read("src/app/api/channels/shopify/publish/route.ts");
    expect(src).toMatch(/withAdminAuth\("online\.manage"/);
    expect(src).toMatch(/checkRateLimit/);
    expect(src).toMatch(/UUID_RE/);
  });
});

describe("R91: migration 088 hardening", () => {
  const src = read("supabase/migrations/088_channel_integrations.sql");
  it("forces RLS on the new tables and ships the SECDEF resolver RPCs", () => {
    expect(src).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_channel_by_shop_domain/);
    expect(src).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
    expect(src).toMatch(/REVOKE EXECUTE ON FUNCTION public\.resolve_channel_by_shop_domain\(text\) FROM PUBLIC, anon, authenticated/);
  });
});
