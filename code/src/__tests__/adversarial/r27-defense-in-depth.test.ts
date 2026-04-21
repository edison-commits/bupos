/**
 * R27 regression: defense-in-depth sweep.
 *
 * Covers the non-chain-A / non-chain-B findings from the R27 audit:
 *   • H5 fork-PR secret risk in pre-merge-audit.yml
 *   • H7 BroadcastChannel trust on customer-display
 *   • M7 silent PIN reset by compromised manager session
 *   • M11 customer_display_state .passthrough() XSS footgun
 *   • M12 return_lines.unit_price report pollution
 *   • M13 stale display-token after session close
 *   • M14 deploy.yml psql filename injection + Telegram token leak
 *   • L1 KV rate-limiter fail-closed for admin-login
 *   • L3 CUSTOMER_DISPLAY_SECRET dev fallback derived from DATABASE_URL
 *   • L4 per-email signup rate limit
 *   • L6 ACAC coupled to ACAO
 *   • L9 countedQty overflow
 *
 * Each assertion pins a specific line of defense so a refactor that
 * reopens the finding fails CI.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("R27 defense-in-depth regressions", () => {
  describe("H5 — pre-merge-audit.yml fork-PR gate", () => {
    const src = read("../.github/workflows/pre-merge-audit.yml");

    it("audit job runs only on same-repo PRs or workflow_dispatch", () => {
      // Without this gate, a fork PR can exfiltrate ANTHROPIC_API_KEY
      // via a modified scripts/pre-merge-audit.mjs since the secret
      // is injected into env.
      expect(src).toMatch(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
      // Manual runs (no PR context) pass through.
      expect(src).toMatch(/github\.event_name == 'workflow_dispatch'/);
    });
  });

  describe("H7 — BroadcastChannel payload validation", () => {
    it("customer-display/page.tsx validates every message", () => {
      const src = read("src/app/customer-display/page.tsx");
      expect(src).toMatch(/displayMessageSchema\.safeParse/);
    });

    it("register/customer-display client validates every message", () => {
      const src = read("src/app/register/customer-display/customer-display-client.tsx");
      expect(src).toMatch(/displayMessageSchema\.safeParse/);
    });

    it("shared schema uses discriminatedUnion + no passthrough call sites", () => {
      const src = read("src/lib/validation/display-message.ts");
      expect(src).toMatch(/discriminatedUnion\("type"/);
      // Strip the block-comment header so we don't match the prose
      // that mentions `.passthrough()` as context. The regex targets
      // only actual method-invocation syntax.
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(noComments).not.toMatch(/\.passthrough\(\)/);
    });
  });

  describe("M7 — PIN-reset step-up auth + notification", () => {
    const src = read("src/app/api/employees/route.ts");
    const schemaSrc = read("src/lib/validation/schemas.ts");

    it("employeePatchSchema accepts actorPassword", () => {
      expect(schemaSrc).toMatch(/actorPassword: z\.string\(\)/);
    });

    it("reset_pin requires actor to re-enter their own password", () => {
      expect(src).toMatch(/verifySecret\(actorPassword, actorHash\)/);
    });

    it("reset_pin sends notification email to the target employee", () => {
      expect(src).toMatch(/Your BasicUniformPOS PIN was reset/);
      expect(src).toMatch(/register PIN was just reset by/);
    });
  });

  describe("M11 — customer_display schemas are .strict()", () => {
    const src = read("src/lib/validation/schemas.ts");

    it("displayCartLine is .strict()", () => {
      // Find the displayCartLine block and verify strict.
      const start = src.indexOf("const displayCartLine");
      expect(start).toBeGreaterThan(-1);
      const block = src.slice(start, start + 500);
      expect(block).toMatch(/\}\)\.strict\(\);/);
      expect(block).not.toMatch(/\.passthrough\(\)/);
    });

    it("displayTotals is .strict()", () => {
      const start = src.indexOf("const displayTotals");
      expect(start).toBeGreaterThan(-1);
      const block = src.slice(start, start + 400);
      expect(block).toMatch(/\}\)\.strict\(\);/);
    });

    it("customerDisplaySchema cart is .strict()", () => {
      const start = src.indexOf("customerDisplaySchema");
      expect(start).toBeGreaterThan(-1);
      const block = src.slice(start, start + 600);
      expect(block).toMatch(/\}\)\.strict\(\)/);
    });
  });

  describe("M12 — return_lines.unit_price server-authoritative", () => {
    it("INSERT INTO return_lines uses origUnitPrice not line.unit_price", () => {
      const src = read("src/app/api/returns/route.ts");
      // The INSERT should reference `origUnitPrice`, NOT `line.unit_price`.
      const insertStart = src.indexOf("INSERT INTO return_lines");
      expect(insertStart).toBeGreaterThan(-1);
      const window = src.slice(Math.max(0, insertStart - 600), insertStart + 500);
      expect(window).toMatch(/origUnitPrice/);
    });
  });

  describe("M13 — display token rejects closed sessions", () => {
    it("authorizeDisplayToken gates on status='active'", () => {
      const src = read("src/app/api/customer-display/route.ts");
      expect(src).toMatch(
        /FROM register_sessions[\s\S]*?WHERE id = \$1 AND status = 'active'/,
      );
    });
  });

  describe("M14 — deploy.yml migration + Telegram hardening", () => {
    const src = read("../.github/workflows/deploy.yml");

    it("validates migration filename pattern before interpolation", () => {
      expect(src).toMatch(/\^\[0-9\]\{3\}_\[a-z0-9_\]\+\\\.sql\$/);
    });

    it("uses psql parameter binding (-v / :'mig') not string concatenation", () => {
      // Without param binding, a malicious migration filename containing
      // ';DROP TABLE _migrations;--.sql would execute arbitrary SQL.
      expect(src).toMatch(/-v mig="\$basename"/);
      expect(src).toMatch(/:'mig'/);
    });

    it("Telegram bot token read from env, not shell-interpolated", () => {
      // Env-var form prevents GH-Actions-level substitution into the
      // shell line (classic exfiltration vector). Must contain both
      // notify steps with TELEGRAM_BOT_TOKEN in env:.
      const successStart = src.indexOf("Notify on success");
      expect(successStart).toBeGreaterThan(-1);
      const block = src.slice(successStart, successStart + 800);
      expect(block).toMatch(/TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/);
      expect(block).toMatch(/\$\{TELEGRAM_BOT_TOKEN\}/);
    });
  });

  describe("L1 — admin-login has the DB rate-limit layer", () => {
    it("/api/auth/login calls checkDbRateLimit", () => {
      const src = read("src/app/api/auth/login/route.ts");
      expect(src).toMatch(/checkDbRateLimit\([^)]*admin-login:/);
    });
  });

  describe("L3 — display-token dev fallback not derived from DATABASE_URL", () => {
    it("getSecret fallback does NOT reference DATABASE_URL", () => {
      const src = read("src/lib/auth/display-token.ts");
      const fnStart = src.indexOf("function getSecret");
      expect(fnStart).toBeGreaterThan(-1);
      const body = src.slice(fnStart, fnStart + 800);
      expect(body).not.toMatch(/DATABASE_URL/);
    });
  });

  describe("L4 — per-email signup rate limit", () => {
    it("signupAction adds a per-email bucket", () => {
      const src = read("src/app/actions/auth.ts");
      expect(src).toMatch(/signup-email:\$\{email\}/);
    });
  });

  describe("L6 — ACAC coupled to ACAO", () => {
    it("middleware sets ACAC only when ACAO is set", () => {
      const src = read("middleware.ts");
      // Find the NON-preflight branch. The ACAC header should be inside
      // the `if (originAllowed)` block, not outside it.
      const branch = src.indexOf("originAllowed");
      expect(branch).toBeGreaterThan(-1);
      const window = src.slice(branch, branch + 600);
      expect(window).toMatch(/Access-Control-Allow-Credentials/);
      // After the coupled block, we should NOT set ACAC again
      // unconditionally.
      const afterIf = src.slice(branch + 600, branch + 1200);
      expect(afterIf).not.toMatch(/^\s*response\.headers\.set\('Access-Control-Allow-Credentials'/m);
    });
  });

  describe("L9 — countedQty sanity bound", () => {
    it("recordCountAction rejects countedQty > 10M", () => {
      const src = read("src/app/admin/stocktake-actions.ts");
      expect(src).toMatch(/countedQty > 10_000_000/);
    });
  });
});
