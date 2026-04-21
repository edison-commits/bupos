/**
 * R8-L-12: cross-tenant UPDATE regression suite.
 *
 * For every org-scoped table, assert that an `orgTx`-scoped client
 * bound to Org A cannot UPDATE a row that belongs to Org B. This is the
 * defense-in-depth that RLS + WITH CHECK enforces — the ESLint rule
 * `local/pg-helpers-require-org` prevents the app code from omitting
 * the `organizationId` param, but these tests confirm that IF a caller
 * did somehow reach the DB with the wrong tenant, the write would be
 * rejected by the database itself.
 *
 * Seed is deterministic (see `seed.sql`):
 *   Org A = 11111111-...
 *   Org B = 22222222-...
 *   A's product variant = vaaa...
 *   B's product variant = vbbb...
 *
 * Preconditions:
 *   DATABASE_URL points at the Docker Postgres
 *   `npm run docker:up && npm run docker:migrate` has run
 *
 * Strategy per test:
 *   1. Open orgTx(A)
 *   2. Attempt UPDATE on B's row
 *   3. Assert rowCount === 0 (RLS filtered it out)
 *   4. Close tx
 *
 * R21-H-1 tightening: the INSERT tests below were tautological in R8-L-12.
 * They assembled INSERT statements missing `category_id` (NOT NULL) and
 * other required columns, so the DB rejected with a NOT-NULL violation
 * BEFORE RLS WITH CHECK evaluated. The tests passed regardless of
 * whether the policy was enabled. Fix:
 *   (a) Provide every NOT-NULL column so the row is valid schema-wise.
 *   (b) Assert that the specific error code is `42501`
 *       (insufficient_privilege — Postgres's code for an RLS rejection),
 *       not any-throw.
 *   (c) Run a same-tenant control to prove the statement shape is
 *       otherwise valid (catches future schema changes that break the
 *       test without anyone noticing).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Use plain `pg` for the test harness. `@neondatabase/serverless` is
// WebSocket-based and only talks to Neon's cloud; plain Postgres over
// TCP (Docker compose here + GitHub Actions service container) needs
// the standard driver.
import { Pool } from "pg";

const ORG_A = "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A_VARIANT = "99aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B_VARIANT = "99bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const B_CUSTOMER = "77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A_LOCATION = "22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B_LOCATION = "22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A_PRODUCT = "88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A_CATEGORY = "33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B_CATEGORY = "33bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
// Unused reference shapes kept for readability.
void A_LOCATION;
void A_VARIANT;

// Use the plain `pg` driver here — @neondatabase/serverless works against
// plain Postgres too, and matches what the app uses in prod.
let pool: Pool;

beforeAll(() => {
  const connectionString = process.env.DATABASE_URL
    ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";
  pool = new Pool({ connectionString, max: 2 });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Simulate `orgTx(orgId)`: open a client, BEGIN, SET LOCAL ROLE to the
 * non-superuser `app_user` (so RLS + FORCE RLS actually evaluate —
 * `postgres` has BYPASSRLS), then set app.current_org_id.
 *
 * In prod the app uses the `postgres` owner role on Neon, but prod
 * tables have FORCE ROW LEVEL SECURITY which makes the owner subject
 * to RLS anyway. Here we explicitly switch roles so the test reflects
 * the runtime policy evaluation path.
 */
async function orgTx(orgId: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE app_user");
  await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
  return client;
}

/**
 * Pattern: `.rejects.toThrow()` matches ANY error — it would pass on a
 * NOT-NULL violation, a CHECK constraint, a FK failure, or a duplicate
 * key. R21-H-1 uncovered that the original INSERT tests passed for the
 * wrong reason (missing `category_id`). To avoid that trap going forward,
 * assert the specific pg SQLSTATE that indicates an RLS rejection.
 *
 * Postgres code reference:
 *   42501 — insufficient_privilege (the code RLS policy failure raises)
 *   Other codes we explicitly want NOT to match:
 *     23502 — not_null_violation
 *     23503 — foreign_key_violation
 *     23505 — unique_violation
 *     23514 — check_violation
 */
