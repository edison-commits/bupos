/**
 * R27-M3: POST /api/auth/password-reset-confirm
 *
 * Redeems a password-reset token + new password → rotates the
 * credential + kills all existing admin sessions for the employee.
 *
 * Atomicity:
 *   • The token is DELETEd-RETURNING inside the same transaction
 *     as the password_hash UPDATE. If the UPDATE fails, the token
 *     is NOT consumed (client can retry). If the UPDATE succeeds
 *     but the session-delete fails, the password is rotated but
 *     sessions live until TTL (acceptable — admin inactivity
 *     timeout still applies, and we log the discrepancy).
 *
 * Token validation:
 *   • shape: base64url-style 43 chars ([A-Za-z0-9_-]{43})
 *   • row exists AND not expired AND not already used
 *   • (no org scoping needed — token is globally-unique cryptographic
 *     proof of possession of the reset email)
 *
 * Rate-limit:
 *   • per-IP bucket caps how fast a random attacker can try tokens
 *     (1/3^32 per try is effectively impossible, but the bucket
 *     stops a pathological load generator anyway)
 */

import { NextRequest, NextResponse } from "next/server";
import { hashSecret } from "@/lib/auth/crypto";
import { checkOrigin } from "@/lib/api/with-auth";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getPool } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { safeErr } from "@/lib/logging/safe-err";
import {
  parseHistory,
  assertNotReused,
  appendHistory,
  PasswordReuseError,
} from "@/lib/auth/password-history";
import { z } from "zod";

