/**
 * R92 — Deploy gates on Guardrails (source-grep on the workflow).
 *
 * Postmortem invariant: commit 44992c2 shipped a circular import that
 * crashed every /admin page. The Guardrails Playwright e2e CAUGHT it —
 * but Deploy ran in parallel and published anyway. deploy.yml now waits
 * (fail-closed) for the commit's Guardrails run before any prod-mutating
 * step. These asserts keep that gate from being silently removed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = code/src/__tests__/adversarial → workflows live at repo root.
const WORKFLOWS = path.resolve(HERE, "..", "..", "..", "..", ".github", "workflows");
const deployYml = fs.readFileSync(path.join(WORKFLOWS, "deploy.yml"), "utf8");

describe("R92: deploy.yml waits for Guardrails before mutating prod", () => {
  it("has the wait step, ordered BEFORE migrations and Build & Deploy", () => {
    const waitIdx = deployYml.indexOf("Wait for Guardrails");
    expect(waitIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeLessThan(deployYml.indexOf("Run DB migrations"));
    expect(waitIdx).toBeLessThan(deployYml.indexOf("Build & Deploy"));
  });
  it("polls the Guardrails run for THIS commit and fails closed", () => {
    expect(deployYml).toMatch(/actions\/runs\?head_sha=\$SHA/);
    expect(deployYml).toMatch(/select\(\.name == "Guardrails"\)/);
    // Fail-closed on: non-success conclusion, missing run, and timeout.
    expect(deployYml).toMatch(/blocking deploy\."\s*\n\s*exit 1/);
    expect(deployYml).toMatch(/failing closed/);
    expect(deployYml).toMatch(/Timed out/);
  });
  it("grants only read access to the Actions API", () => {
    expect(deployYml).toMatch(/actions: read/);
    expect(deployYml).not.toMatch(/actions: write/);
  });
  it("the Guardrails workflow still runs the Playwright e2e it gates on", () => {
    const guardrailsYml = fs.readFileSync(path.join(WORKFLOWS, "guardrails.yml"), "utf8");
    expect(guardrailsYml).toMatch(/name: Guardrails/);
    expect(guardrailsYml).toMatch(/test:e2e/);
  });
});
