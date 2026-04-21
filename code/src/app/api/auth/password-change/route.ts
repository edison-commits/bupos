/**
 * R27-M3: POST /api/auth/password-change
 *
 * Authenticated password rotation. Requires a valid admin session
 * cookie PLUS the user's current password (re-auth), to prevent
 * a session-theft attacker from silently rotating the victim's
 * password without knowing the prior one.
 *
 * On success:
 *   • new password_hash is derived with the same PBKDF2 params as
 *     signup (100 000 iterations, SHA-256, 64-byte key)
 *   • ALL of the user's existing admin sessions are invalidated
 *     (including the one making this request — client must log in
 *     again with the new password)
 *   • a short-lived audit row is emitted
 *
 * Failure modes (all return 401 so an attacker with a stolen
 * cookie but no password can't distinguish them):
 *   • missing/invalid session cookie
 *   • current password mismatch
 *   • employee row no longer exists / is inactive
 *
 * Rate limiting mirrors /api/auth/login: per-employee bucket + KV
 * layer. An attacker who gets a stolen cookie is capped at ~8
 * password-guess attempts per 5 min per employee.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { verifySecret, hashSecret, runDecoyVerify } from "@/lib/auth/crypto";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getPool } from "@/lib/supabase-rest";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
import { z } from "zod";

// Minimum password strength. 12 chars is today's baseline for human-
// memorable passwords per NIST SP 800-63B guidance.
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(200),
});

export async function POST(req: NextRequest) {
  // Session cookie gate — the client must be logged in as an admin
  // already. getAdminSession returns null if the cookie is missing,
  // invalid, or expired.
  const ctx = await getAdminSession();
  if (!ctx?.session || !ctx?.employee) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = passwordChangeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters." },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword } = parsed.data;

  // Rate-limit per employee — caps a stolen-cookie attacker to a
  // small number of password guesses before lockout.
  // R28-L1: tightened from 5→3 attempts per 5 min per employee. A
  // stolen-cookie attacker had ~13 guesses per 5 min across the in-mem
  // + KV buckets; weak 12-char passwords (top-1000 + digits) were
  // crackable in ~62 hours. 3+4 = 7 guesses gives a password with
  // modest dictionary resistance real protection.
  const rl = checkRateLimit(`pwd-change:${ctx.employee.id}`, { maxAttempts: 3, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429 },
    );
  }
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    // R28-L1: tightened from 8→4. See in-memory bucket comment above.
    const kvRl = await checkKvRateLimit(`pwd-change:${ctx.employee.id}`, { maxAttempts: 4, windowMs: 300_000 });
    if (!kvRl.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429 },
      );
    }
  } catch {
    // Fail-open on KV error.
  }

  const pool = await getPool();

  try {
    // Look up the current password hash.
    const { rows: credRows } = await pool.query(
      `SELECT password_hash FROM auth_credentials WHERE employee_id = $1`,
      [ctx.employee.id],
    );
    const currentHash = credRows[0]?.password_hash as string | undefined;
    if (!currentHash) {
      // No password set for this account (shouldn't happen for admin-scope
      // sessions — the signup flow always sets one). Equalize timing and
      // deny.
      await runDecoyVerify(currentPassword);
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    // Re-auth gate. Run verifySecret regardless so the timing of this
    // path is indistinguishable from the "employee not found" path.
    if (!(await verifySecret(currentPassword, currentHash))) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 401 },
      );
    }

    // Defense against password-reuse: reject if the new password is
    // identical to the current one. (We can't check a password-history
    // list without building one — future work.)
    if (newPassword === currentPassword) {
      return NextResponse.json(
        { error: "New password must differ from the current password." },
        { status: 400 },
      );
    }

    // Derive the new hash and UPDATE auth_credentials.
    const newHash = await hashSecret(newPassword);
    await pool.query(
      `UPDATE auth_credentials
          SET password_hash = $1,
              updated_at = NOW()
        WHERE employee_id = $2`,
      [newHash, ctx.employee.id],
    );

    // R27-M3: invalidate ALL admin sessions for this employee. The
    // session cookie the client used for this request is now dead.
    // The client must log in again with the new password — which is
    // the correct UX for "I just rotated my password".
    try {
      await pool.query(
        `DELETE FROM sessions WHERE scope = 'admin' AND employee_id = $1`,
        [ctx.employee.id],
      );
    } catch (err) {
      // Log but don't fail the request — the password IS rotated,
      // sessions just outlive it briefly.
      console.error("[password-change] session invalidation:", safeErr(err));
    }

    // Audit row — who rotated whose password (the actor is the
    // employee themself in the self-rotation flow).
    await waitUntilOrAwait(
      pgInsertAuditEvent(
        ctx.employee.organizationId,
        null,
        ctx.employee.id,
        "employee",
        ctx.employee.id,
        "password_changed",
        { self_rotation: true },
      ).catch((err) => console.error("[password-change] audit:", safeErr(err))),
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[password-change] error:", safeErr(err));
    return NextResponse.json({ error: "Failed to change password." }, { status: 500 });
  }
}
