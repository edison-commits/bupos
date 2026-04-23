"use server";

import { headers } from "next/headers";
import { signInAdmin, getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { hashSecret, sha256Hex } from "@/lib/auth/crypto";
import { randomUUID } from "@/lib/uuid";
import { safeErr } from "@/lib/logging/safe-err";
// Lazy-import pool-dependent modules to avoid pulling @neondatabase/serverless into the SSR module graph
// pgFindCredentialByEmail and pgInsertAuditEvent are imported dynamically below

// ── Login action (used by useActionState) ─────────────────────────────
export async function loginAction(_prev: { error: string } | null, formData: FormData) {
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // R27-M5: unify the rate-limit bucket with /api/auth/login. The prior
  // key was just `email`, which meant an attacker could double the
  // brute-force budget by rotating between `loginAction` (server action
  // form POST) and `/api/auth/login` (JSON POST) — each had its own
  // per-isolate bucket AND its own KV bucket. With the same namespaced
  // key, both entry points share the bucket.
  const rl = checkRateLimit(`admin-login:${email}`);
  if (!rl.allowed) {
    return { error: "Too many attempts. Try again shortly." };
  }

  // R27-M5: add the same KV layer the /api/auth/login route uses so
  // distributed attacks that span isolates can't double their budget
  // by hitting both entry points.
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvRl = await checkKvRateLimit(`admin-login:${email}`, { maxAttempts: 8, windowMs: 300_000 });
    if (!kvRl.allowed) {
      return { error: "Too many attempts. Try again shortly." };
    }
  } catch {
    // Fail-open on KV error — in-memory bucket above still caps.
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
  await signInAdmin(email, password);
  // Session cookie is set server-side by signInAdmin. Never return sessionId to client.
  return { success: true, redirect: "/admin" } as { success: boolean; redirect: string; error?: string };
  } catch (err) {
    // Audit: log failed admin login attempt (non-fatal — still return error)
    if (process.env.USE_POSTGRES) {
      try {
        const { pgFindCredentialByEmail: findCred, pgInsertAuditEvent: insertAudit } = await import("@/lib/persistence/postgres-store");
        const cred = await findCred(email);
        let orgId: string | null = null;
        if (cred) {
          // Use the per-call Pool facade (getPool) — module-scope pool
          // binds to the first request and fails on concurrent use.
          const { getPool } = await import("@/lib/supabase-rest");
          const pool = await getPool();
          // check-pool-org-filter: scoped-by-just-looked-up-employee-id
          // cred.employeeId came from the email→credential lookup above.
          const { rows } = await pool.query(
            `SELECT organization_id FROM employees WHERE id = $1 LIMIT 1`,
            [cred.employeeId],
          );
          orgId = (rows[0]?.organization_id as string) ?? null;
        }
        // R16-L-1: mirror R15-L-3 — skip DB audit when orgId is null.
        // Passing 'unknown' would fail the `app.current_org_id::uuid` cast
        // inside orgTx and the insert would be silently swallowed by the
        // audit helper's own catch. Unknown-email brute-force probes
        // previously left NO trail. Emit a structured warn log so ops/
        // log-sink alerting can still pattern-match.
        if (orgId) {
          // R43-H4: classify reason (never raw err.message). audit_events
          // .payload is JSONB and is rendered to any admin who expands the
          // row in the audit UI (src/app/admin/audit/page.tsx:466-468).
          // A pg error carries DETAIL fragments with bound-param values
          // (including the attempted email); persisting them into the
          // JSONB and then rendering them verbatim is a self-inflicted
          // data leak. Mirrors `src/app/admin/actions.ts` R42-K fix.
          const reason = err instanceof Error && /Invalid admin credentials/.test(err.message)
            ? "invalid_credentials"
            : "internal_error";
          insertAudit(
            orgId, null, cred?.employeeId ?? null,
            "session", null, "admin_login_failed",
            { email, reason },
          ).catch((auditErr) => console.error("[audit] Failed to insert audit event:", safeErr(auditErr)));
        } else {
          const reason = err instanceof Error && /Invalid admin credentials/.test(err.message)
            ? "invalid_credentials"
            : "internal_error";
          console.warn("[admin_login_failed]", JSON.stringify({
            email_prefix: email.slice(0, 3) + "***",
            reason,
            at: new Date().toISOString(),
          }));
        }
      } catch {
        // audit lookup failed — skip audit, still return error
      }
    }
    return { error: "Invalid email or password." };
  }

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

  // R42-J: align minimum with password-change + password-reset-confirm
  // (both enforce 12). Signup was the only path that minted 8-char
  // credentials, which could then live indefinitely on owner accounts
  // — a weaker-than-rotation baseline. Inconsistency also telegraphs
  // to an attacker which handler they're talking to.
  if (password.length < 12) {
    return { error: "Password must be at least 12 characters." };
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

  // Per-IP rate limit so a single attacker can't cycle through fresh emails
  // to mint unlimited orgs (each signup creates org + location + employee +
  // auth_credentials rows, which also inflates the pin-collision scan cost
  // on register-login).
  //
  // R22-H-2: prior shape (R21-L-4) randomized the bucket with `unknown-
  // ${randomUUID()}` when CF headers were absent. That eliminated the
  // cross-tenant DoS but opened a full rate-limit bypass — strip
  // `cf-connecting-ip` + `x-forwarded-for` on a direct workers.dev URL
  // and every request gets a fresh bucket.
  //
  // R28-M3: spoof-resistant client IP resolution. Pure XFF is only
  // trusted when TRUST_FORWARDED_FOR=1 is explicitly set. In prod,
  // REFUSE signups without a proven client IP.
  // Non-prod falls back to randomized bucket so dev / tests still work.
  const { clientIpFrom } = await import("@/lib/net/client-ip");
  const resolvedIp = clientIpFrom(requestHeaders);
  const rawIp = resolvedIp === "unknown" ? null : resolvedIp;
  if (!rawIp && process.env.NODE_ENV === "production") {
    return { error: "Too many signups from this network. Try again later." };
  }
  const clientIp = rawIp ?? `unknown-${randomUUID()}`;
  const ipRl = checkRateLimit(`signup-ip:${clientIp}`, { maxAttempts: 3, windowMs: 3_600_000 });
  if (!ipRl.allowed) {
    return { error: "Too many signups from this network. Try again later." };
  }

  // R8-M-11: KV layer for cross-isolate coherence. Signups are the
  // highest-value target for the pin-collision-cost amplification attack
  // (each new org grows pgFindCredentialByPin's scan cost), so layer
  // KV on top of the in-memory IP bucket.
  const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
  const kvSignupRl = await checkKvRateLimit(`signup-ip:${clientIp}`, { maxAttempts: 5, windowMs: 3_600_000 });
  if (!kvSignupRl.allowed) {
    return { error: "Too many signups from this network. Try again later." };
  }

  // R27-L4: per-email rate limit. The R23-M-3 atomic INSERT-or-replace-
  // expired close most of the race, but an attacker can still churn
  // pending-signup rows on a victim's email faster than the victim can
  // verify — 3 attempts per 5 min is loose enough that a legitimate
  // retry after an email-delivery lag works fine, but tight enough that
  // mass-racing a specific address is infeasible. Keyed on lower(email)
  // to match the pending_signups unique index.
  const emailRl = checkRateLimit(`signup-email:${email}`, { maxAttempts: 3, windowMs: 300_000 });
  if (!emailRl.allowed) {
    return { error: "Too many signup attempts for this email. Try again shortly." };
  }

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

  // R8-M-12 + R8-L-5 + R21-H-6 closed: two-step verified signup that
  // equalizes timing between the "email taken" and "email available"
  // branches.
  //
  // Prior shape (R8): the taken branch skipped the INSERT (~30ms) AND
  // the Resend send (100-500ms), while the untaken branch did both.
  // Same response text, but an attacker could time-probe which emails
  // are registered. R21 audit flagged this as a still-open enumeration
  // oracle via timing.
  //
  // Fix: always do one INSERT-equivalent DB roundtrip, and gate both
  // branches behind a shared MIN_DURATION_MS floor so the external
  // observable latency is dominated by the padding, not the branch.
  //
  // We intentionally do NOT send a real "your email is already
  // registered" email on the taken branch — that would send unsolicited
  // mail to arbitrary-typed addresses (typo of a stranger's email).
  const MIN_DURATION_MS = 500;
  const startedAt = Date.now();
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();

    const passwordHash = await hashSecret(password);
    // 32-byte URL-safe token. Cryptographically random, base64url encoded.
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const verificationToken = btoa(String.fromCharCode(...tokenBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // R32-D3: hash the token at rest. The DB stores only sha256(token);
    // the raw token lives exclusively in the email we send the user.
    // A read-only DB compromise / backup leak / log sink can no longer
    // be turned into working verify links.
    const verificationTokenHash = await sha256Hex(verificationToken);

    // Check WITHOUT leaking — if email is already in use (either as a
    // confirmed auth_credentials row OR an unexpired pending_signups
    // row), we silently skip the pending_signups INSERT. The user still
    // sees the generic "check your inbox" reply.
    const { rows: existingCreds } = await pool.query(
      `SELECT 1 FROM auth_credentials WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const { rows: existingPending } = await pool.query(
      `SELECT 1 FROM pending_signups
        WHERE lower(email) = lower($1)
          AND expires_at > now() LIMIT 1`,
      [email],
    );
    const alreadyTaken = existingCreds.length > 0 || existingPending.length > 0;

    if (!alreadyTaken) {
      // R22-H-1 + R23-M-3: the `uniq_pending_signups_email_lower` index
      // from migration 051 covers ALL rows including expired ones. The
      // `alreadyTaken` check above only excludes `expires_at > now()`,
      // so a prior abandoned signup whose TTL lapsed but whose row
      // hasn't been swept by `cleanup_stale_pending_signups` (retention
      // is 7 days) would cause the INSERT to 23505. The R22-H-1 fix
      // pre-deleted expired rows before INSERT — which created a 24-hour
      // DoS: right after Alice's token expired, attacker could sign up
      // with Alice's email, DELETE Alice's row, land their own row
      // under Alice's email, and block Alice from retrying for up to
      // 24 hours (R23-M-3).
      //
      // R23-M-3 fix: use `INSERT ... ON CONFLICT (lower(email)) DO UPDATE`
      // ONLY when the existing row is expired. That atomically replaces
      // the victim's dead row with the attacker's — no window where
      // Alice can retry and find no row to recover. More importantly:
      // combined with the alreadyTaken check above (which rejects when
      // a NON-expired row exists), an attacker cannot race the victim
      // because the only rows reachable by the UPSERT are the ones the
      // victim already can't verify.
      //
      // Implementation: the unique index is on the EXPRESSION
      // `lower(email)`, not a column, so `ON CONFLICT (lower(email))`
      // requires the index to be declared with matching predicate.
      // The partial nature (WHERE email IS NOT NULL on the existing
      // index) makes ON CONFLICT ambiguous — we use ON CONFLICT ON
      // CONSTRAINT instead. Actually the easiest path is to target
      // the constraint by its index name via ON CONFLICT. Tests show
      // `ON CONFLICT (lower(email))` works with expression indexes
      // when the predicate matches.
      //
      // Safer/simpler variant: do the INSERT inside a single tx that
      // first DELETEs-if-expired and then INSERTs. If both steps are in
      // ONE transaction, the attacker's concurrent attempt either loses
      // to ours (SERIALIZABLE retry) or sees our committed row and
      // gives up via the 23505 catch below. Either way Alice isn't
      // wedged.
      const txClient = await pool.connect();
      try {
        await txClient.query("BEGIN");
        // Lock the potentially-conflicting row so a concurrent delete
        // can't disappear it between our SELECT and our INSERT.
        // check-pool-org-filter: scoped-by-pending-signup-auth-flow
        await txClient.query(
          `DELETE FROM pending_signups
             WHERE lower(email) = lower($1)
               AND expires_at <= now()`,
          [email],
        );
        try {
          // R32-D3: store the HASH; the raw token travels only in
          // the verification email.
          await txClient.query(
            `INSERT INTO pending_signups (email, store_name, first_name, last_name, password_hash, verification_token_hash)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [email, storeName, firstName, lastName, passwordHash, verificationTokenHash],
          );
          await txClient.query("COMMIT");
        } catch (insertErr) {
          await txClient.query("ROLLBACK").catch(() => {});
          const code = (insertErr as { code?: string }).code;
          if (code !== "23505") throw insertErr; // real error — surface via outer catch
          // 23505: a truly-concurrent sibling beat us. User sees the
          // same generic response. Attacker-racing-victim is now
          // limited to the narrow instant when both signups transact
          // at the same millisecond — the pre-delete + INSERT
          // happening atomically eliminates the 24-hour exposure
          // window R22-H-1 introduced.
        }
      } finally {
        txClient.release();
      }

      // Send verification email. Dev fallback: logs the link to console
      // if RESEND_* is not configured.
      const appUrl = process.env.APP_URL ?? (host ? `${origin?.startsWith("https") ? "https" : "http"}://${host}` : "http://localhost:3000");
      const verificationUrl = `${appUrl}/api/auth/verify?token=${encodeURIComponent(verificationToken)}`;

      const { sendVerificationEmail } = await import("@/lib/email/send-verification");
      // R42-O: fire-and-forget the Resend call via waitUntilOrAwait so
      // a slow cold-start response (observed 200-500ms in practice)
      // doesn't exceed the MIN_DURATION_MS floor and create a timing
      // oracle vs. the email-already-taken branch (which has no such
      // awaited network I/O). On Workers the runtime extends the
      // isolate lifetime to let the send complete; in Node it
      // synchronously awaits (no observable difference in dev).
      const { waitUntilOrAwait } = await import("@/lib/runtime/wait-until");
      await waitUntilOrAwait(
        sendVerificationEmail({ to: email, firstName, verificationUrl })
          .catch((emailErr: unknown) => {
            // R8-L-5: don't distinguish send-failed from email-taken in
            // the user-facing response. Log for ops visibility only.
            console.error(
              "[signupAction] verification email failed:",
              emailErr instanceof Error ? emailErr.message.slice(0, 200) : "unknown",
            );
          }),
      );
    } else {
      // R21-H-6: execute a DB roundtrip of equivalent cost so the two
      // branches don't differ by the INSERT's ~30ms. The MIN_DURATION
      // floor below handles the email-send gap.
      // check-pool-org-filter: scoped-by-pending-signup-auth-flow
      await pool.query(
        `SELECT id FROM pending_signups WHERE lower(email) = lower($1) AND false`,
        [email],
      );
    }
  } catch (e: unknown) {
    // R45-M: log via safeErr so pg DETAIL / bound params can't leak
    // into Workers log retention. The `msg` string derivation pattern
    // bypassed the `check-no-raw-err-log.mjs` CATCH_IDENT_RX gate.
    console.error("Signup error:", safeErr(e));
    // Generic response regardless — don't leak internal errors OR email
    // existence.
  } finally {
    // R21-H-6: equalize timing. Hold the response until MIN_DURATION_MS
    // elapsed regardless of which branch executed. Attackers measuring
    // wall-clock latency see the same distribution for taken vs. untaken.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_DURATION_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DURATION_MS - elapsed));
    }
  }

  // ALWAYS the same response. R8-L-5 enumeration oracle closed.
  return { error: "If that email isn't already registered, check your inbox for a verification link." };
}
