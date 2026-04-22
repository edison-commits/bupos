/**
 * R37 regression tests. Pins the follow-up fixes to R36 — client/server
 * contract gaps, admin refund math parity with the register path,
 * offline-sync 403 terminal handling, and observability for step-up 4xx.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R37 findings", () => {
  describe("R37-H1: customers PUT step-up gate compares old↔new, not mere presence", () => {
    const src = read("src/app/api/customers/route.ts");
    it("reads the current customer row before deciding whether to gate", () => {
      expect(src).toMatch(/SELECT is_active, notes FROM customers WHERE id = \$1/);
    });
    it("fires step-up only when is_active or notes actually change", () => {
      // The earlier shape used `is_active !== undefined || (notes !== undefined && ...)`
      // which 400'd EVERY edit because the admin UI always sends `notes`. The new
      // shape compares to `current.is_active` / `current.notes`.
      expect(src).toMatch(/Boolean\(is_active\) !== Boolean\(current\.is_active\)/);
      expect(src).toMatch(/normNotes\(notes\) !== normNotes\(current\.notes\)/);
    });
  });

  describe("R37-H2: admin refund paths include modifier upcharges + correct denominator", () => {
    it("/api/returns/process tracks paidModifierTotal + uses origTaxableBase", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/paidModifierTotal/);
      expect(src).toMatch(/const origTaxableBase = origSubtotal \+ origModifiersTotal/);
      expect(src).toMatch(/weightedModifierUnit/);
      // Denominators switched from origSubtotal → origTaxableBase
      expect(src).toMatch(/1 - origDiscount \/ origTaxableBase/);
      expect(src).toMatch(/origTaxTotal \/ origTaxableBase/);
    });
    it("/api/returns POST tracks paidModifierTotal + uses origTaxableBase", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/paidModifierTotal/);
      expect(src).toMatch(/const origTaxableBase = origSubtotal \+ origModifiersTotal/);
      // The refund multiplier now adds weightedModifierUnit
      expect(src).toMatch(/\(orig\.unitPrice \+ weightedModifierUnit\) \* paidShare/);
    });
  });

  describe("R37-H3: gift-card disable server action now requires step-up", () => {
    const action = read("src/app/admin/gift-card-actions.ts");
    const ui = read("src/components/admin/gift-card-manager.tsx");
    it("action signature accepts actorPassword", () => {
      expect(action).toMatch(/disableGiftCardAction\([\s\S]*?actorPassword\?: string/);
    });
    it("action calls requireStepUp with the gift-card-disable bucket", () => {
      expect(action).toMatch(/gift-card-disable-stepup/);
    });
    it("action returns a structured result (not throw) on step-up failure", () => {
      expect(action).toMatch(/return \{ success: false, error: stepUp\.error \}/);
    });
    it("UI prompts for password before calling the action", () => {
      expect(ui).toMatch(/window\.prompt\(/);
      expect(ui).toMatch(/disableGiftCardAction\(gc\.id, pwd\)/);
    });
  });

  describe("R37-H4: offline-sync 403 is terminal, not retried", () => {
    const svc = read("src/lib/offline/sync-service.ts");
    const bar = read("src/components/register/offline-status-bar.tsx");
    it("sync-service treats 403 as terminal (bumps attempts to MAX)", () => {
      expect(svc).toMatch(/res\.status === 403/);
      expect(svc).toMatch(/attempts: MAX_RETRY_ATTEMPTS[\s\S]*?Server refused/);
    });
    it("offline-status-bar surfaces dead-letter errors separately from retry-failed", () => {
      expect(bar).toMatch(/result\.deadLetters\.length > 0/);
      expect(bar).toMatch(/can't be synced/);
    });
  });

  describe("R37-M1: with-auth logs 4xx responses for alerting", () => {
    const src = read("src/lib/api/with-auth.ts");
    it("emits api_route_client_error event for 400-499 responses", () => {
      expect(src).toMatch(/event: "api_route_client_error"/);
      expect(src).toMatch(/res\.status >= 400 && res\.status < 500/);
    });
    it("inferStepUpBucket helper maps known routes to bucket names", () => {
      expect(src).toMatch(/function inferStepUpBucket\(pathname: string\)/);
      expect(src).toMatch(/gift-card-\*-stepup/);
      expect(src).toMatch(/customer-update-stepup/);
    });
    it("withDualAuth also logs 4xx (not just withAdminAuth)", () => {
      // Both branches should include the client-error emission.
      const matches = src.match(/event: "api_route_client_error"/g) ?? [];
      expect(matches.length).toBe(2);
    });
  });

  describe("R37-M2: deploy.yml typechecks on master push", () => {
    const wf = read("../.github/workflows/deploy.yml");
    it("has a Typecheck step gated on master push", () => {
      expect(wf).toMatch(/- name: Typecheck[\s\S]*?npx tsc --noEmit/);
      // The step should be gated on master + push (same condition as the others)
      const block = wf.slice(wf.indexOf("- name: Typecheck"), wf.indexOf("- name: Build & Deploy"));
      expect(block).toMatch(/github\.ref == 'refs\/heads\/master' && github\.event_name == 'push'/);
    });
  });

  describe("R37-M3: runbook-rollback.md exists and runbook-deploy.md is refreshed", () => {
    it("runbook-rollback.md exists with worker + migration rollback sections", () => {
      const rb = read("docs/runbook-rollback.md");
      expect(rb).toMatch(/Worker-only rollback/);
      expect(rb).toMatch(/npx wrangler rollback/);
      expect(rb).toMatch(/Migration rollback/);
      // At least the R30-R36 migrations get explicit reverse SQL
      expect(rb).toMatch(/DROP INDEX IF EXISTS idx_transactions_org_loc_created_completed/);
    });
    it("runbook-deploy.md drops the stale `supabase db push` line + points at the workflow", () => {
      const rb = read("docs/runbook-deploy.md");
      expect(rb).toMatch(/Source of truth: the GitHub Actions workflow/);
      // The stale `supabase db push` prescription should be gone
      expect(rb).not.toMatch(/^supabase db push$/m);
    });
  });

  describe("R37-M4: step-up audit swallow now emits structured log", () => {
    const src = read("src/lib/auth/step-up.ts");
    it("emits audit_insert_failed event instead of silent catch", () => {
      expect(src).toMatch(/event: 'audit_insert_failed'/);
      expect(src).toMatch(/surface: 'step_up_verified'/);
    });
    it("no leftover empty catch {} around the audit write", () => {
      // The outer catch still exists but now logs; the inner .catch() also logs.
      const auditBlock = src.slice(src.indexOf("step_up_verified"));
      expect(auditBlock).not.toMatch(/\.catch\(\(\) => \{\s*\/\/ Non-fatal/);
    });
  });
});
