/**
 * R51 regression tests. Pins the UI half of R49's step-up plumbing:
 *   R51-1: Shared `PasswordGatedForm` wrapper exists and disables
 *          its submit button synchronously (composes R48's guard).
 *   R51-2: admin-console.tsx wraps the three privileged action forms
 *          (createEmployee / toggleEmployee / editVariant) in
 *          `<PasswordGatedForm>` so `actorPassword` is threaded into
 *          FormData — R50 audit flagged these as "backend gated in
 *          R49 but UI prompt deferred".
 *   R51-3: stocktake-manager.tsx Accept button prompts via
 *          `usePasswordGate` before calling `acceptStocktakeAction`
 *          with the password as 2nd arg.
 *   R51-4: editVariantAction's gating is conditional on a price or
 *          cost change (snapshot-compare defaultValue vs .value),
 *          matching the server-side snapshot-compare in
 *          `/src/app/admin/actions.ts editVariantAction`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R51 audit fixes: admin-console PasswordGate wiring", () => {
  describe("R51-1: PasswordGatedForm wrapper exists + composes R48 guard", () => {
    const src = read("src/components/shared/password-gated-form.tsx");
    it("exports PasswordGatedForm", () => {
      expect(src).toMatch(/export function PasswordGatedForm/);
    });
    it("uses synchronous DOM mutation to disable submit button (R48 pattern)", () => {
      // R52-P: the wrapper now re-queries the button via findBtn()
      // after each await (the initial Node reference can go stale if
      // React reconciles the tree during the await). The initial
      // disable call still mutates `.disabled = true` synchronously
      // on submit — that's the R48-style close-the-window behavior
      // the test is pinning.
      expect(src).toMatch(/initialBtn\.disabled = true/);
      expect(src).toMatch(/if \(initialBtn\.disabled\) return/);
    });
    it("appends actorPassword to FormData via `fd.set(\"actorPassword\", pwd)`", () => {
      expect(src).toMatch(/fd\.set\(["']actorPassword["'], pwd\)/);
    });
    it("supports optional gateCondition predicate for conditional gating", () => {
      expect(src).toMatch(/gateCondition\?\: \(formData: FormData, form: HTMLFormElement\) => boolean/);
      expect(src).toMatch(/!gateCondition \|\| gateCondition\(fd, form\)/);
    });
    it("scrubs caught errors via safeErr before logging", () => {
      expect(src).toMatch(/import \{ safeErr \}/);
      expect(src).toMatch(/console\.error\([^)]*safeErr\(err\)/);
    });
  });

  describe("R51-2: admin-console wraps privileged action forms in PasswordGatedForm", () => {
    const src = read("src/components/admin/admin-console.tsx");
    it("imports PasswordGatedForm", () => {
      expect(src).toMatch(/import \{ PasswordGatedForm \} from ['"]@\/components\/shared\/password-gated-form['"]/);
    });
    it("createEmployeeAction form uses <PasswordGatedForm>", () => {
      expect(src).toMatch(/<PasswordGatedForm[\s\S]{0,800}action=\{createEmployeeAction\}/);
    });
    it("toggleEmployeeAction form uses <PasswordGatedForm>", () => {
      expect(src).toMatch(/<PasswordGatedForm[\s\S]{0,800}action=\{toggleEmployeeAction\}/);
    });
    it("editVariantAction form uses <PasswordGatedForm>", () => {
      expect(src).toMatch(/<PasswordGatedForm[\s\S]{0,1200}action=\{editVariantAction\}/);
    });
    it("createEmployee form has a descriptive title prompt", () => {
      // Prompt should mention creation and privilege-elevation.
      expect(src).toMatch(/title:\s*["']Create new employee\?/);
    });
    it("toggleEmployee prompts differ for activate vs deactivate", () => {
      expect(src).toMatch(/Deactivate \$\{employee\.displayName\}\?/);
      expect(src).toMatch(/Reactivate \$\{employee\.displayName\}\?/);
    });
  });

  describe("R51-3: stocktake Accept prompts for step-up password", () => {
    const src = read("src/components/admin/stocktake-manager.tsx");
    it("imports usePasswordGate", () => {
      expect(src).toMatch(/import \{ usePasswordGate \} from ['"]@\/components\/shared\/password-gate['"]/);
    });
    it("Accept button calls promptPassword before acceptStocktakeAction", () => {
      // The click handler must await promptPassword, bail on null,
      // then pass the password as 2nd arg to acceptStocktakeAction.
      expect(src).toMatch(/const pwd = await promptPassword\(\{[\s\S]{0,400}Accept stocktake/);
      expect(src).toMatch(/if \(!pwd\) return/);
      expect(src).toMatch(/acceptStocktakeAction\(st\.id,\s*pwd\)/);
    });
    it("renders the {passwordGate} element at component root", () => {
      expect(src).toMatch(/\{passwordGate\}/);
    });
  });

  describe("R51-4: editVariantAction gating is conditional on price/cost change", () => {
    const src = read("src/components/admin/admin-console.tsx");
    it("passes a gateCondition predicate that checks .value !== .defaultValue on price/cost", () => {
      // The gate fires when either price or cost actually changed
      // from the form's initial defaultValue — mirroring the server-
      // side snapshot-compare in src/app/admin/actions.ts.
      expect(src).toMatch(/gateCondition=\{/);
      expect(src).toMatch(/return priceChanged \|\| costChanged;?/);
      expect(src).toMatch(/priceInp\.value !== priceInp\.defaultValue/);
      expect(src).toMatch(/costInp\.value !== costInp\.defaultValue/);
    });
  });
});
