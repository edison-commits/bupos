/**
 * R8-M-12 closed: GET /api/auth/verify?token=...
 *
 * Consumes a pending_signups row and atomically creates the real org +
 * location + employee + auth_credentials. On success, signs the caller
 * in and redirects to /admin. On failure (invalid token, expired), shows
 * a generic error page.
 */

import { NextRequest, NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getPool } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";
import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";

// R41-2: opaque cookie name (see session.ts for rationale).
const ADMIN_COOKIE = "bupos_a";
const OLD_ADMIN_COOKIE = "basicuniformpos_admin_session";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.length < 16 || token.length > 128) {
    return NextResponse.redirect(new URL("/?error=Invalid+verification+link", req.url));
  }

  const pool = await getPool();

  try {
    // Atomically pull + delete the pending row so double-submits can't
    // create two orgs.
    //
    // RLS is enabled on pending_signups (migration 049), with
    // service_role_full_access; the postgres role is BYPASSRLS so the
    // raw pool.query succeeds.
    //
    // R21-L-3: the password_hash is what we ACTUALLY need here (to copy
    // into auth_credentials), so RETURNING it is unavoidable. But we
    // scope it to a narrow block below so it doesn't travel through
    // outer catch() scopes where a future `console.error(raw-err)` edit
    // could serialize the row into a log line. The hash is overwritten
    // with undefined as soon as the INSERT lands.
    // R32-D3: hash the incoming token and compare against the stored
    // hash. The DB never sees the raw token; a leaked backup yields
    // no working verify links.
    const { sha256Hex } = await import("@/lib/auth/crypto");
    const tokenHash = await sha256Hex(token);
    const { rows: pendingRows } = await pool.query(
      `DELETE FROM pending_signups
        WHERE verification_token_hash = $1 AND expires_at > now()
        RETURNING email, store_name, first_name, last_name, password_hash`,
      [tokenHash],
    );
    if (pendingRows.length === 0) {
      return NextResponse.redirect(new URL("/?error=Verification+link+expired+or+invalid", req.url));
    }
    const pending = pendingRows[0] as {
      email: string;
      store_name: string;
      first_name: string;
      last_name: string;
      password_hash: string;
    };
    const { email, store_name: storeName, first_name: firstName, last_name: lastName } = pending;

    // Create org + location + employee + credential atomically.
    const orgId = randomUUID();
    const locationId = randomUUID();
    const employeeId = randomUUID();
    const slug = (storeName as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "store";
    const now = new Date().toISOString();

    // R22-H-3: the 23505 branch below used to call `client.release()`
    // directly and then `return` — which unwound the outer `finally`
    // and released the client a SECOND time. Plain pg's Client raises
    // "Release called on client which has already been released" on
    // that; @neondatabase/serverless's wrapper guards idempotently but
    // still breaks the Worker pool's checkout accounting on a race.
    //
    // New shape: capture "email already registered" as a local flag,
    // exit the transaction cleanly via the single `finally` release,
    // and redirect after the block.
    let emailAlreadyRegistered = false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'America/Los_Angeles', 'USD', 'free', true, $5, $5)`,
        [orgId, storeName, slug, storeName, now],
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
      // R21-C-1: the new unique index on auth_credentials(lower(email))
      // can raise 23505 if a concurrent signup beat us. Translate to a
      // user-friendly error rather than leaking the pg constraint name.
      // check-pool-org-filter: scoped-by-just-created-employee (employeeId was
      // just INSERTed into this org's employees above)
      try {
        await client.query(
          `INSERT INTO auth_credentials (employee_id, email, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [employeeId, email, pending.password_hash, now],
        );
        // R52-F: `store_signup_verified` audit INSIDE the tx so sign-
        // up provenance (the name/email of the brand-new admin, the
        // org+location pair, timestamp) is atomic with the account
        // creation itself. Prior shape used a post-commit fire-and-
        // forget `pool.query("INSERT audit_events")` at the end of
        // the handler — drop-prone on Workers isolate freeze,
        // leaving an account with no sign-up audit trail (the
        // anchor for abuse-reporting / compliance investigations).
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'organization', $5, 'store_signup_verified', $6, $7)`,
          [
            randomUUID(), orgId, locationId, employeeId, orgId,
            JSON.stringify({ store_name: storeName, owner_email: email, plan: "free" }),
            now,
          ],
        );
        await client.query("COMMIT");
      } catch (credErr) {
        const code = (credErr as { code?: string }).code;
        if (code === "23505") {
          await client.query("ROLLBACK").catch(() => {});
          emailAlreadyRegistered = true;
          // Fall through; single `finally` below releases the client.
        } else {
          throw credErr;
        }
      }
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    if (emailAlreadyRegistered) {
      // R31-M12: redirect to a GENERIC verification-failed page rather
      // than the email-already-registered message. The prior shape
      // was a positive-signal enumeration oracle — an attacker who
      // could submit a verification token (or race the victim's own)
      // would see this specific error and confirm the email is in
      // use. The generic redirect matches other invalid-token paths
      // so attackers can't distinguish "email in use" from "token
      // expired" from "token invalid" from "already consumed".
      return NextResponse.redirect(new URL("/?error=Verification+failed.+Request+a+new+link.", req.url));
    }

    // R21-L-3: scrub the hash from the `pending` object now that the
    // INSERT has committed — prevents it from traveling into outer
    // catch scopes (future `console.error(err)` edits could serialize
    // the captured closure into a log line).
    (pending as { password_hash?: unknown }).password_hash = undefined;

    // Mint an admin session directly — we just created the credential,
    // no need to re-verify the password hash. Mirrors the session shape
    // that `signInAdmin` produces.
    //
    // R21-M-4: two failure modes were previously conflated:
    //   (a) sessions INSERT failed → no orphan → harmless
    //   (b) sessions INSERT committed but `jar.set` cookie threw →
    //       live session row in DB with no cookie delivered. Low harm
    //       per se (next login creates another row), but indicates
    //       the error path wasn't plumbed.
    // Now we track whether the session INSERT committed, and delete
    // the orphan row if cookie-set fails.
    const sessionId = randomUUID();
    const sessionCreatedAt = new Date().toISOString();
    const sessionExpiresAt = addDays(new Date(sessionCreatedAt), 1).toISOString();
    let sessionInserted = false;
    try {
      const clientS = await pool.connect();
      try {
        await clientS.query("BEGIN");
        await clientS.query(
          `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
           VALUES ($1, $2, $3, 'admin', $4, $4, $5)`,
          [sessionId, employeeId, orgId, sessionCreatedAt, sessionExpiresAt],
        );
        await clientS.query("COMMIT");
        sessionInserted = true;
      } catch (e) {
        await clientS.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        clientS.release();
      }
      const jar = await cookies();
      // R24-M-3: mirror the cookie-secure helper in session.ts. `true`
      // on prod/HTTPS, `false` on local HTTP so dev + Playwright work.
      const secureFlag =
        process.env.NODE_ENV === "production" || req.url.startsWith("https://");
      jar.set(ADMIN_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureFlag,
        path: "/",
        expires: new Date(sessionExpiresAt),
      });
      // R41-2: clear legacy name so a rollover client doesn't end up
      // with BOTH cookies pinned.
      jar.delete(OLD_ADMIN_COOKIE);
    } catch (sessionErr) {
      // R21-M-4 + R22-M-3: if the session INSERT committed but cookie-
      // set threw, clean up the orphan row so it doesn't linger until
      // TTL. On Workers, `pool.query(...).catch(...)` as a fire-and-
      // forget is cancelled when the isolate freezes after the
      // response returns (the `no_handle_cross_request_promise_resolution`
      // compat flag). Route the cleanup through `ctx.waitUntil` so the
      // runtime actually awaits it; fall back to synchronous await in
      // non-Workers runtimes / dev.
      if (sessionInserted) {
        const deletePromise = pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId])
          .catch((cleanupErr) =>
            console.error("[verify] orphan session cleanup failed:", safeErr(cleanupErr)),
          );
        await waitUntilOrAwait(deletePromise);
      }
      // Session mint failed — account is still created, user can log in
      // normally from the landing page.
      console.error("[verify] auto-signin failed:", safeErr(sessionErr));
      return NextResponse.redirect(new URL("/?notice=Account+activated+please+sign+in", req.url));
    }

    // R52-F: `store_signup_verified` audit was moved INSIDE the
    // org-creation tx above, so the row lands atomic with the
    // organizations/locations/employees/auth_credentials INSERTs
    // (no post-commit fire-and-forget drop vector).
    return NextResponse.redirect(new URL("/admin?notice=Account+activated", req.url));
  } catch (err) {
    console.error("[/api/auth/verify] Error:", safeErr(err));
    return NextResponse.redirect(new URL("/?error=Verification+failed+please+try+again", req.url));
  }

  // Unreachable — all branches redirect — but some bundlers complain
  // about an un-awaited redirect type inference.
  redirect("/?error=unknown");
}
