/**
 * R95 / AUDIT11 — deep-audit hardening follow-ups.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("AUDIT11-1: offline-sync rejects unbacked value tenders", () => {
  const src = read("src/app/api/offline-sync/route.ts");

  it("loyalty and store-credit tenders require a customer before tender sufficiency", () => {
    expect(src).toMatch(/value-backed tenders must carry the server-verified/);
    expect(src).toMatch(/tt\.type === 'loyalty' \|\| tt\.type === 'store_credit'/);
    expect(src).toMatch(/typeof cart\.customerId !== 'string'/);
    expect(src).toMatch(/tender requires a customer/);
  });

  it("gift-card tenders require UUID gift_card_id metadata", () => {
    expect(src).toMatch(/tt\.type === 'gift_card'/);
    expect(src).toMatch(/metadata\?\.gift_card_id !== 'string'/);
    expect(src).toMatch(/!UUID_RE\.test\(metadata\.gift_card_id\)/);
    expect(src).toMatch(/Gift card tender requires gift_card_id metadata/);
  });

  it("transaction_tenders preserves tender metadata instead of dropping gift_card_id", () => {
    expect(src).toMatch(/const tenderMetas = tenders\.map\(\(t, i\) =>/);
    expect(src).toMatch(/\.\.\.t\.metadata/);
    expect(src).toMatch(/metadata\.change_due = changeDue\.toFixed\(2\)/);
  });
});

describe("AUDIT11-2: offline-sync id is validated as UUID", () => {
  it("offlineSyncSchema rejects arbitrary transaction ids before DB use", async () => {
    const { offlineSyncSchema } = await import("@/lib/validation/schemas");
    const base = { cart: {}, tenders: [], timestamp: new Date().toISOString() };
    expect(offlineSyncSchema.safeParse({ ...base, id: "not-a-uuid" }).success).toBe(false);
    expect(offlineSyncSchema.safeParse({ ...base, id: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });
});

describe("AUDIT11-3: public customer self-signup is abuse-hardened", () => {
  const src = read("src/app/api/customer-self-signup/route.ts");

  it("does not expose internal customer IDs in the public response", () => {
    expect(src).toMatch(/return NextResponse\.json\(\{ ok: true \}\)/);
    expect(src).not.toMatch(/return NextResponse\.json\(\{ ok: true, customerId/);
  });

  it("has body-size, origin, KV, and DB rate-limit layers", () => {
    expect(src).toMatch(/MAX_BODY_BYTES = 16 \* 1024/);
    expect(src).toMatch(/checkOrigin\(request\)/);
    expect(src).toMatch(/checkKvRateLimit\(bucket/);
    expect(src).toMatch(/checkDbRateLimit\(bucket/);
  });

  it("does not blind-update existing customers from unauthenticated submissions", () => {
    expect(src).toMatch(/const isExistingCustomer = lookup\.rows\.length > 0/);
    expect(src).toMatch(/if \(!isExistingCustomer\) \{/);
    expect(src).not.toMatch(/UPDATE customers\s+SET first_name/);
  });
});
