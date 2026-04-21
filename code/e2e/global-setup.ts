/**
 * Playwright global setup — seed an admin employee + credential so the
 * product-creation spec can log in via the standard /login form.
 *
 * Uses the Docker Postgres directly (bypasses HTTP) to idempotently
 * create an org / location / employee / auth_credentials row.
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";

export const SEED = {
  orgId: "e2e11111-1111-1111-1111-111111111111",
  locationId: "e2e22222-2222-2222-2222-222222222222",
  categoryId: "e2e33333-3333-3333-3333-333333333333",
  employeeId: "e2e44444-4444-4444-4444-444444444444",
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
