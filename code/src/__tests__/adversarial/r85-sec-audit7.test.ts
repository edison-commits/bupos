/**
 * R85 / SEC-AUDIT7 — fixes from the deep multi-tenant + Workers audit.
 *
 *   CRIT1: /register "tap your name" exposed EVERY tenant's roster pre-auth
 *          and allowed anonymous no-PIN cross-tenant cashier takeover
 *          (getStoresWithRoster had no org filter). Now gated + scoped by a
 *          signed per-store token; clock-in is org-bound.
 *   HIGH1: manager-approval DOLLAR ceiling (approved_amount) was enforced
 *          only in checkout-action — offline-sync + cash-drawer checked
 *          approval PRESENCE only, so a small approval unlocked unlimited
 *          discount / price-override / store-credit / cash pay-out.
 *   HIGH2: register-logout + failed-admin-login audit writes were detached
 *          promises, silently dropped on Workers — now via waitUntilOrAwait.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signRegisterStoreToken, verifyRegisterStoreToken } from "@/lib/auth/device-cookie";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("SEC-AUDIT7-CRIT1: per-store register token closes the cross-tenant roster", () => {
  it("token round-trips and rejects forgery / payload-swap", async () => {
    const orgA = "11111111-1111-4111-8111-111111111111";
    const tokenA = await signRegisterStoreToken(orgA);
    expect(await verifyRegisterStoreToken(tokenA)).toBe(orgA);
    expect(await verifyRegisterStoreToken("garbage")).toBeNull();
    expect(await verifyRegisterStoreToken(orgA)).toBeNull(); // no prefix/tag
    // Keep orgA's HMAC tag but swap the org id in the payload → forgery.
    const tag = tokenA.split(".")[2];
    expect(await verifyRegisterStoreToken(`rs1.99999999-9999-4999-8999-999999999999.${tag}`)).toBeNull();
  });

  it("getStoresWithRoster is org-scoped (no more global roster)", () => {
    const src = read("src/app/register/page.tsx");
    expect(src).toMatch(/async function getStoresWithRoster\(orgId: string\)/);
    expect(src).toMatch(/AND l\.organization_id = \$1::uuid/);
    // The page only renders a roster when a valid token resolves an org.
    expect(src).toMatch(/verifyRegisterStoreToken/);
    expect(src).toMatch(/session \|\| !tokenOrgId \? \[\] : await getStoresWithRoster\(tokenOrgId\)/);
  });

  it("clockInAction verifies the store token and binds the clock-in to its org", () => {
    const src = read("src/app/register/actions.ts");
    expect(src).toMatch(/verifyRegisterStoreToken/);
    expect(src).toMatch(/if \(!tokenOrgId\)/);
    expect(src).toMatch(/signInRegisterByEmployee\(employeeId, locationId, tokenOrgId,/);
  });

  it("signInRegisterByEmployee requires + enforces expectedOrgId in the query", () => {
    const src = read("src/lib/auth/session.ts");
    expect(src).toMatch(/expectedOrgId: string,/);
    expect(src).toMatch(/AND e\.organization_id = \$3::uuid/);
    expect(src).toMatch(/\[employeeId, locationId, expectedOrgId\]/);
  });

  it("the minting route is manager-gated", () => {
    const src = read("src/app/api/register-terminal-link/route.ts");
    expect(src).toMatch(/withAdminAuth\("employee\.manage"/);
    expect(src).toMatch(/signRegisterStoreToken\(ctx\.orgId\)/);
  });
});

describe("SEC-AUDIT7-HIGH1: manager-approval dollar ceiling enforced off the online path", () => {
  it("offline-sync reads approved_amount and gates all three amount-scoped types", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    expect(src).toMatch(/SELECT exception_code, approved_amount FROM register_session_exceptions/);
    expect(src).toMatch(/const amountApprovedFor = \(code: string, applied: number\)/);
    expect(src).toMatch(/amountApprovedFor\("price_override", Math\.abs\(serverPrice - item\.overridePrice\)\)/);
    expect(src).toMatch(/amountApprovedFor\("discount_threshold", discountTotal\)/);
    expect(src).toMatch(/amountApprovedFor\("store_credit_threshold", storeCreditTendered\)/);
  });

  it("cash-drawer pay-out + pay-in consume bind to approved_amount", () => {
    const src = read("src/app/api/cash-drawer/route.ts");
    const matches = src.match(/AND \(approved_amount IS NULL OR \$3::numeric <= approved_amount \+ 0\.01\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // pay-out + pay-in
  });
});

describe("SEC-AUDIT7-HIGH2: dropped audit writes now survive on Workers", () => {
  it("register-logout audit is wrapped in waitUntilOrAwait", () => {
    const src = read("src/app/register/actions.ts");
    expect(src).toMatch(/await waitUntilOrAwait\(\s*rpcInsertAudit\([\s\S]*?register_logout/);
  });
  it("failed-admin-login audit is wrapped in waitUntilOrAwait", () => {
    const src = read("src/app/actions/auth.ts");
    expect(src).toMatch(/await waitUntilOrAwait\(\s*insertAudit\([\s\S]*?admin_login_failed/);
  });
});
