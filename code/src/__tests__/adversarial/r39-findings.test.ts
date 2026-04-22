/**
 * R39 regression tests. Pins the compliance / content-handling /
 * supply-chain findings from the R39 audit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeCsvCell, csvCell } from "@/lib/format/csv-sanitize";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R39 findings", () => {
  describe("R39-A1-1: customer anonymization (right-to-be-forgotten)", () => {
    const route = read("src/app/api/customers/route.ts");
    const mig = read("supabase/migrations/068_r39_compliance.sql");
    it("customers route has a DELETE handler", () => {
      expect(route).toMatch(/export const DELETE = withAdminAuth\('employee\.manage'/);
    });
    it("DELETE anonymizes in place (UPDATE, not DROP)", () => {
      expect(route).toMatch(/UPDATE customers\s+SET first_name = '\[deleted\]'/);
      // Email/phone/address/notes must go to NULL
      expect(route).toMatch(/email\s+= NULL/);
      expect(route).toMatch(/phone\s+= NULL/);
    });
    it("DELETE requires step-up + owner/manager role", () => {
      expect(route).toMatch(/bucketKey: 'customer-delete-stepup'/);
      expect(route).toMatch(/Manager authority required/);
    });
    it("DELETE blocks when customer has active layaways / store credit / gift cards", () => {
      expect(route).toMatch(/open_layaways/);
      expect(route).toMatch(/outstanding store credit/);
      expect(route).toMatch(/active gift card balances/);
    });
    it("migration 068 tightens customer FKs to RESTRICT (no cascade delete of financial history)", () => {
      expect(mig).toMatch(/store_credit_ledger_customer_id_fkey[\s\S]+?ON DELETE RESTRICT/);
      expect(mig).toMatch(/layaways_customer_id_fkey[\s\S]+?ON DELETE RESTRICT/);
    });
  });

  describe("R39-A1-2: audit events on tax / settings / promo mutations", () => {
    it("tax-config PUT writes tax_rate_changed audit event", () => {
      const src = read("src/app/api/tax-config/route.ts");
      expect(src).toMatch(/pgInsertAuditEvent/);
      expect(src).toMatch(/tax_rate_changed/);
      expect(src).toMatch(/prior_tax_rate/);
    });
    it("settings PUT writes settings_updated for store/location/receipt sections", () => {
      const src = read("src/app/api/settings/route.ts");
      expect(src).toMatch(/pgInsertAuditEvent/);
      const matches = src.match(/"settings_updated"/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
    it("promo-codes POST writes audit events on create + disable", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/promo_code_created/);
      expect(src).toMatch(/promo_code_disabled/);
    });
  });

  describe("R39-A1-3: session table cleanup + run_nightly_cleanup orchestrator", () => {
    const mig = read("supabase/migrations/068_r39_compliance.sql");
    it("cleanup_stale_sessions function exists", () => {
      expect(mig).toMatch(/CREATE OR REPLACE FUNCTION public\.cleanup_stale_sessions/);
      expect(mig).toMatch(/DELETE FROM sessions[\s\S]+?expires_at < NOW\(\) - p_grace/);
    });
    it("run_nightly_cleanup orchestrator now calls cleanup_stale_sessions", () => {
      expect(mig).toMatch(/public\.cleanup_stale_sessions\(\)/);
      expect(mig).toMatch(/'sessions_cleared'/);
    });
  });

  describe("R39-A1-4: /api/admin/health probes the audit-tamper triggers", () => {
    const route = read("src/app/api/admin/health/route.ts");
    const mig = read("supabase/migrations/068_r39_compliance.sql");
    it("migration 068 defines check_audit_triggers() helper", () => {
      expect(mig).toMatch(/CREATE OR REPLACE FUNCTION public\.check_audit_triggers\(\)/);
      expect(mig).toMatch(/trg_audit_events_no_update/);
      expect(mig).toMatch(/trg_audit_events_no_delete/);
      expect(mig).toMatch(/trg_audit_events_no_truncate/);
    });
    it("admin/health route calls check_audit_triggers + reports status", () => {
      expect(route).toMatch(/FROM check_audit_triggers\(\)/);
      expect(route).toMatch(/auditTriggers/);
      // A missing tamper trigger should degrade the status.
      expect(route).toMatch(/status: auditTriggers\.status === "missing" \? "degraded" : "ok"/);
    });
  });

  describe("R39-A1-5: password rotation / revoke wipes BOTH scopes", () => {
    it("revoke-all-sessions no longer filters scope='admin'", () => {
      const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
      // The DELETE statement no longer gates on scope.
      expect(src).toMatch(/DELETE FROM sessions\s+WHERE employee_id = \$1/);
      expect(src).not.toMatch(/scope = 'admin' AND employee_id = \$1/);
    });
    it("password-change wipes all scopes", () => {
      const src = read("src/app/api/auth/password-change/route.ts");
      expect(src).toMatch(/DELETE FROM sessions WHERE employee_id = \$1/);
      expect(src).not.toMatch(/scope = 'admin' AND employee_id = \$1/);
    });
    it("password-reset-confirm wipes all scopes", () => {
      const src = read("src/app/api/auth/password-reset-confirm/route.ts");
      expect(src).toMatch(/DELETE FROM sessions WHERE employee_id = \$1/);
      expect(src).not.toMatch(/scope = 'admin' AND employee_id = \$1/);
    });
  });

  describe("R39-A2-7: CSV sanitize shared between server + client", () => {
    it("server /api/export imports csvCell from the shared module", () => {
      const src = read("src/app/api/export/route.ts");
      expect(src).toMatch(/from "@\/lib\/format\/csv-sanitize"/);
      // The inline sanitizeCsvCell / toCsv body dup is gone.
      expect(src).not.toMatch(/function sanitizeCsvCell\(str: string\)/);
    });
    it("client data-export.tsx imports csvCell + no longer has the vulnerable inline helper", () => {
      const src = read("src/components/admin/data-export.tsx");
      expect(src).toMatch(/from "@\/lib\/format\/csv-sanitize"/);
      // The prior "one-line quote-escape" shape that missed formula injection is gone.
      expect(src).not.toMatch(/`"\$\{String\(cell\)\.replace\(\/"\/g, '""'\)\}"`/);
    });
    it("sanitizeCsvCell prefixes formula-trigger cells", () => {
      expect(sanitizeCsvCell("=cmd|'/C calc'!A0")).toBe("'=cmd|'/C calc'!A0");
      expect(sanitizeCsvCell("+HYPERLINK")).toBe("'+HYPERLINK");
      expect(sanitizeCsvCell("-2+3")).toBe("'-2+3");
      expect(sanitizeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
      // Invisible-char prefix: BOM + space + equals should still be caught
      // (leading whitespace/BOM stripped BEFORE the formula-char check).
      expect(sanitizeCsvCell("\uFEFF =cmd")).toBe("'\uFEFF =cmd");
      // Tab-prefixed formula — `\t` is whitespace so it strips, then
      // `=cmd` triggers the prefix.
      expect(sanitizeCsvCell("\t=cmd")).toBe("'\t=cmd");
    });
    it("sanitizeCsvCell leaves benign text untouched", () => {
      expect(sanitizeCsvCell("Acme Co")).toBe("Acme Co");
      expect(sanitizeCsvCell("Tax Rate 10%")).toBe("Tax Rate 10%");
      expect(sanitizeCsvCell("")).toBe("");
    });
    it("csvCell quotes cells with comma/quote/newline AND sanitizes formulas", () => {
      expect(csvCell("plain")).toBe("plain");
      expect(csvCell("a,b")).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell("=fx")).toBe("'=fx");
    });
  });

  describe("R39-A1-6: email-receipt uses shared escapeHtml helper", () => {
    const src = read("src/app/api/email-receipt/route.ts");
    it("imports escapeHtml from the shared module", () => {
      expect(src).toMatch(/from "@\/lib\/format\/html-escape"/);
    });
    it("no longer has the inline 5-char esc() fork", () => {
      expect(src).not.toMatch(/const esc = \(s: string\) => String\(s\)\.replace\(\/\[&<>"'\]/);
    });
  });

  describe("R39-A2-9: barcode SVG clamps numeric dimensions", () => {
    const src = read("src/components/admin/barcode-label-printer.tsx");
    it("generateBarcodeSVG clamps width and height", () => {
      expect(src).toMatch(/Math\.max\(50, Math\.min\(2000, Number\(width\) \|\| 0\)\)/);
      expect(src).toMatch(/Math\.max\(20, Math\.min\(1000, Number\(height\) \|\| 0\)\)/);
    });
  });
});
