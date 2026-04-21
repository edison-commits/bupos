import { NextRequest, NextResponse } from "next/server";
import { getRegisterSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/authz";
import { orgQuery } from "@/lib/supabase-rest";
import { validateBody, customerDisplaySchema } from "@/lib/validation/schemas";
import { checkOrigin } from "@/lib/api/with-auth";
import { mintDisplayToken, verifyDisplayToken } from "@/lib/auth/display-token";

import { safeErr } from "@/lib/logging/safe-err";

// R8-H-4 closed: two auth modes.
//   1. Cookie-based (same-browser display): the register-session cookie
//      is present. Used by iframe / proxied-display setups.
//   2. Token-based (separate-device display): GET carries
//      `?displayToken=...` — an HMAC-signed short-lived token minted at
//      POST time. Used when the display is a physically separate device.
// The caller scope (POS terminal) always authenticates via cookie;
// only the display-side GET can swap to token auth.
async function authorizeRegisterSession(registerSessionId: string): Promise<NextResponse | { orgId: string }> {
  const ctx = await getRegisterSession();
  if (!ctx?.employee || !ctx.registerSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(ctx.employee.roleKey, "register.open")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.registerSession.id !== registerSessionId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { orgId };
}

// Token-based authorizer for GET. Accepts ONLY a valid HMAC token whose
// claims match the queried register_session. Returns {orgId} on success.
// The raw `getPool` lookup here is safe: the token PROVES possession of
// a specific register_session_id (we signed it), and the lookup is
// scoped by that exact id — no tenant-enumeration surface. Allowlisted
// in `scripts/check-no-raw-pool-query.mjs`.
async function authorizeDisplayToken(
  registerSessionId: string,
  token: string,
): Promise<NextResponse | { orgId: string }> {
  const claims = await verifyDisplayToken(token);
  if (!claims) {
    return NextResponse.json({ error: "Invalid or expired display token" }, { status: 401 });
  }
  if (claims.registerSessionId !== registerSessionId) {
    return NextResponse.json({ error: "Token does not match register session" }, { status: 401 });
  }
  const { getPool } = await import("@/lib/supabase-rest");
  const pool = await getPool();
  // R27-M13: reject tokens for closed / ended register sessions.
  // The HMAC is minted at session start with a 15-min TTL and can't
  // be revoked before TTL expiry. Previously, if the cashier signed
  // out (register_session.status='ended') but the TOKEN was still
  // within TTL, a prior holder could keep polling the display state
  // and see live cart snapshots after a new cashier opened a shift
  // on the same register. The explicit `status='active'` gate
  // invalidates the token the moment the session ends.
  const { rows } = await pool.query(
    `SELECT organization_id FROM register_sessions
      WHERE id = $1 AND status = 'active' LIMIT 1`,
    [registerSessionId],
  );
  const orgId = (rows[0]?.organization_id as string) ?? null;
  if (!orgId) {
    return NextResponse.json({ error: "Register session not found" }, { status: 401 });
  }
  return { orgId };
}

/**
 * POST /api/customer-display
 *
 * The POS terminal POSTs the current register state here when cart updates.
 */
export async function POST(req: NextRequest) {
  // These handlers don't use withDualAuth (they resolve the register session
  // manually to enforce the per-session `registerSessionId` match), so they
  // also don't inherit its CSRF Origin check. Apply it explicitly on the
  // state-changing methods — the display state being vandalized mid-sale is
  // a real customer-facing issue (wrong totals shown to customer).
  const originErr = checkOrigin(req);
  if (originErr) return originErr;
  try {
    const data = await req.json();
    const v = validateBody(customerDisplaySchema, data);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const {
      registerSessionId,
      cart,
      totals,
      paymentStatus,
      amountTendered,
      changeDue,
    } = v.data;

    const authResult = await authorizeRegisterSession(registerSessionId);
    if (authResult instanceof NextResponse) {
      return authResult;
    }
    const { orgId } = authResult;

    // check-pool-org-filter: scoped-by-register-session-id
    // register_session_id is authenticated via cookie (authorizeRegisterSession
    // verifies the session belongs to this employee's org), and the UNIQUE
    // constraint on (register_session_id) makes it the tenancy anchor here.
    await orgQuery(
      orgId,
      `INSERT INTO customer_display_state
         (register_session_id, cart, totals, payment_status, amount_tendered, change_due, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (register_session_id) DO UPDATE SET
         cart = EXCLUDED.cart,
         totals = EXCLUDED.totals,
         payment_status = EXCLUDED.payment_status,
         amount_tendered = EXCLUDED.amount_tendered,
         change_due = EXCLUDED.change_due,
         updated_at = NOW()`,
      [
        registerSessionId,
        JSON.stringify(cart),
        JSON.stringify(totals),
        paymentStatus ?? null,
        amountTendered ?? null,
        changeDue ?? null,
      ]
    );

    // R8-H-4 closed: mint a fresh display token on every POST so a
    // physically separate display device can poll GET without the
    // register cookie. The cashier terminal receives the token in the
    // POST response and forwards it (pairing QR / localStorage / iframe
    // postMessage — client's choice) to the display.
    const displayToken = await mintDisplayToken(registerSessionId);

    return NextResponse.json(
      { success: true, message: "Customer display state updated", displayToken },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error updating customer display state:", safeErr(error));
    return NextResponse.json(
      { error: "Failed to update customer display state" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/customer-display
 *
 * The customer display page polls this endpoint to get current cart state.
 */
export async function GET(req: NextRequest) {
  const registerSessionId = req.nextUrl.searchParams.get("registerSessionId");
  const displayToken = req.nextUrl.searchParams.get("displayToken");

  if (!registerSessionId) {
    return NextResponse.json(
      { error: "registerSessionId query param is required" },
      { status: 400 }
    );
  }

  // R8-H-4: prefer token auth when the display device provides one.
  // Falls back to cookie auth (same-browser iframe pairing).
  const authResult = displayToken
    ? await authorizeDisplayToken(registerSessionId, displayToken)
    : await authorizeRegisterSession(registerSessionId);
  if (authResult instanceof NextResponse) {
    return authResult;
  }
  const { orgId } = authResult;

  // Stale display state is worse than no state — it shows the previous
  // shopper's items to the next customer. TTL the row at 15 minutes so a
  // cashier who closed their browser without the completion DELETE doesn't
  // leak cart contents to the next transaction at that terminal.
  const DISPLAY_TTL_MINUTES = 15;
  // check-pool-org-filter: scoped-by-register-session-id
  // register_session_id is proven either by the verified display token
  // (authorizeDisplayToken) or the authenticated cookie session
  // (authorizeRegisterSession); both resolve the orgId from the same session.
  const { rows } = await orgQuery(
    orgId,
    `SELECT cart, totals, payment_status, amount_tendered, change_due, updated_at
     FROM customer_display_state
     WHERE register_session_id = $1
       AND updated_at > now() - interval '${DISPLAY_TTL_MINUTES} minutes'`,
    [registerSessionId]
  );

  if (rows.length === 0) {
    return NextResponse.json(
      {
        cart: null,
        totals: {
          subtotal: 0,
          modifiersTotal: 0,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: 0,
          itemCount: 0,
        },
        paymentStatus: null,
        amountTendered: null,
        changeDue: null,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, private" },
      },
    );
  }

  const row = rows[0];
  // Never cache — display state is per-register, ephemeral, and contains
  // customer-scoped data (cartName, running totals). A caching proxy
  // serving a stale cart to the wrong customer at the same register is
  // both confusing and leaks prior-customer context. Matches the
  // `no-store` pattern on /api/bundles/availability.
  return NextResponse.json(
    {
      cart: row.cart,
      totals: row.totals,
      paymentStatus: row.payment_status,
      amountTendered: row.amount_tendered ? Number(row.amount_tendered) : null,
      changeDue: row.change_due ? Number(row.change_due) : null,
      updatedAt: row.updated_at,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, private" },
    },
  );
}

/**
 * DELETE /api/customer-display
 *
 * Clear the display state for a session (called when transaction completes)
 */
export async function DELETE(req: NextRequest) {
  const originErr = checkOrigin(req);
  if (originErr) return originErr;
  const registerSessionId = req.nextUrl.searchParams.get("registerSessionId");

  if (!registerSessionId) {
    return NextResponse.json(
      { error: "registerSessionId query param is required" },
      { status: 400 }
    );
  }
  const authResult = await authorizeRegisterSession(registerSessionId);
  if (authResult instanceof NextResponse) {
    return authResult;
  }
  const { orgId } = authResult;

  // check-pool-org-filter: scoped-by-register-session-id
  // register_session_id authenticated via cookie (authorizeRegisterSession).
  await orgQuery(
    orgId,
    `DELETE FROM customer_display_state WHERE register_session_id = $1`,
    [registerSessionId]
  );

  return NextResponse.json(
    { success: true, message: "Customer display state cleared" },
    { status: 200 }
  );
}
