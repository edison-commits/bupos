"use server";

import { headers } from "next/headers";
import { signInAdmin, getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/crypto";
import { randomUUID } from "@/lib/uuid";
// Lazy-import pool-dependent modules to avoid pulling @neondatabase/serverless into the SSR module graph
// pgFindCredentialByEmail and pgInsertAuditEvent are imported dynamically below

// ── Login action (used by useActionState) ─────────────────────────────
export async function loginAction(_prev: { error: string } | null, formData: FormData) {
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const rl = checkRateLimit(email);
  if (!rl.allowed) {
    return { error: "Too many attempts. Try again shortly." };
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  const referer = requestHeaders.get("referer");
  const allowedOrigin = host ? new RegExp(`^https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : null;

  if (!origin || !host || !allowedOrigin?.test(origin)) {
    return { error: "Invalid request origin." };
  }

  if (referer) {
    let refererOrigin: string | null = null;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return { error: "Invalid request origin." };
    }

    if (!allowedOrigin.test(refererOrigin)) {
      return { error: "Invalid request origin." };
    }
  }

  try {
  const result = await signInAdmin(email, password) as unknown as { sessionId: string; expiresAt: string } | undefined;
  if (result?.sessionId) {
    return { success: true, redirect: "/admin", sessionId: result.sessionId, expiresAt: result.expiresAt } as any;
  }
  } catch (err) {
    // Audit: log failed admin login attempt (non-fatal — still return error)
    if (process.env.USE_POSTGRES) {
      try {
        const { pgFindCredentialByEmail: findCred, pgInsertAuditEvent: insertAudit } = await import("@/lib/persistence/postgres-store");
        const cred = await findCred(email);
        let orgId: string | null = null;
        if (cred) {
          const { default: pool } = await import("@/lib/db");
          const { rows } = await pool.query(
            `SELECT organization_id FROM employees WHERE id = $1 LIMIT 1`,
            [cred.employeeId],
          );
          orgId = (rows[0]?.organization_id as string) ?? null;
        }
        insertAudit(
          orgId ?? 'unknown', null, cred?.employeeId ?? null,
          "session", null, "admin_login_failed",
          { email, reason: err instanceof Error ? err.message : "unknown" },
        ).catch((auditErr) => console.error("[audit] Failed to insert audit event:", auditErr));
      } catch {
        // audit lookup failed — skip audit, still return error
      }
    }
    return { error: "Invalid email or password." };
  }

  // Fallback — shouldn't reach here
  return { error: "Login failed." } as any;
}

// ── Signup action ─────────────────────────────────────────────────────
export async function signupAction(_prev: { error: string } | null, formData: FormData) {
  const storeName = (formData.get("storeName") as string)?.trim();
  const firstName = (formData.get("firstName") as string)?.trim();
  const lastName = (formData.get("lastName") as string)?.trim();
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;

  if (!storeName || !firstName || !lastName || !email || !password) {
    return { error: "All fields are required." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  const rl = checkRateLimit(`signup:${email}`);
  if (!rl.allowed) {
    return { error: "Too many attempts. Try again shortly." };
  }

  // H-05: Origin validation matching loginAction()
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  const referer = requestHeaders.get("referer");
  const allowedOrigin = host ? new RegExp(`^https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : null;

  if (!origin || !host || !allowedOrigin?.test(origin)) {
    return { error: "Invalid request origin." };
  }

  if (referer) {
    let refererOrigin: string | null = null;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return { error: "Invalid request origin." };
    }
    if (!allowedOrigin.test(refererOrigin)) {
      return { error: "Invalid request origin." };
    }
  }

  try {
    const { default: pool } = await import("@/lib/db");

    // Check if email already exists
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM auth_credentials WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (existing.length > 0) {
      return { error: "An account with this email already exists." };
    }

    const now = new Date().toISOString();
    const orgId = randomUUID();
    const locationId = randomUUID();
    const employeeId = randomUUID();
    const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const passwordHash = await hashSecret(password);

    // M-07: Wrap org+location+employee+credentials inserts in a single transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'America/Los_Angeles', 'USD', 'free', true, $5, $5)`,
        [orgId, storeName, slug || "store", storeName, now],
      );

      await client.query(
        `INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active, created_at, updated_at)
         VALUES ($1, $2, 'Main Store', 'MAIN', '', '', '', '', 0.0, true, $3, $3)`,
        [locationId, orgId, now],
      );

      await client.query(
        `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids, created_at, updated_at)
         VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'Set in admin', true, ARRAY[$7]::uuid[], $8, $8)`,
        [employeeId, orgId, firstName, lastName, `${firstName} ${lastName}`, email, locationId, now],
      );

      await client.query(
        `INSERT INTO auth_credentials (employee_id, email, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [employeeId, email, passwordHash, now],
      );

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    // Sign them in
    await signInAdmin(email, password);

    // Audit: log new store/owner signup (non-fatal — redirect still proceeds)
    const ctx = await getAdminSession();
    if (ctx) {
      pool.query(
        `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orgId, locationId, employeeId,
          "organization", orgId, "store_signup",
          JSON.stringify({ store_name: storeName, owner_email: email, plan: "free" }),
          now,
        ],
      ).catch((err) => console.error("[audit] Failed to insert audit event:", err));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Signup failed";
    // Don't expose internal errors
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      return { error: "An account with this email already exists." };
    }
    console.error("Signup error:", msg);
    return { error: "Something went wrong. Please try again." };
  }

  redirect("/admin");
}
