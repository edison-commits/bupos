/**
 * R91 — Online Selling (Shopify channel) security invariants (source-grep,
 * matching the existing rNN-findings style). These guard the design the
 * security patterns depend on; the runtime crypto/HMAC/parse logic is covered
 * by src/__tests__/channels/shopify-channel.test.ts.
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

describe("R91: migration 088 hardening", () => {
  const src = read("supabase/migrations/088_channel_integrations.sql");
  it("forces RLS on the new tables and ships the SECDEF resolver RPCs", () => {
    expect(src).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_channel_by_shop_domain/);
    expect(src).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
    expect(src).toMatch(/REVOKE EXECUTE ON FUNCTION public\.resolve_channel_by_shop_domain\(text\) FROM PUBLIC, anon, authenticated/);
  });
});
