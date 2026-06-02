/**
 * R87 / SIM-AUDIT8 — cash-drawer open_shift must set shifts.opened_at.
 *
 * shifts.opened_at is NOT NULL with NO column default (unlike created_at /
 * updated_at, which default to now()). The cash-drawer open_shift INSERT
 * originally omitted opened_at entirely, so EVERY drawer open via
 * /api/cash-drawer threw a non-23505 NOT-NULL violation that fell through
 * to the generic 500 handler — register operators literally could not open
 * a shift through the cash-drawer endpoint. Surfaced by the month-usage
 * simulation (7/7 days 500'd on open_shift).
 *
 * The canonical open path (postgres-store.ts, used by /api/shifts) always
 * sets opened_at explicitly; this guards that the cash-drawer path matches.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("SIM-AUDIT8: cash-drawer open_shift sets opened_at", () => {
  const src = read("src/app/api/cash-drawer/route.ts");

  it("isolates one INSERT INTO shifts and it lists opened_at with a value", () => {
    // grab from "INSERT INTO shifts" up to the RETURNING clause
    const m = src.match(/INSERT INTO shifts[\s\S]*?RETURNING id, opened_at/);
    expect(m, "could not find the open_shift INSERT INTO shifts").not.toBeNull();
    const stmt = m![0];
    // column list (between the first balanced parens) must include opened_at
    expect(stmt).toMatch(/\(organization_id[^;]*?opened_at\)/);
    // and the VALUES list must provide NOW() for it (not omit it -> NOT-NULL 500)
    expect(stmt).toMatch(/'open', NOW\(\)\)/i);
  });

  it("column count equals value count (no positional mismatch)", () => {
    const m = src.match(/INSERT INTO shifts\s*\n?\s*\(([^)]*)\)\s*\n?\s*VALUES\s*\(([\s\S]*?)\)\s*\n?\s*RETURNING/);
    expect(m).not.toBeNull();
    const cols = m![1].split(",").map((c) => c.trim()).filter(Boolean);
    // values: 6 params + 'open' literal + NOW() literal = 8; cols also 8
    const vals = m![2].replace(/NOW\(\)/i, "NOW").split(",").map((v) => v.trim()).filter(Boolean);
    expect(cols).toContain("opened_at");
    expect(cols.length).toBe(vals.length);
  });
});
