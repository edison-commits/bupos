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
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getPool } from "@/lib/supabase-rest";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
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

export async function POST(req: NextRequest) {
  // R28-M3: default-deny on x-forwarded-for. See lib/net/client-ip.ts.
  const { clientIpFrom } = await import("@/lib/net/client-ip");
  const clientIp = clientIpFrom(req.headers);
  const rl = checkRateLimit(`pwd-reset-confirm:${clientIp}`, { maxAttempts: 10, windowMs: 600_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
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
    // R28-L6: hash OUTSIDE the transaction so the client connection is
    // held open for milliseconds, not ~100ms. If hashSecret throws,
    // the tx never starts — no rollback needed, and the pool doesn't
    // see ~100ms of per-request pressure under concurrent resets.
    const newHash = await hashSecret(newPassword);

    const pool = await getPool();
    const client = await pool.connect();
    let employeeId: string | null = null;
    let organizationId: string | null = null;
    try {
      await client.query("BEGIN");

      // Atomically consume the token.
      // check-pool-org-filter: scoped-by-password-reset-token-is-proof
      // The 256-bit token is the cryptographic proof of email ownership.
      // The caller hasn't authenticated via cookie; tenant is derived
      // from the matched row.
      // R32-D3: compare against hashed token. DB never stores the raw.
      const { sha256Hex } = await import("@/lib/auth/crypto");
      const tokenHash = await sha256Hex(token);
      const { rows: resetRows } = await client.query(
        `DELETE FROM password_resets
          WHERE token_hash = $1
            AND used_at IS NULL
            AND expires_at > now()
          RETURNING employee_id, organization_id, email`,
        [tokenHash],
      );
      const reset = resetRows[0] as { employee_id: string; organization_id: string; email: string } | undefined;
      if (!reset) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json(
          { error: "This reset link is invalid or has expired. Request a new one." },
          { status: 400 },
        );
      }
      employeeId = reset.employee_id;
      organizationId = reset.organization_id;

      // R40-1: password-reuse history check. Load the CURRENT hash +
      // history under the same tx, verify the new password isn't in
      // the last-N, then atomically rotate + append-old. If the user
      // picks a recent password, reject with 400 — the token stays
      // consumed (the DELETE above already ran) so they must request
      // a new reset link, which is acceptable UX for attempting
      // to reuse a known-bad password.
      const { rows: credRows } = await client.query(
        `SELECT password_hash, prior_password_hashes FROM auth_credentials WHERE employee_id = $1 FOR UPDATE`,
        [employeeId],
      );
      const oldHash = credRows[0]?.password_hash as string | undefined;
      const historyRaw = credRows[0]?.prior_password_hashes;
      if (oldHash) {
        const history = parseHistory(historyRaw);
        try {
          await assertNotReused(newPassword, history);
        } catch (err) {
          if (err instanceof PasswordReuseError) {
            await client.query("ROLLBACK").catch(() => {});
            return NextResponse.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
        const nextHistory = appendHistory(oldHash, history);
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
        // Just set the hash; nothing to append.
        await client.query(
          `UPDATE auth_credentials
              SET password_hash = $1,
                  updated_at = NOW()
            WHERE employee_id = $2`,
          [newHash, employeeId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // R27-M3 + R39-A1-5: invalidate ALL sessions (both admin AND
    // register/PIN scope) for this employee so any attacker holding
    // a stolen cookie — in either scope — is locked out. Prior
    // `scope = 'admin'` filter left the register PIN session alive,
    // meaning a password reset after a phishing incident didn't
    // actually close the compromised surface if the attacker had
    // also picked up a register device.
    if (employeeId) {
      try {
        await pool.query(
          `DELETE FROM sessions WHERE employee_id = $1`,
          [employeeId],
        );
      } catch (err) {
        console.error("[password-reset-confirm] session wipe:", safeErr(err));
      }
    }

    // Audit row.
    if (organizationId && employeeId) {
      await waitUntilOrAwait(
        pgInsertAuditEvent(
          organizationId,
          null,
          employeeId,
          "employee",
          employeeId,
          "password_reset_completed",
          { via: "email_token" },
        ).catch((err) => console.error("[password-reset-confirm] audit:", safeErr(err))),
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[password-reset-confirm] error:", safeErr(err));
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