const schema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Invalid token"),
  newPassword: z.string().min(12).max(200),
});

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  // R81-SEC-M: Origin + body-size as defense-in-depth (parity with
  // password-change + login).
  const originErr = checkOrigin(req);
  if (originErr) return originErr;
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  // R28-M3: default-deny on x-forwarded-for. See lib/net/client-ip.ts.
  const { clientIpFrom } = await import("@/lib/net/client-ip");
  const clientIp = clientIpFrom(req.headers);
  const { logRateLimited } = await import("@/lib/logging/rate-limit-log");

  // AUTH-AUDIT6-MED1: 3-layer rate limit (mem / KV / DB), parity with
  // /password-reset-initiate. The reset token is 256-bit so online
  // guessing is infeasible regardless; these layers cap the CPU +
  // write pressure an unauthenticated attacker can drive. Prior shape
  // was in-memory only — on ~32 Workers isolates/colo that degraded to
  // ~320/10min/IP with no cross-isolate coherence, diverging from the
  // documented 3-layer standard the rest of the auth surface enforces.
  const rl = checkRateLimit(`pwd-reset-confirm:${clientIp}`, { maxAttempts: 10, windowMs: 600_000 });
  if (!rl.allowed) {
    // R47-M: structured 429 log for ops alerting.
    logRateLimited({ bucket: "pwd-reset-confirm", layer: "mem", actor: clientIp });
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvRl = await checkKvRateLimit(`pwd-reset-confirm:${clientIp}`, { maxAttempts: 15, windowMs: 600_000 });
    if (!kvRl.allowed) {
      logRateLimited({ bucket: "pwd-reset-confirm", layer: "kv", actor: clientIp });
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }
  } catch {
    // Fail-open on KV error — the mem layer above + DB layer below gate.
  }
  try {
    const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
    const dbRl = await checkDbRateLimit(`pwd-reset-confirm:${clientIp}`, { maxAttempts: 30, windowMs: 1_800_000 });
    if (!dbRl.allowed) {
      logRateLimited({ bucket: "pwd-reset-confirm", layer: "db", actor: clientIp });
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }
  } catch {
    // Fail-open on DB error — the mem + KV layers above still gate.
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Token and password (≥12 chars) are required." },
      { status: 400 },
    );
  }
  const { token, newPassword } = parsed.data;

  try {
    // AUTH-AUDIT6-MED1: defer hashSecret(newPassword) until AFTER the
    // token row is validated (below). Prior shape computed the ~100ms
    // PBKDF2 here — before the token lookup — so an attacker spraying
    // random/expired tokens with a well-formed body forced one PBKDF2
    // per request even though the token would be rejected. An invalid
    // token now short-circuits with zero hashing cost. The hash is
    // still computed OUTSIDE the transaction (R28-L6) once we know the
    // token is good.

    // R58-4: also move the reset-token lookup + password-reuse check
    // OUTSIDE the tx. Prior shape held `auth_credentials FOR UPDATE`
    // across `assertNotReused` which iterates up to 5 PBKDF2
    // verifications (~500ms CPU). That starved concurrent
    // /password-change flows for the same employee. Mirrors the
    // R56-B3 pattern on password-change.
    //
    // The token is still consumed atomically in the tx below (via
    // DELETE … RETURNING, ensuring single-use semantics against a
    // concurrent reset replay).
    const { sha256Hex } = await import("@/lib/auth/crypto");
    const tokenHash = await sha256Hex(token);

    const pool = await getPool();

    // (1) Non-locking lookup to identify the target employee +
    // pull the password-reuse history. The token row is NOT
    // consumed here — the tx below re-checks and deletes.
    const { rows: snapResetRows } = await pool.query(
      `SELECT employee_id, organization_id
         FROM password_resets
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      [tokenHash],
    );
    const snapReset = snapResetRows[0] as { employee_id: string; organization_id: string } | undefined;
    if (!snapReset) {
      return NextResponse.json(
        { error: "This reset link is invalid or has expired. Request a new one." },
        { status: 400 },
      );
    }
    const employeeId: string = snapReset.employee_id;
    const organizationId: string = snapReset.organization_id;

    // (2) Snapshot the credential's current hash + history.
    const { rows: snapCredRows } = await pool.query(
      `SELECT password_hash, prior_password_hashes, updated_at
         FROM auth_credentials
        WHERE employee_id = $1 LIMIT 1`,
      [employeeId],
    );
    const snapCred = snapCredRows[0] as
      | { password_hash: string | null; prior_password_hashes: unknown; updated_at: string | Date }
      | undefined;
    const snapHash = snapCred?.password_hash ?? null;
    const snapUpdatedAt = snapCred ? new Date(snapCred.updated_at).getTime() : 0;

    // (3) assertNotReused OUTSIDE any tx (so the ~500ms PBKDF2
    // iteration doesn't hold a credential row lock).
    if (snapHash) {
      const history = parseHistory(snapCred!.prior_password_hashes);
      try {
        await assertNotReused(newPassword, history);
      } catch (err) {
        if (err instanceof PasswordReuseError) {
          return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
      }
    }

    // AUTH-AUDIT6-MED1: token + reuse checks passed — NOW hash the new
    // password (still outside any tx, per R28-L6). Deferring to here
    // means a sprayed invalid/expired token costs zero PBKDF2.
    const newHash = await hashSecret(newPassword);

    // (4) Tx: atomically consume the token, re-read credential with
    // FOR UPDATE + TOCTOU guard, UPDATE, revoke sessions, audit.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // R32-D3: consume the token (DELETE … RETURNING is atomic vs
      // a concurrent replay).
      const { rows: resetRows } = await client.query(
        `DELETE FROM password_resets
          WHERE token_hash = $1
            AND used_at IS NULL
            AND expires_at > now()
          RETURNING employee_id, organization_id, email`,
        [tokenHash],
      );
      const reset = resetRows[0] as { employee_id: string; organization_id: string; email: string } | undefined;
      if (!reset || reset.employee_id !== employeeId) {
        // A concurrent reset consumed this token, OR the snapshot
        // we read is for a different employee (shouldn't happen
        // given token uniqueness). Reject; the original snapshot
        // assertions no longer apply.
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json(
          { error: "This reset link is invalid or has expired. Request a new one." },
          { status: 400 },
        );
      }

      // R58-4: TOCTOU guard via SELECT FOR UPDATE + (hash, updated_at)
      // equality. If the credential rotated during our reuse-check
      // window (e.g. the user changed their password via
      // /password-change in parallel), reject — the reuse-check was
      // against stale data.
      const { rows: lockedRows } = await client.query(
        `SELECT password_hash, prior_password_hashes, updated_at
           FROM auth_credentials
          WHERE employee_id = $1 FOR UPDATE`,
        [employeeId],
      );
      const locked = lockedRows[0] as
        | { password_hash: string | null; prior_password_hashes: unknown; updated_at: string | Date }
        | undefined;
      if (locked) {
        const lockedUpdatedAt = new Date(locked.updated_at).getTime();
        const updatedAtDrifted = Math.abs(lockedUpdatedAt - snapUpdatedAt) > 0;
        const hashDrifted = (locked.password_hash ?? null) !== snapHash;
        if (updatedAtDrifted || hashDrifted) {
          await client.query("ROLLBACK").catch(() => {});
          return NextResponse.json(
            { error: "Password was changed in another session. Please request a new reset link." },
            { status: 409 },
          );
        }
      }

      if (snapHash) {
        const nextHistory = appendHistory(snapHash, parseHistory(snapCred!.prior_password_hashes));
        await client.query(
          `UPDATE auth_credentials
              SET password_hash = $1,
                  prior_password_hashes = $2::jsonb,
                  updated_at = NOW()
            WHERE employee_id = $3`,
          [newHash, JSON.stringify(nextHistory), employeeId],
        );
      } else {
        // No existing hash (unusual — reset on a never-signed-in account).
        await client.query(
          `UPDATE auth_credentials
              SET password_hash = $1,
                  updated_at = NOW()
            WHERE employee_id = $2`,
          [newHash, employeeId],
        );
      }

      // R52-D: session wipe + audit INSIDE the tx. Prior shape ran
      // the DELETE via pool.query() post-COMMIT (leaving a window
      // where the password was rotated but stolen sessions still
      // worked), and the audit was a fire-and-forget
      // `waitUntilOrAwait(pgInsertAuditEvent)` AFTER commit —
      // drop-prone on Workers isolate freeze. Both now land atomic
      // with the password rotation.
      //
      // R27-M3 + R39-A1-5: invalidate ALL sessions (both admin AND
      // register/PIN scope) for this employee so any attacker
      // holding a stolen cookie — in either scope — is locked out.
      await client.query(
        `DELETE FROM sessions WHERE employee_id = $1`,
        [employeeId],
      );

      // password_reset_completed audit — the ground truth a post-
      // breach investigation uses to trace "which resets went
      // through this phishing token batch."
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'password_reset_completed', $6, now())`,
        [
          randomUUID(), organizationId, null, employeeId, employeeId,
          JSON.stringify({ via: "email_token" }),
        ],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[password-reset-confirm] error:", safeErr(err));
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
