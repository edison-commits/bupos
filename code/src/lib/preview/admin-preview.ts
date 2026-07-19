import { hashSecret } from "@/lib/auth/crypto";
import { getPool, orgTx } from "@/lib/supabase-rest";

export const PREVIEW_EMAIL_ENV = "BUPOS_PREVIEW_EMAIL";
export const PREVIEW_PASSWORD_ENV = "BUPOS_PREVIEW_PASSWORD";
export const PREVIEW_SECRET_ENV = "BUPOS_PREVIEW_SECRET";
export const PREVIEW_ORG_ENV = "BUPOS_ORG_ID";
export const PREVIEW_LOCATION_ENV = "BUPOS_LOCATION_ID";

export type PreviewConfig = {
  email: string;
  password: string;
  secret: string;
  organizationId: string;
  locationId: string;
};

export class PreviewProvisionError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    super(`Preview provisioning failed at ${stage}`);
    this.name = "PreviewProvisionError";
    this.cause = cause;
  }
}

export function getPreviewConfig(): PreviewConfig | null {
  const email = process.env[PREVIEW_EMAIL_ENV]?.trim().toLowerCase();
  const password = process.env[PREVIEW_PASSWORD_ENV];
  const secret = process.env[PREVIEW_SECRET_ENV];
  const organizationId = process.env[PREVIEW_ORG_ENV]?.trim();
  const locationId = process.env[PREVIEW_LOCATION_ENV]?.trim();
  if (!email || !password || !secret || !organizationId || !locationId) return null;
  return { email, password, secret, organizationId, locationId };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function previewSecretMatches(candidate: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(candidate), digest(expected)]);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

/**
 * Creates the dedicated preview identity on first successful preview access.
 * It is deliberately a manager, never an owner, and is tied to the already
 * configured BUPOS org/location secrets. Existing accounts are never modified.
 */
export async function ensurePreviewAdmin(config: PreviewConfig): Promise<void> {
  let stage = "lookup";
  try {
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT * FROM admin_login_lookup($1::text) AS result`, [config.email]);
    const lookup = (rows[0]?.result ?? rows[0] ?? null) as Record<string, unknown> | null;
    if (lookup) {
      if (
        lookup.organization_id !== config.organizationId ||
        lookup.role_key !== "manager" ||
        lookup.is_active !== true
      ) {
        throw new Error("Preview identity exists with an unexpected scope or role");
      }
      return;
    }

    const client = await orgTx(config.organizationId);
    try {
      const employeeId = crypto.randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashSecret(config.password);
      stage = "employee-insert";
      await client.query(
        `INSERT INTO employees
          (id, organization_id, role_key, first_name, last_name, display_name,
           email, pin_hint, is_active, location_ids, created_at, updated_at)
         VALUES ($1, $2::uuid, 'manager', 'Private', 'Preview', 'Private Preview',
                 $3, 'Preview access only', true, ARRAY[$4::uuid], $5, $5)`,
        [employeeId, config.organizationId, config.email, config.locationId, now],
      );
      stage = "credential-insert";
      await client.query(
        `INSERT INTO auth_credentials
          (employee_id, email, password_hash, pin_hash, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, $4, $4)`,
        [employeeId, config.email, passwordHash, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error; rollback failure is not user-facing.
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    throw new PreviewProvisionError(stage, error);
  }
}
