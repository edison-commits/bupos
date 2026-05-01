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
import { checkOrigin } from "@/lib/api/with-auth";
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

const MAX_BODY_BYTES = 16 * 1024; // 16KB is plenty for a password body

export async function POST(req: NextRequest) {
  // R81-SEC-M: defense-in-depth Origin + body-size checks. SameSite=
  // Lax on the session cookie is the primary CSRF defense; this adds
  // an explicit Origin check (parity with /api/auth/login and
  // /api/auth/revoke-all-sessions) and rejects >16KB bodies so a
  // pre-auth JSON bomb can't tie up the handler.
  const originErr = checkOrigin(req);
  if (originErr) return originErr;
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

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

  // AUTH-AUDIT4-MED3: DB-layer rate-limit backstop. Without this,
  // KV unavailability (binding rename / namespace outage) reduces
  // the password-change gate to per-isolate in-memory only — on
  // Workers ~32 isolates that's effectively 3 × 32 = 96 password
  // guesses per 5 min per employee with a stolen cookie. /api/auth/
  // login already has the 3-layer (mem/KV/DB) defense; mirror it
  // here so password-change can't be brute-forced via KV outage.
  try {
    const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
    const dbRl = await checkDbRateLimit(`pwd-change:${ctx.employee.id}`, { maxAttempts: 6, windowMs: 600_000 });
    if (!dbRl.allowed) {
      logRateLimited({ bucket: "pwd-change", layer: "db", actor });
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429 },
      );
    }
  } catch {
    // Fail-open on DB rate-limit error — the mem + KV layers above
    // still gate, and a DB outage means the password-change can't
    // actually mutate the row anyway.
  }

  try {
    // R52-C / R54-Framework-1 / R56-B3: password rotation + session
    // wipe + audit all atomic, but with NO CPU-heavy work held under
    // a row lock.
    //
    // R56-B3 moves BOTH the re-auth verifySecret AND the reuse-
    // history assertNotReused OUT of the orgTx. Prior shape held
    // `auth_credentials FOR UPDATE` across:
    //   • verifySecret (PBKDF2 ~100ms)
    //   • assertNotReused (iterates up to HISTORY_CAP=10 PBKDF2
    //     verifications, worst case ~1s)
    // That serialized every other cred-read on the same employee
    // (including revoke-all-sessions / employees PATCH step-up)
    // for up to ~1.1s per rotation.
    //
    // New shape:
    //   1. Non-locking SELECT snapshot of (password_hash, history,
    //      updated_at).
    //   2. verifySecret + reuse-history check outside any tx.
    //   3. hashSecret(newPassword) outside tx (R54-Framework-1).
    //   4. orgTx → SELECT FOR UPDATE → compare updated_at vs
    //      snapshot; if it drifted, another rotation landed while
    //      we were verifying — reject with 409 (caller retries).
    //   5. UPDATE + DELETE sessions + audit + COMMIT.
    //
    // TOCTOU guard (step 4) keeps the reuse-history semantics safe
    // even though we let go of the lock.
    const orgId = ctx.employee.organizationId;
    const { orgQuery } = await import("@/lib/supabase-rest");

    // (1) Non-locking snapshot.
    const { rows: snapRows } = await orgQuery(
      orgId,
      `SELECT password_hash, prior_password_hashes, updated_at
         FROM auth_credentials
        WHERE employee_id = $1 LIMIT 1`,
      [ctx.employee.id],
    );
    const snap = snapRows[0] as
      | { password_hash: string | null; prior_password_hashes: unknown; updated_at: string | Date }
      | undefined;
    const currentHash = snap?.password_hash ?? undefined;
    if (!currentHash) {
      // No password set for this account.
      await runDecoyVerify(currentPassword);
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    // (2) Re-auth gate OUTSIDE the tx.
    if (!(await verifySecret(currentPassword, currentHash))) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 401 },
      );
    }
    if (newPassword === currentPassword) {
      return NextResponse.json(
        { error: "New password must differ from the current password." },
        { status: 400 },
      );
    }
    const history = parseHistory(snap?.prior_password_hashes);
    try {
      await assertNotReused(newPassword, history);
    } catch (err) {
      if (err instanceof PasswordReuseError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    // (3) Hash new password OUTSIDE the tx.
    const newHash = await hashSecret(newPassword);
    const nextHistory = appendHistory(currentHash, history);
    const snapUpdatedAt = new Date(snap!.updated_at).getTime();

    // (4/5) Tx: re-read with FOR UPDATE, compare updated_at, UPDATE,
    // revoke sessions, audit, COMMIT.
    const client = await orgTx(orgId);
    try {
      const { rows: lockedRows } = await client.query(
        `SELECT password_hash, updated_at FROM auth_credentials
          WHERE employee_id = $1 FOR UPDATE`,
        [ctx.employee.id],
      );
      const locked = lockedRows[0] as { password_hash: string | null; updated_at: string | Date } | undefined;
      if (!locked?.password_hash) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Not signed in." }, { status: 401 });
      }
      // R58-3: TOCTOU guard uses BOTH updated_at AND password_hash
      // equality. Prior shape relied only on `updated_at`, which
      // `new Date().getTime()` truncates to millisecond precision —
      // two rotations within the same millisecond would slip past.
      // password_hash is the deterministic anchor: PBKDF2 output
      // depends on the password + salt, so any rotation changes it
      // regardless of clock precision (and the reuse-history check
      // upstream rejects same-password re-rotation). Mirrors the
      // revoke-all-sessions pattern (R56-B4).
      const lockedUpdatedAt = new Date(locked.updated_at).getTime();
      const updatedAtDrifted = Math.abs(lockedUpdatedAt - snapUpdatedAt) > 0;
      const hashDrifted = locked.password_hash !== currentHash;
      if (updatedAtDrifted || hashDrifted) {
        // Credential rotated between snapshot and lock — another
        // /password-change or /password-reset-confirm landed in
        // parallel. Reject; caller retries with the fresh state.
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Password was changed in another session. Please sign in again." },
          { status: 409 },
        );
      }

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

      // R52-C: audit INSIDE the tx.
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
