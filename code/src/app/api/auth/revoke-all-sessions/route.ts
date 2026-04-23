/**
 * R27-M3: POST /api/auth/revoke-all-sessions
 *
 * Authenticated nuclear-option: delete every admin session for the
 * caller (including the one making this request). The cookie is
 * cleared in the response so the browser also drops its stored
 * reference.
 *
 * Intended use: user discovers their laptop is stolen, their
 * password is in a breach dump, or they just want to rotate all
 * their sessions on a schedule.
 *
 * Does NOT rotate the password — the user logs back in with the
 * same password. For password-rotation use /api/auth/password-change
 * (which also revokes sessions as a side effect).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { verifySecret, runDecoyVerify } from "@/lib/auth/crypto";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { safeErr } from "@/lib/logging/safe-err";
import { checkOrigin } from "@/lib/api/with-auth";
import { z } from "zod";

// R41-2: opaque cookie name (see session.ts for rationale).
const ADMIN_COOKIE = "bupos_a";
const OLD_ADMIN_COOKIE = "basicuniformpos_admin_session";

const revokeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  // CSRF guard — same-origin check mirrors the with-auth wrapper.
  const originErr = checkOrigin(req);
  if (originErr) return originErr;

  const ctx = await getAdminSession();
  if (!ctx?.session || !ctx?.employee) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // R28-M11: require password re-auth. Same-origin CSRF (via stored
  // XSS on any admin page) can otherwise `fetch()` this endpoint with
  // credentials and lock the admin out — a full denial-of-service
  // from any tiny XSS sink. Requiring the current password means the
  // XSS payload would need to scrape the password too (much harder
  // against a browser that doesn't autofill admin fields).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Password required to revoke all sessions." },
      { status: 400 },
    );
  }
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Password required to revoke all sessions." },
      { status: 400 },
    );
  }
  const { currentPassword } = parsed.data;

  // Per-employee rate limit on the re-auth check (same bucket key as
  // /password-change so an attacker with a stolen cookie can't use
  // one endpoint to brute-force while the other is rate-limited).
  // R30-H6: align the in-mem cap AND add a KV layer so revoke-all-
  // sessions can't be used as a softer brute-force target vs the
  // tightened /password-change (R28-L1 at 3/5min + KV 4/5min). Prior
  // shape was 5 in-mem with NO KV — an attacker with ~32 cross-isolate
  // Workers could get up to 160 password guesses per 5 min before
  // lockout, vs 4 on password-change.
  // R47-M: structured 429 log (shares `pwd-change` bucket with the
  // password-change route — both gate on the same employee password).
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
    const kvRl = await checkKvRateLimit(`pwd-change:${ctx.employee.id}`, {
      maxAttempts: 4, windowMs: 300_000,
    });
    if (!kvRl.allowed) {
      logRateLimited({ bucket: "pwd-change", layer: "kv", actor });
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429 },
      );
    }
  } catch {
    // Fail-open on KV error; in-memory bucket still caps.
  }

  try {
    // R52-E: wrap re-auth lookup + DELETE sessions + audit INSERT in
    // ONE orgTx. Prior shape ran the credential SELECT and DELETE
    // via pool.query() auto-commit (plus a fire-and-forget audit),
    // leaving a ~1-50ms TOCTOU window where a concurrent
    // /api/auth/password-change could rotate credentials between the
    // verify step and the DELETE — the attacker's cookie verifying
    // against the prior password but wiping new-password-era
    // sessions. Unifying under one orgTx with `SELECT FOR UPDATE`
    // on auth_credentials (mirrors R52-C password-change) closes
    // the window and makes the audit row atomic.
    //
    // R54-L1: collapsed the 2-try-block shape into one.
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R36-H6: org-scope the credential lookup as defense-in-depth.
      // Mirror the employees PATCH pattern (require the employee row
      // to exist in this org).
      const { rows: credRows } = await client.query(
        `SELECT password_hash FROM auth_credentials
          WHERE employee_id = $1
            AND employee_id IN (SELECT id FROM employees WHERE organization_id = $2)
          FOR UPDATE`,
        [ctx.employee.id, orgId],
      );
      const currentHash = credRows[0]?.password_hash as string | undefined;
      if (!currentHash) {
        // No credential for this session — equalize timing and reject.
        await client.query("ROLLBACK");
        await runDecoyVerify(currentPassword);
        return NextResponse.json({ error: "Password incorrect." }, { status: 401 });
      }
      if (!(await verifySecret(currentPassword, currentHash))) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Password incorrect." }, { status: 401 });
      }

      // R36-H6: scope the DELETE by the employee's org too so a
      // pathological cross-tenant id collision can't wipe another
      // tenant's admin sessions. Redundant under correct ctx but cheap
      // defense in depth.
      // R39-A1-5: drop the `scope = 'admin'` filter so register (PIN)
      // sessions also get revoked. "Sign out everywhere" was misleading
      // — a compromised admin who also had a register PIN could keep
      // using the register session indefinitely. Revoke both scopes.
      await client.query(
        `DELETE FROM sessions
          WHERE employee_id = $1
            AND employee_id IN (SELECT id FROM employees WHERE organization_id = $2)`,
        [ctx.employee.id, orgId],
      );

      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'sessions_revoked', $6, now())`,
        [
          randomUUID(), orgId, null, ctx.employee.id, ctx.employee.id,
          JSON.stringify({ scope: "admin", all: true }),
        ],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Clear the admin cookie in the response so the browser also
    // drops its copy.
    //
    // R28-H7: mirror the ORIGINAL cookie's attributes exactly.
    // The admin cookie is minted with `Secure` on HTTPS (see
    // session.ts:419 + login/route.ts:136). RFC 6265bis + Safari /
    // Firefox require the clearing Set-Cookie's attributes to match;
    // a Secure cookie cleared via a non-Secure Set-Cookie over HTTPS
    // may be kept by the browser. Also add Max-Age=0 belt-and-braces
    // with Expires=1970 so browsers that prefer one over the other
    // both drop the cookie.
    const isSecure = req.url.startsWith("https://");
    const r = NextResponse.json({ success: true });
    const clearAttrs = [
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      `Max-Age=0`,
      ...(isSecure ? ["Secure"] : []),
    ];
    // R41-2: clear both the new short cookie AND the legacy
    // `basicuniformpos_*` name during the rollover window so a
    // rollover client doesn't keep a live legacy session pinned
    // after "sign out everywhere".
    // R45-LOW: also clear `bupos_r` (register) and
    // `bupos_register_device` cookies. R39-A1-5 made the DB DELETE
    // wipe both scopes; mirroring on the client keeps UX consistent
    // — the browser's cookie jar won't hold a now-invalid register
    // cookie until natural expiry.
    const clearNew = [`${ADMIN_COOKIE}=`, ...clearAttrs].join("; ");
    const clearOld = [`${OLD_ADMIN_COOKIE}=`, ...clearAttrs].join("; ");
    const clearReg = [`bupos_r=`, ...clearAttrs].join("; ");
    const clearRegOld = [`basicuniformpos_register_session=`, ...clearAttrs].join("; ");
    const clearRegDev = [`bupos_register_device=`, ...clearAttrs].join("; ");
    r.headers.append("Set-Cookie", clearNew);
    r.headers.append("Set-Cookie", clearOld);
    r.headers.append("Set-Cookie", clearReg);
    r.headers.append("Set-Cookie", clearRegOld);
    r.headers.append("Set-Cookie", clearRegDev);
    return r;
  } catch (err) {
    console.error("[revoke-all-sessions] error:", safeErr(err));
    return NextResponse.json({ error: "Failed to revoke sessions." }, { status: 500 });
  }
}
