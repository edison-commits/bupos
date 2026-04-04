"use server";

import { redirect } from "next/navigation";
import { signInAdmin, getAdminSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { hashSecret, verifySecret } from "@/lib/auth/crypto";
import { randomUUID } from "node:crypto";

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

  try {
    await signInAdmin(email, password);
  } catch {
    // signInAdmin redirects on failure — if we catch, it's an unexpected error
    return { error: "Invalid email or password." };
  }

  // signInAdmin sets the cookie and returns — now redirect
  redirect("/admin");
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

    // Create organization
    await pool.query(
      `INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'America/Los_Angeles', 'USD', 'free', true, $5, $5)`,
      [orgId, storeName, slug || "store", storeName, now],
    );

    // Create default location
    await pool.query(
      `INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Main Store', 'MAIN', '', '', '', '', 0.0, true, $3, $3)`,
      [locationId, orgId, now],
    );

    // Create owner employee
    await pool.query(
      `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids, created_at, updated_at)
       VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'Set in admin', true, ARRAY[$7]::uuid[], $8, $8)`,
      [employeeId, orgId, firstName, lastName, `${firstName} ${lastName}`, email, locationId, now],
    );

    // Create auth credentials with hashed password
    const passwordHash = hashSecret(password);
    await pool.query(
      `INSERT INTO auth_credentials (employee_id, email, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [employeeId, email, passwordHash, now],
    );

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
      ).catch(() => {});
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
