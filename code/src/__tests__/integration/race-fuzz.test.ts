/**
 * R23-prevention: concurrent race-fuzz tests.
 *
 * Motivation: R21 → R22 → R23 kept introducing race conditions via
 * "fixes" that only considered one thread of execution:
 *   • R21-C-1 → added unique index, didn't update callers → R22-H-1
 *   • R22-H-1 → added DELETE-expired → R23-M-3 (24-hour DoS race)
 *   • R21-H-4 (SKU uniqueness) → never exercised under concurrent
 *     variant creation before.
 *
 * These tests spawn N concurrent attempts against the same logical
 * resource (email, SKU, layaway row) and assert the DB enforces
 * correctness: exactly one succeeds, others see the expected pg error
 * (23505 / 42501 / 40001), and the final state is consistent.
 *
 * Runs against the Docker Postgres harness (same as cross-tenant
 * tests). Each test is fully self-contained — creates its fixtures,
 * wraps mutations in ROLLBACK or explicit cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const ORG_A = "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A_PRODUCT = "88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let pool: Pool;
beforeAll(() => {
  const connectionString = process.env.DATABASE_URL
    ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";
  // Higher pool size so concurrent clients aren't serialized.
  pool = new Pool({ connectionString, max: 10 });
});
afterAll(async () => {
  await pool.end();
});

/**
 * Execute the given work function in parallel, catching and
 * categorizing results. Returns `{ ok, errors }` where ok is the
 * count of successful returns and errors is an array of pg error
 * codes (or the message if no code).
 */
async function runConcurrent(n: number, work: (i: number) => Promise<unknown>) {
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => work(i)),
  );
  let ok = 0;
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") ok++;
    else {
      const e = s.reason as { code?: string; message?: string };
      errors.push(e.code ?? e.message ?? "unknown");
    }
  }
  return { ok, errors };
}

describe("race fuzz: pending_signups concurrent signups for same email", () => {
  // Reproduces the R22-H-1 / R23-M-3 shape. The DB MUST ensure exactly
  // one row lands per email — regardless of how many threads race.
  it("N=10 concurrent signups for same email → exactly 1 row, 9 × 23505", async () => {
    const email = `race-${Date.now()}-${Math.random()}@test.invalid`;
    const { ok, errors } = await runConcurrent(10, async () => {
      await pool.query(
        `INSERT INTO pending_signups
           (email, store_name, first_name, last_name, password_hash, verification_token_hash)
         VALUES ($1, 's', 'f', 'l', 'x', $2)`,
        [email, `tok-${Math.random()}`],
      );
    });
    expect(ok).toBe(1);
    // Remaining 9 must all be 23505 (unique_violation on
    // uniq_pending_signups_email_lower).
    const nonUnique = errors.filter((c) => c !== "23505");
    expect(nonUnique, `expected only 23505 errors, got ${nonUnique.join(",")}`).toEqual([]);
    expect(errors.length).toBe(9);
    // Cleanup.
    await pool.query(`DELETE FROM pending_signups WHERE email = $1`, [email]);
  });

  it("R23-M-3 atomic DELETE+INSERT: expired row replaced, no stuck state", async () => {
    const email = `race2-${Date.now()}-${Math.random()}@test.invalid`;
    // Plant an expired row.
    await pool.query(
      `INSERT INTO pending_signups (email, store_name, first_name, last_name, password_hash, verification_token_hash, expires_at)
       VALUES ($1, 'old', 'a', 'b', 'h1', $2, now() - interval '1 hour')`,
      [email, `old-tok-${Math.random()}`],
    );
    // 5 concurrent attempts to replace it with the atomic tx sequence.
    const { ok, errors } = await runConcurrent(5, async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          `DELETE FROM pending_signups
             WHERE lower(email) = lower($1) AND expires_at <= now()`,
          [email],
        );
        await c.query(
          `INSERT INTO pending_signups (email, store_name, first_name, last_name, password_hash, verification_token_hash)
           VALUES ($1, 'new', 'a', 'b', 'h2', $2)`,
          [email, `new-tok-${Math.random()}`],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    });
    // At least one must succeed; the others see 23505 against the
    // fresh-inserted row (which is no longer expired).
    expect(ok).toBeGreaterThanOrEqual(1);
    const expectedCodes = errors.every((c) => c === "23505");
    expect(expectedCodes, `errors: ${errors.join(",")}`).toBe(true);
    // Final state: exactly one non-expired row for this email.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pending_signups WHERE email = $1 AND expires_at > now()`,
      [email],
    );
    expect(rows[0].n).toBe(1);
    await pool.query(`DELETE FROM pending_signups WHERE email = $1`, [email]);
  });
});

