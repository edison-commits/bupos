/**
 * Playwright global setup — seed an admin employee + credential so the
 * product-creation spec can log in via the standard /login form.
 *
 * Uses the Docker Postgres directly (bypasses HTTP) to idempotently
 * create an org / location / employee / auth_credentials row.
 *
 * TST2-M2: prod-host guard. `playwright.config.ts:44` only sets
 * DATABASE_URL for the webServer subprocess; globalSetup inherits the
 * parent env. A developer running `npm run test:e2e` with .env.local
 * exporting a prod DATABASE_URL would otherwise persist
 * `e2e-admin@bupos.test` (with role `owner`) to prod with no teardown.
 * Refuse to run unless the URL is localhost or the DB name is the
 * canonical e2e test DB. Override via E2E_SETUP_FORCE=1 (with warning).
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";

function assertSafeTargetDb(): void {
  if (process.env.E2E_SETUP_FORCE === '1') {
    console.warn('[e2e/global-setup] E2E_SETUP_FORCE=1 — bypassing prod-host safety guard.');
    return;
  }
  let url: URL;
  try {
    url = new URL(DATABASE_URL);
  } catch {
    throw new Error('[e2e/global-setup] DATABASE_URL is not a valid URL');
  }
  const host = (url.hostname || '').toLowerCase();
  const dbName = (url.pathname || '').replace(/^\//, '').toLowerCase();
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (LOCAL_HOSTS.has(host)) return;
  if (dbName.endsWith('_test')) return;
  const PROD_HOST_SUFFIXES = [
    '.supabase.com', '.supabase.co', '.neon.tech', '.amazonaws.com',
    '.rds.amazonaws.com', '.compute.amazonaws.com', '.herokuapp.com',
    '.dbs.aiven.io',
  ];
  if (PROD_HOST_SUFFIXES.some(s => host.endsWith(s))) {
    throw new Error(
      `[e2e/global-setup] refusing to run against host '${host}' (looks like a ` +
      `production database). The e2e test seeds an owner-role admin account ` +
      `with a known password; running against prod would persist that account. ` +
      `Set E2E_SETUP_FORCE=1 to override.`,
    );
  }
}

// NOTE: these MUST be valid RFC-4122 UUIDs (version nibble 1-8, variant
// nibble 8-b) — not just any 8-4-4-4-12 hex. Postgres's `uuid` type is
// lenient, but the API input validators use zod `z.string().uuid()`
// (strict), so an all-`3`s placeholder like e2e33333-3333-3333-3333-…
// makes POST /api/products 400 on `category_id`. The 3rd group starts
// with `4` (v4) and the 4th with `8` (variant) to satisfy that.
export const SEED = {
  orgId: "e2e11111-1111-4111-8111-111111111111",
  locationId: "e2e22222-2222-4222-8222-222222222222",
  categoryId: "e2e33333-3333-4333-8333-333333333333",
  employeeId: "e2e44444-4444-4444-8444-444444444444",
  email: "e2e-admin@bupos.test",
  password: "P4ssword!e2e",
};

async function hashPbkdf2(password: string): Promise<string> {
  // Mirrors `hashSecret` in @/lib/auth/crypto:
  //   PBKDF2-SHA-256, 100k iterations, 16-byte salt, 64-byte key
  //   format `{saltHex}:{derivedHex}` with `:` separator.
  const iterations = 100_000;
  const keyLength = 64;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keyLength, "sha256");
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export default async function globalSetup(): Promise<void> {
  assertSafeTargetDb();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const pwHash = await hashPbkdf2(SEED.password);

  try {
    // Idempotent seed: INSERT ... ON CONFLICT DO NOTHING for each row
    // so re-runs don't duplicate + don't fail on the unique constraints
    // added by migration 051.
    await pool.query(
      `INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active)
       VALUES ($1, 'E2E Store', 'e2e-store', 'E2E Store LLC', 'America/Los_Angeles', 'USD', 'free', true)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.orgId],
    );
    await pool.query(
      `INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active)
       VALUES ($1, $2, 'E2E Main', 'E2E-MAIN', '1 E2E St', 'LA', 'CA', '90001', 0.0, true)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.locationId, SEED.orgId],
    );
    await pool.query(
      `INSERT INTO categories (id, organization_id, name, slug, sort_order)
       VALUES ($1, $2, 'E2E Cat', 'e2e-cat', 0)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.categoryId, SEED.orgId],
    );
    await pool.query(
      `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids)
       VALUES ($1, $2, 'owner', 'E2E', 'Admin', 'E2E Admin', $3, '', true, ARRAY[$4]::uuid[])
       ON CONFLICT (id) DO NOTHING`,
      [SEED.employeeId, SEED.orgId, SEED.email, SEED.locationId],
    );
    // Upsert credential so password is always the SEED value (re-runs
    // may change the hash).
    await pool.query(
      `INSERT INTO auth_credentials (employee_id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash`,
      [SEED.employeeId, SEED.email, pwHash],
    );
  } finally {
    await pool.end();
  }
}