async function expectRlsRejection(
  promise: Promise<unknown>,
  label: string,
): Promise<void> {
  // R22-M-4: prior shape threw inside the try and then re-checked the
  // same catch block for the SQLSTATE — which turned a "got success"
  // assertion into "expected 42501, got undefined" (the synthesized
  // Error has no `code`). Future RLS regressions surfaced as cryptic
  // failure output. Track success/failure via a local flag so each
  // branch emits its own message.
  let threw: unknown = undefined;
  let succeeded = false;
  try {
    await promise;
    succeeded = true;
  } catch (err) {
    threw = err;
  }
  if (succeeded) {
    throw new Error(`${label}: expected RLS rejection, got success`);
  }
  const e = threw as { code?: string; message?: string };
  if (e.code !== "42501") {
    throw new Error(
      `${label}: expected error code 42501 (insufficient_privilege, RLS policy violation), got ${e.code ?? "undefined"}: ${e.message ?? String(threw)}`,
    );
  }
}

describe("cross-tenant UPDATE is blocked", () => {
  it("products: Org A cannot update Org B's product", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE products SET name = 'HIJACKED' WHERE organization_id = $1 RETURNING id`,
        [ORG_B],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("product_variants: Org A cannot update Org B's variant price", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE product_variants SET price = 0.01 WHERE id = $1 RETURNING id`,
        [B_VARIANT],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("inventory_levels: Org A cannot inflate Org B's on_hand", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE inventory_levels SET on_hand = 1000000
           WHERE product_variant_id = $1 AND location_id = $2 RETURNING id`,
        [B_VARIANT, B_LOCATION],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("customers: Org A cannot update Org B's customer", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE customers SET first_name = 'HIJACKED' WHERE id = $1 RETURNING id`,
        [B_CUSTOMER],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("employees: Org A cannot deactivate Org B's employee", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE employees SET is_active = false WHERE organization_id = $1 RETURNING id`,
        [ORG_B],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("locations: Org A cannot change Org B's location tax_rate", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `UPDATE locations SET tax_rate = 0 WHERE id = $1 RETURNING id`,
        [B_LOCATION],
      );
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("cross-tenant INSERT is blocked by WITH CHECK", () => {
  // R21-H-1: every INSERT here provides ALL NOT-NULL columns. The error
  // code asserted is 42501 (RLS insufficient_privilege) — the test would
  // fail loudly if something other than RLS rejected the INSERT (a schema
  // change adding a new NOT-NULL column, a trigger, etc.).
  //
  // Each test is paired with a same-tenant INSERT that proves the
  // statement shape is otherwise valid — catching drift in `seed.sql` or
  // schema that would silently make the cross-tenant INSERT throw a
  // DIFFERENT error (which the old `.rejects.toThrow()` would have
  // swallowed).

  it("products: same-org INSERT succeeds (control)", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(
        `INSERT INTO products (id, organization_id, category_id, name, slug, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'ctrl', 'ctrl-${Date.now()}', true)
         RETURNING id`,
        [ORG_A, A_CATEGORY],
      );
      expect(res.rowCount).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("products: Org A cannot INSERT a product claiming Org B", async () => {
    const c = await orgTx(ORG_A);
    try {
      await expectRlsRejection(
        c.query(
          `INSERT INTO products (id, organization_id, category_id, name, slug, is_active)
           VALUES (gen_random_uuid(), $1, $2, 'forged', 'forged-${Date.now()}', true)`,
          [ORG_B, B_CATEGORY],
        ),
        "products cross-tenant INSERT",
      );
      await c.query("ROLLBACK").catch(() => {});
    } finally {
      c.release();
    }
  });

  it("inventory_levels: same-org INSERT succeeds (control)", async () => {
    // Use a fresh variant row so the (org, variant, location) triple is
    // unique. We write a new variant + inventory in one tx.
    const c = await orgTx(ORG_A);
    try {
      const vr = await c.query(
        `INSERT INTO product_variants (organization_id, product_id, sku, name, price, is_active)
         VALUES ($1, $2, 'CTRL-${Date.now()}', 'ctrl', 1, true)
         RETURNING id`,
        [ORG_A, A_PRODUCT],
      );
      const variantId = (vr.rows[0] as { id: string }).id;
      const ir = await c.query(
        `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point)
         VALUES ($1, $2, $3, 1, 0, 0)
         RETURNING id`,
        [ORG_A, variantId, A_LOCATION],
      );
      expect(ir.rowCount).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("inventory_levels: Org A cannot INSERT a row for Org B's variant/location", async () => {
    const c = await orgTx(ORG_A);
    try {
      await expectRlsRejection(
        c.query(
          `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point)
           VALUES ($1, $2, $3, 1, 0, 0)`,
          [ORG_B, B_VARIANT, B_LOCATION],
        ),
        "inventory_levels cross-tenant INSERT",
      );
      await c.query("ROLLBACK").catch(() => {});
    } finally {
      c.release();
    }
  });

  it("customers: Org A cannot INSERT a customer claiming Org B", async () => {
    const c = await orgTx(ORG_A);
    try {
      await expectRlsRejection(
        c.query(
          `INSERT INTO customers (organization_id, first_name, last_name, is_active)
           VALUES ($1, 'Forged', 'User', true)`,
          [ORG_B],
        ),
        "customers cross-tenant INSERT",
      );
      await c.query("ROLLBACK").catch(() => {});
    } finally {
      c.release();
    }
  });
});

describe("same-tenant baseline (control)", () => {
  it("Org A CAN read its own products", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(`SELECT id FROM products WHERE id = $1`, [A_PRODUCT]);
      expect(res.rowCount).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("Org A CANNOT see Org B's products via SELECT", async () => {
    const c = await orgTx(ORG_A);
    try {
      const res = await c.query(`SELECT id FROM products WHERE organization_id = $1`, [ORG_B]);
      expect(res.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("FORCE RLS is on (regression for R14-C-1)", () => {
  // R21-M-5: the `for (const row of rows)` loop would trivially pass if
  // migrations renamed a table (the `WHERE ... IN (...)` would return 0
  // rows and the loop body would never run). Assert the expected table
  // count FIRST so a rename or drop fails the test loudly.
  const EXPECTED_FORCE_RLS_TABLES = [
    "customer_display_state",
    "expenses",
    "purchase_orders",
    "suppliers",
    "transaction_lines",
  ] as const;

  it("legacy tables have FORCE RLS", async () => {
    const { rows } = await pool.query(
      `SELECT relname, relforcerowsecurity
         FROM pg_class
         WHERE relnamespace = 'public'::regnamespace
           AND relname = ANY($1::text[])`,
      [EXPECTED_FORCE_RLS_TABLES],
    );
    const foundNames = rows.map((r: { relname: string }) => r.relname).sort();
    expect(foundNames).toEqual([...EXPECTED_FORCE_RLS_TABLES].sort());
    for (const row of rows) {
      expect(
        row.relforcerowsecurity,
        `${row.relname} must have FORCE RLS`,
      ).toBe(true);
    }
  });
});

describe("R21-H-3: SECURITY DEFINER functions have SET search_path", () => {
  // Regression gate: migration 052 ALTER FUNCTION'd every SECURITY
  // DEFINER function in public.* to pin `search_path=public`. A future
  // function that ships without this hardening would be a hijack vector.
  // The migration itself does this check, but asserting here catches
  // drift that might slip past the migration (e.g. a function created
  // at runtime via a backfill script).
  it("no SECURITY DEFINER function in public.* lacks search_path", async () => {
    const { rows } = await pool.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosecdef = true
           AND NOT EXISTS (
             SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS c
               WHERE c LIKE 'search_path=%'
           )`,
    );
    const offenders = rows.map((r: { proname: string; args: string }) =>
      `${r.proname}(${r.args})`,
    );
    expect(offenders, `SECURITY DEFINER fns missing search_path: ${offenders.join(", ")}`).toEqual([]);
  });
});