describe("race fuzz: product_variants concurrent insert with same SKU", () => {
  // Reproduces the R21-H-4 / R22-M-1 shape. `uniq_product_variants_
  // org_sku_active` must reject duplicates under concurrency.
  it("N=8 concurrent inserts with same SKU → exactly 1 succeeds, 7 × 23505", async () => {
    const sku = `RACE-SKU-${Date.now()}-${Math.random()}`;
    const { ok, errors } = await runConcurrent(8, async () => {
      await pool.query(
        `INSERT INTO product_variants
           (organization_id, product_id, sku, name, price, is_active)
         VALUES ($1, $2, $3, 'race', 1.00, true)`,
        [ORG_A, A_PRODUCT, sku],
      );
    });
    expect(ok).toBe(1);
    const nonUnique = errors.filter((c) => c !== "23505");
    expect(nonUnique, `expected only 23505, got ${nonUnique.join(",")}`).toEqual([]);
    expect(errors.length).toBe(7);
    // Cleanup — there should be exactly one surviving row.
    await pool.query(
      `DELETE FROM product_variants WHERE organization_id = $1 AND sku = $2`,
      [ORG_A, sku],
    );
  });

  it("same SKU, DEACTIVATED variant does NOT block a new active variant", async () => {
    // Partial-index predicate `WHERE is_active`: deactivated variants
    // free up the SKU for a new active one. Verify this behavior under
    // concurrent load.
    const sku = `RACE-RES-${Date.now()}-${Math.random()}`;
    // First, create a deactivated variant holding the SKU.
    await pool.query(
      `INSERT INTO product_variants
         (organization_id, product_id, sku, name, price, is_active)
       VALUES ($1, $2, $3, 'old', 1.00, false)`,
      [ORG_A, A_PRODUCT, sku],
    );
    // Now 4 concurrent attempts to create an ACTIVE variant with the
    // same SKU — exactly one should win.
    const { ok, errors } = await runConcurrent(4, async () => {
      await pool.query(
        `INSERT INTO product_variants
           (organization_id, product_id, sku, name, price, is_active)
         VALUES ($1, $2, $3, 'new', 1.00, true)`,
        [ORG_A, A_PRODUCT, sku],
      );
    });
    expect(ok).toBe(1);
    const nonUnique = errors.filter((c) => c !== "23505");
    expect(nonUnique, `expected only 23505, got ${nonUnique.join(",")}`).toEqual([]);
    // Cleanup.
    await pool.query(
      `DELETE FROM product_variants WHERE organization_id = $1 AND sku = $2`,
      [ORG_A, sku],
    );
  });
});

describe("race fuzz: auth_credentials concurrent insert with same email", () => {
  // Reproduces the R22-C-1 shape: the new
  // `uniq_auth_credentials_email_lower` index from migration 051 must
  // hold under concurrent verify-route INSERTs.
  it("N=6 concurrent creds for same email → exactly 1 succeeds", async () => {
    const email = `cred-race-${Date.now()}-${Math.random()}@test.invalid`;
    // Plant 6 employees (FK target) so each INSERT has a valid
    // employee_id — each credential row is keyed by employee_id.
    const employeeIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { rows } = await pool.query(
        `INSERT INTO employees
           (organization_id, role_key, first_name, last_name, display_name, pin_hint, is_active)
         VALUES ($1, 'cashier', 'R', $2, 'R', '', true)
         RETURNING id`,
        [ORG_A, `racer-${i}`],
      );
      employeeIds.push(rows[0].id);
    }
    // Concurrent INSERTs. Each uses a DISTINCT employee_id (PK) but
    // the SAME email (unique-on-lower).
    const { ok, errors } = await runConcurrent(6, async (i) => {
      await pool.query(
        `INSERT INTO auth_credentials (employee_id, email, password_hash)
         VALUES ($1, $2, 'h')`,
        [employeeIds[i], email],
      );
    });
    expect(ok).toBe(1);
    const nonUnique = errors.filter((c) => c !== "23505");
    expect(nonUnique, `expected only 23505, got ${nonUnique.join(",")}`).toEqual([]);
    // Cleanup credentials + employees.
    await pool.query(`DELETE FROM auth_credentials WHERE email = $1`, [email]);
    await pool.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [employeeIds]);
  });
});
