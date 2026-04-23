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
import {
  parseHistory,
  assertNotReused,
  appendHistory,
  PasswordReuseError,
} from "@/lib/auth/password-history";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { safeErr } from "@/lib/logging/safe-err";
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
  // R47-M: structured 429 log so credential-stuffing against
  // password-change shows up in Logpush / Axiom alerting.
  const { logRateLimited } = await import("@/lib/logging/rate-limit-log");
  const actor = `actor:${ctx.employee.id.slice(0, 8)}`;

  const rl = checkRateLimit(`pwd-change:${ctx.employee.id}`, { maxAttempts: 3, windowMs: 300_000 });
  if (!rl.allowed) {
    logRateLimited({ bucket: "pwd-change", layer: "mem", actor });
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
      logRateLimited({ bucket: "pwd-change", layer: "kv", actor });
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429 },
      );
    }
  } catch {
    // Fail-open on KV error.
  }

  try {
    // R52-C: move the password rotation + session revocation + audit
    // INTO a single orgTx. Prior shape used pool.query() (auto-
    // commit) for each of UPDATE auth_credentials, DELETE sessions,
    // and then a post-commit fire-and-forget audit insert. On
    // Workers isolate freeze the audit could be lost — and password
    // rotation is precisely the event that forensic review depends
    // on. Everything atomic now.
    //
    // R54-Framework-1: derive `newHash` (PBKDF2 100k iters, ~100ms
    // of blocking CPU) OUTSIDE the tx so the `FOR UPDATE` row lock
    // on auth_credentials isn't held during hashing. Matches the
    // sibling pattern in /api/auth/password-reset-confirm (R28-L6
    // comment). Under two concurrent rotations against the same
    // employee, the second rotation would otherwise wait ~100ms+
    // on the lock while also holding a pool connection; Workers'
    // per-call `makePool(1)` makes this a contention cliff.
    const newHash = await hashSecret(newPassword);

    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // Look up the current password hash + history (R40-1).
      // SELECT FOR UPDATE so a second concurrent rotation on the
      // same employee can't race past the reuse-history check.
      const { rows: credRows } = await client.query(
        `SELECT password_hash, prior_password_hashes FROM auth_credentials WHERE employee_id = $1 FOR UPDATE`,
        [ctx.employee.id],
      );
      const currentHash = credRows[0]?.password_hash as string | undefined;
      const historyRaw = credRows[0]?.prior_password_hashes;
      if (!currentHash) {
        // No password set for this account (shouldn't happen for admin-
        // scope sessions — the signup flow always sets one). Equalize
        // timing and deny.
        await client.query("ROLLBACK");
        await runDecoyVerify(currentPassword);
        return NextResponse.json({ error: "Not signed in." }, { status: 401 });
      }

      // Re-auth gate. Run verifySecret regardless so the timing of
      // this path is indistinguishable from the "employee not found"
      // path.
      if (!(await verifySecret(currentPassword, currentHash))) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Current password is incorrect." },
          { status: 401 },
        );
      }

      // Defense against password-reuse:
      //   (a) fast equality check against the CURRENT password
      //   (b) R40-1: verify against the last-N hash history so a
      //       `old → new → old` rotation can't cycle to bypass
      //       breach-list-driven mandatory rotations.
      if (newPassword === currentPassword) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "New password must differ from the current password." },
          { status: 400 },
        );
      }
      const history = parseHistory(historyRaw);
      try {
        await assertNotReused(newPassword, history);
      } catch (err) {
        if (err instanceof PasswordReuseError) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
      }

      // Append the OLD hash to the history at the same time so a
      // future rotation sees it. (newHash was derived pre-tx above.)
      const nextHistory = appendHistory(currentHash, history);
      await client.query(
        `UPDATE auth_credentials
            SET password_hash = $1,
                prior_password_hashes = $2::jsonb,
                updated_at = NOW()
          WHERE employee_id = $3`,
        [newHash, JSON.stringify(nextHistory), ctx.employee.id],
      );

      // R27-M3 / R39-A1-5: invalidate ALL sessions for this employee
      // (both admin and register scopes).
      await client.query(
        `DELETE FROM sessions WHERE employee_id = $1`,
        [ctx.employee.id],
      );

      // R52-C: audit INSIDE the tx. password_changed is the exact
      // event forensics depends on ("who rotated whose password, and
      // when"); post-commit fire-and-forget is a drop vector.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'password_changed', $6, now())`,
        [
          randomUUID(), orgId, null, ctx.employee.id, ctx.employee.id,
          JSON.stringify({ self_rotation: true }),
        ],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[password-change] error:", safeErr(err));
    return NextResponse.json({ error: "Failed to change password." }, { status: 500 });
  }
}
