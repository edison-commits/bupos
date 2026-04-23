/**
 * R27-M3: POST /api/auth/password-reset-initiate
 *
 * Public endpoint that kicks off the password-reset flow. Takes an
 * email, mints a 256-bit token, emails the reset link via Resend.
 *
 * Security considerations:
 *   • Response is ALWAYS 200 regardless of whether the email is
 *     registered. Distinguishing "email exists" from "doesn't exist"
 *     here would be a user-enumeration oracle — a worse version of
 *     the R27-M1 login-timing finding. The client message reads
 *     "If that email is registered, we sent a reset link."
 *   • Rate-limited per-IP AND per-email. Per-IP caps how fast an
 *     attacker can mint tokens for many addresses; per-email caps
 *     how many reset emails a victim receives in a short window
 *     (to prevent mailbox flooding as a harassment / phishing vector).
 *   • Tokens: 32 random bytes base64url-encoded (43 chars). Single-
 *     use: DELETE on redemption. 1-hour TTL.
 *   • Dedup: re-requesting inside the TTL reuses the same token so
 *     a confused legitimate user doesn't end up with 5 stale
 *     outstanding tokens.
 *   • The reset URL is built from the request's own host, NOT from
 *     a header or env var the client controls — prevents open-redirect
 *     phishing ("reset at evil.com/r?t=...").
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "@/lib/uuid";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getPool } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
import { escapeHtml } from "@/lib/format/html-escape";
import { z } from "zod";

const schema = z.object({
  email: z.string().email().max(320),
});

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url encode
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST(req: NextRequest) {
  // R28-M1: timing equalization. The prior implementation had three
  // observable response-latency branches (no-account: 1 SELECT; exists
  // + no in-flight token: 2 SELECTs + INSERT; exists + in-flight
  // token: 2 SELECTs), letting an attacker enumerate registered emails
  // by timing. Pad every branch to a common floor before returning.
  const startedAt = Date.now();
  const MIN_DURATION_MS = 500;
  const finish = async <T>(payload: T): Promise<T> => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_DURATION_MS) {
      await new Promise((r) => setTimeout(r, MIN_DURATION_MS - elapsed));
    }
    return payload;
  };
  const ok = () => NextResponse.json({ ok: true });

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Swallow — 200 regardless to preserve no-oracle semantics.
    return finish(ok());
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return finish(ok());
  }
  const email = parsed.data.email.trim().toLowerCase();

  // Rate limiting — 3 layers (R28-M10). In-memory per-isolate + KV
  // cross-isolate + DB cross-region, mirroring /api/auth/login. The
  // prior shape was in-memory-only, which at Workers' ~32 isolates per
  // colo let an attacker mint 160 initiate requests per IP per 10 min
  // → at-scale phishing dispatch via our authentic Resend sender.
  // R28-M3: default-deny on x-forwarded-for. See lib/net/client-ip.ts.
  const { clientIpFrom } = await import("@/lib/net/client-ip");
  const clientIp = clientIpFrom(req.headers);
  const ipRl = checkRateLimit(`pwd-reset-ip:${clientIp}`, { maxAttempts: 5, windowMs: 600_000 });
  if (!ipRl.allowed) {
    return finish(ok()); // still 200 — no signal to attacker
  }
  const emailRl = checkRateLimit(`pwd-reset-email:${email}`, { maxAttempts: 3, windowMs: 900_000 });
  if (!emailRl.allowed) {
    return finish(ok());
  }
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvIpRl = await checkKvRateLimit(`pwd-reset-ip:${clientIp}`, { maxAttempts: 10, windowMs: 600_000 });
    if (!kvIpRl.allowed) return finish(ok());
    const kvEmailRl = await checkKvRateLimit(`pwd-reset-email:${email}`, { maxAttempts: 5, windowMs: 900_000 });
    if (!kvEmailRl.allowed) return finish(ok());
  } catch {
    // Fail-open on KV; in-memory + DB layers still cap.
  }
  try {
    const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
    const dbIpRl = await checkDbRateLimit(`pwd-reset-ip:${clientIp}`, { maxAttempts: 15, windowMs: 900_000 });
    if (!dbIpRl.allowed) return finish(ok());
    const dbEmailRl = await checkDbRateLimit(`pwd-reset-email:${email}`, { maxAttempts: 6, windowMs: 900_000 });
    if (!dbEmailRl.allowed) return finish(ok());
  } catch {
    // Fail-open on DB.
  }

  try {
    const pool = await getPool();

    // Look up by the auth_credentials email (the login-email, which
    // R27-M4 now keeps in sync with employees.email). Joining to
    // employees so we can email a human-readable "Hi <first name>".
    const { rows: credRows } = await pool.query(
      // check-pool-org-filter: scoped-by-email-global-unique
      // Pre-auth flow — email is globally unique (lower(email) unique
      // index from migration 051), tenant derives from the match.
      `SELECT ac.employee_id, ac.email AS login_email,
              e.organization_id, e.first_name, e.is_active, e.role_key
         FROM auth_credentials ac
         JOIN employees e ON e.id = ac.employee_id
        WHERE LOWER(ac.email) = LOWER($1)
          AND e.is_active = true
        LIMIT 1`,
      [email],
    );
    const cred = credRows[0] as
      | { employee_id: string; login_email: string; organization_id: string; first_name: string; role_key: string }
      | undefined;

    if (!cred) {
      // No account — return 200 identical to the happy path.
      return finish(ok());
    }

    // Only owner/manager roles use password login (others use PIN
    // via register-login). Non-privileged roles don't need a password
    // reset flow and it would be confusing to offer one.
    if (!["owner", "manager"].includes(cred.role_key)) {
      return finish(ok());
    }

    // R32-D3: tokens are now stored hashed. The dedup-by-reuse path
    // (return same token on re-request) is dead because the raw
    // token isn't recoverable from the DB. Always mint FRESH on
    // re-request — but invalidate any in-flight token by marking
    // it used_at. The user's most recently-sent email is the only
    // one that works; prior links become stale on re-request. This
    // is also a defense-in-depth win: a leaked in-flight link from
    // a prior request gets invalidated the instant the victim (or
    // anyone) requests another reset.
    const { sha256Hex } = await import("@/lib/auth/crypto");
    // Invalidate every outstanding reset for this email.
    await pool.query(
      `UPDATE password_resets SET used_at = now()
        WHERE LOWER(email) = LOWER($1)
          AND used_at IS NULL
          AND expires_at > now()`,
      [email],
    );
    const token: string = mintToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt: Date = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await pool.query(
      `INSERT INTO password_resets (id, employee_id, organization_id, email, token_hash, created_at, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
      [
        randomUUID(),
        cred.employee_id,
        cred.organization_id,
        cred.login_email,
        tokenHash,
        expiresAt.toISOString(),
        clientIp,
        (req.headers.get("user-agent") ?? "").slice(0, 500),
      ],
    );

    // Build the reset URL from the request's own origin (NOT a header
    // the client controls beyond Host, which CSP/CORS already gates).
    const origin = new URL(req.url).origin;
    const resetUrl = `${origin}/admin/password-reset?token=${encodeURIComponent(token)}`;

    // Dispatch the email via Resend. Fire-and-forget routed through
    // waitUntil so a slow Resend call doesn't stretch out the response.
    const apiKey = process.env.RESEND_API_KEY;
    // R36-drift: standardize on RESEND_FROM_EMAIL (the name actually set
    // in prod Cloudflare). Prior shape read RESEND_FROM, which was never
    // set — silently fell through to the fallback, which may not be a
    // verified Resend sender → delivery failures.
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@basicuniformpos.com";
    if (apiKey) {
      const emailPromise = fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [cred.login_email],
          subject: "Reset your BasicUniformPOS password",
          html: `
            <p>Hi ${escapeHtml(cred.first_name)},</p>
            <p>Someone (hopefully you) requested a password reset for your BasicUniformPOS account.</p>
            <p><a href="${escapeHtml(resetUrl)}">Click here to choose a new password</a>.
               This link expires in 1 hour.</p>
            <p>If you didn't request this, you can safely ignore this email — your password hasn't changed.</p>
          `,
        }),
        signal: AbortSignal.timeout(15_000),
      }).then(async (r) => {
        if (!r.ok) {
          const err = await r.text().catch(() => "");
          console.error("[password-reset-initiate] Resend:", safeErr(err));
        }
      }).catch((err) => console.error("[password-reset-initiate] fetch:", safeErr(err)));
      await waitUntilOrAwait(emailPromise);
    } else {
      // R28-M12: structured log so ops monitoring can alert on a
      // misconfigured prod deploy — password-reset is mostly useless
      // without email delivery.
      console.error(
        "[password-reset-initiate]",
        JSON.stringify({
          level: "error",
          event: "resend_api_key_missing",
          at: new Date().toISOString(),
          // R44-LOW: dropped `token_prefix` field — logging 8 chars
          // of a secret-bearing reset token narrowed the brute-force
          // search space for anyone with log access. The operator-
          // useful fact (token minted without email) is captured by
          // the event name + impact.
          impact: "password reset token minted but email NOT sent",
        }),
      );
    }

    return finish(ok());
  } catch (err) {
    console.error("[password-reset-initiate] error:", safeErr(err));
    // Still 200 — don't leak DB errors as a user-enumeration signal.
    return finish(ok());
  }
}

// R28-M5: shared escapeHtml helper — see top-level import.
