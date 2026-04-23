import { NextResponse } from 'next/server';
import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { validateBody, cashDrawerSchema } from '@/lib/validation/schemas';
import { withDualAuth } from '@/lib/api/with-auth';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { getRegisterConfig } from '@/lib/config/register-config';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { hasPermission } from '@/lib/domain/permissions';

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * GET /api/cash-drawer?action=status|history
 *
 * action=status: Returns current open shift (if any) with pay_in_outs totals
 * action=history: Returns last 10 closed shifts with summary
 */
export const GET = withDualAuth("register.open", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  try {
    const action = req.nextUrl.searchParams.get('action') || 'status';

    if (action === 'status') {
      return handleGetStatus(orgId, locationId);
    } else if (action === 'history') {
      return handleGetHistory(orgId, locationId);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[cash-drawer GET]', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to fetch cash drawer data' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/cash-drawer
 * Body: { action: 'open_shift' | 'close_shift' | 'pay_in' | 'pay_out', ... }
 */
export const POST = withDualAuth("register.open", async (req, ctx) => {
  const { orgId, locationId, employee, registerSession } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const v = validateBody(cashDrawerSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { action } = v.data;
    const actorEmployeeId = employee.id;
    // Caller's register_session (only present when hit from the register
    // scope, not the admin scope). handleOpenShift binds the new shift
    // to it when available so subsequent shift-keyed reports (cash math,
    // reorder cadence) correlate with the right session.
    const callerRegisterSessionId = registerSession?.registerSession?.id as string | undefined;

    if (action === 'open_shift') {
      return handleOpenShift(orgId, locationId, actorEmployeeId, body, callerRegisterSessionId);
    } else if (action === 'close_shift') {
      // R12-H-1: pass the caller's identity + role so the handler can refuse
      // a cashier closing a peer's open shift (variance fabrication vector).
      // `/api/shift-close` already enforces this — cash-drawer is the second
      // close-shift entrypoint and had no ownership check.
      return handleCloseShift(orgId, locationId, body, actorEmployeeId, employee.roleKey);
    } else if (action === 'pay_in') {
      // R38-A-F6: pass actor role so handlePayIn can enforce an
      // approval threshold mirroring pay_out. A cashier padding the
      // drawer with a fake `pay_in $5000` at open and matching `pay_out
      // $5000` at close was previously un-audited and covered any cash
      // short.
      return handlePayIn(orgId, locationId, actorEmployeeId, employee.roleKey, body);
    } else if (action === 'pay_out') {
      // Rate-limit payouts per employee to prevent rapid-fire cash extraction.
      const rl = checkRateLimit(`payout:${actorEmployeeId}`);
      if (!rl.allowed) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      }
      return handlePayOut(orgId, locationId, actorEmployeeId, employee.roleKey, body);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[cash-drawer POST]', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET Handlers
// ────────────────────────────────────────────────────────────────────────────

async function handleGetStatus(orgId: string, locationId: string) {
  // Single query: fetch open shift with pay_in_outs totals via subqueries
  const shiftRes = await orgQuery(
    orgId,
    `SELECT s.id, s.employee_id, s.opened_at, s.opening_float, s.status,
            e.display_name AS employee_name,
            COALESCE((SELECT SUM(amount) FROM pay_in_outs WHERE shift_id = s.id AND direction = 'pay_in'), 0)::numeric AS pay_ins,
            COALESCE((SELECT SUM(amount) FROM pay_in_outs WHERE shift_id = s.id AND direction = 'pay_out'), 0)::numeric AS pay_outs
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $2
     WHERE s.location_id = $1 AND s.status = 'open' AND s.organization_id = $2
     ORDER BY s.opened_at DESC
     LIMIT 1`,
    [locationId, orgId]
  );

  if (shiftRes.rows.length === 0) {
    return NextResponse.json({ shift: null });
  }

  const shift = shiftRes.rows[0];
  return NextResponse.json({
    shift: {
      id: shift.id,
      employeeName: shift.employee_name,
      openedAt: shift.opened_at,
      openingFloat: Number(shift.opening_float),
      status: shift.status,
      payIns: Number(shift.pay_ins),
      payOuts: Number(shift.pay_outs),
    },
  });
}

async function handleGetHistory(orgId: string, locationId: string) {
  // Fetch last 10 closed shifts with summary
  const shiftsRes = await orgQuery(
    orgId,
    `SELECT s.id, s.employee_id, e.display_name AS employee_name,
            s.opened_at, s.closed_at, s.opening_float,
            s.closing_expected_cash, s.closing_declared_cash,
            s.closing_variance
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $2
     WHERE s.location_id = $1 AND s.status = 'closed' AND s.organization_id = $2
     ORDER BY s.closed_at DESC
     LIMIT 10`,
    [locationId, orgId]
  );

  interface ShiftHistoryRow {
    id: string; employee_name: string; opened_at: string; closed_at: string;
    opening_float: string; closing_expected_cash: string; closing_declared_cash: string; closing_variance: string;
  }
  const shifts = (shiftsRes.rows as ShiftHistoryRow[]).map((row) => ({
    id: row.id,
    employeeName: row.employee_name,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingFloat: Number(row.opening_float),
    expectedCash: Number(row.closing_expected_cash),
    declaredCash: Number(row.closing_declared_cash),
    variance: Number(row.closing_variance),
  }));

  return NextResponse.json({ shifts });
}

// ────────────────────────────────────────────────────────────────────────────
// POST Handlers
// ────────────────────────────────────────────────────────────────────────────

async function handleOpenShift(
  orgId: string,
  locationId: string,
  actorEmployeeId: string,
  body: Record<string, unknown>,
  callerRegisterSessionId?: string,
) {
  const { opening_float, note } = body;

  if (opening_float === undefined) {
    return NextResponse.json(
      { error: 'Missing required field: opening_float' },
      { status: 400 }
    );
  }

  const numericFloat = Number(opening_float);
  if (!Number.isFinite(numericFloat) || numericFloat < 0 || numericFloat > 50_000) {
    return NextResponse.json({ error: 'Invalid opening float' }, { status: 400 });
  }

  // R13-M-3: the "one open shift per employee, one open shift per location"
  // invariant is now DB-enforced via partial UNIQUE indexes (migration 043):
  //   idx_shifts_one_open_per_employee (org, employee) WHERE status = 'open'
  //   idx_shifts_one_open_per_location (org, location) WHERE status = 'open'
  // Two concurrent opens race to INSERT; the loser gets 23505 which we
  // map to a 409. No more SELECT FOR UPDATE scan — the index does the
  // work, and only rows with status='open' are covered, so closed shifts
  // never pollute the lock set. Removes the hotspot at busy locations.
  const client = await orgTx(orgId);
  try {

    // Bind the new shift to the CALLER's register_session whenever we
    // have one (from the register-scope cookie). Falling back to any
    // active session at the location — as the old code did —
    // cross-wires shift reports: cash math keyed on register_session_id
    // would aggregate across the previous cashier's sales and the new
    // cashier's sales, inflating expected cash. For admin-scope callers
    // (no register session), we still need a session to satisfy the FK;
    // look up one belonging to THIS employee at this location, or
    // create one as a last resort.
    let registerSessionId = callerRegisterSessionId;
    if (registerSessionId) {
      // Belt-and-suspenders: the caller's session must actually belong
      // to this employee + location. Without this check a malicious
      // client could set a cookie to someone else's session UUID.
      const verify = await client.query(
        `SELECT id FROM register_sessions
         WHERE id = $1 AND employee_id = $2 AND location_id = $3 AND organization_id = $4 AND status = 'active'
         LIMIT 1`,
        [registerSessionId, actorEmployeeId, locationId, orgId],
      );
      if (verify.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Register session does not belong to this employee/location' },
          { status: 403 },
        );
      }
    } else {
      // Admin-scope or no register session attached: prefer an existing
      // active session owned by THIS employee at this location.
      const own = await client.query(
        `SELECT id FROM register_sessions
         WHERE employee_id = $1 AND location_id = $2 AND organization_id = $3 AND status = 'active'
         ORDER BY started_at DESC LIMIT 1`,
        [actorEmployeeId, locationId, orgId],
      );
      registerSessionId = own.rows[0]?.id as string | undefined;
      if (!registerSessionId) {
        // R14-L-3: register_sessions.organization_id is NOT NULL with
        // DEFAULT gen_random_uuid() — omitting it would generate a random
        // UUID that doesn't match ANY real org, orphaning the
        // register_session from the tenant entirely. `register_sign_out`
        // would never find it to auto-close attached shifts. Pass the
        // actual orgId explicitly.
        const newRegSessionRes = await client.query(
          `INSERT INTO register_sessions
           (organization_id, auth_session_id, employee_id, location_id, status, started_at)
           VALUES ($1, gen_random_uuid(), $2, $3, 'active', NOW())
           RETURNING id`,
          [orgId, actorEmployeeId, locationId],
        );
        registerSessionId = newRegSessionRes.rows[0].id as string;
      }
    }

    // Create shift. If the partial unique index fires (23505) we know
    // EXACTLY which invariant failed based on the conflicting index name
    // in the PG error detail — distinguish "you already have an open
    // shift" from "this location already has an open shift" for UX.
    let shiftRes;
    try {
      shiftRes = await client.query(
        `INSERT INTO shifts
         (organization_id, location_id, employee_id, register_session_id, opening_float, opened_note, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'open')
         RETURNING id, opened_at`,
        [
          orgId,
          locationId,
          actorEmployeeId,
          registerSessionId,
          numericFloat,
          note || null,
        ]
      );
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      const err = e as { code?: string; constraint?: string; detail?: string };
      if (err.code === '23505') {
        // R14-M-2: parse pg's `Key (col1, col2)=(...)` detail string for
        // the actual constraining columns, rather than substring-matching
        // on a constraint name that can be renamed. Migration 043 +
        // migration 045 give us two indexes:
        //   idx_shifts_one_open_per_employee         (org, employee_id)
        //   idx_shifts_one_open_per_register_session (org, register_session_id)
        const detail = err.detail ?? '';
        const m = /Key \(([^)]+)\)=/.exec(detail);
        const cols = m ? m[1].split(/\s*,\s*/) : [];
        if (cols.includes('employee_id')) {
          return NextResponse.json({ error: 'You already have an open shift' }, { status: 409 });
        }
        if (cols.includes('register_session_id')) {
          return NextResponse.json({ error: 'This register already has an open shift' }, { status: 409 });
        }
        return NextResponse.json({ error: 'An open shift already exists for this employee or register' }, { status: 409 });
      }
      throw e;
    }

    await client.query('COMMIT');
    const shift = shiftRes.rows[0];

    return NextResponse.json(
      {
        success: true,
        shift: {
          id: shift.id,
          openedAt: shift.opened_at,
          openingFloat: numericFloat,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function handleCloseShift(
  orgId: string,
  locationId: string,
  body: Record<string, unknown>,
  actorEmployeeId: string,
  actorRoleKey: import("@/lib/domain/types").RoleKey,
) {
  const { shift_id, declared_cash, note, blind_close } = body;

  if (!shift_id || declared_cash === undefined) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, declared_cash' },
      { status: 400 }
    );
  }

  // Do the entire close-shift flow inside ONE transaction with FOR UPDATE
  // on the shift row, so two concurrent close requests serialize correctly.
  // The second one will see status='closed' and return 409 instead of
  // silently no-op'ing the UPDATE.
  const client = await orgTx(orgId);
  let expectedCash = 0;
  let variance = 0;
  try {
    const shiftRes = await client.query(
      `SELECT s.id, s.opening_float, s.register_session_id, s.status, s.employee_id
       FROM shifts s
       WHERE s.id = $1 AND s.location_id = $2 AND s.organization_id = $3
       FOR UPDATE`,
      [shift_id, locationId, orgId]
    );
    if (shiftRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
    }
    if (shiftRes.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Shift is not open' }, { status: 409 });
    }

    // R12-H-1: cashiers can only close their OWN shift. Without this check
    // any cashier holding register.open at a location could submit a peer's
    // open shift id + fabricated declared_cash, closing the shift and
    // landing the variance on the victim. Managers and owners bypass —
    // they need to force-close peers for end-of-day oversight.
    const shiftEmployeeId = shiftRes.rows[0].employee_id as string | null;
    const isManager = ["owner", "manager"].includes(actorRoleKey);
    if (!isManager && shiftEmployeeId !== null && shiftEmployeeId !== actorEmployeeId) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: "Cannot close a shift you don't own. Ask a manager." },
        { status: 403 }
      );
    }

    expectedCash = await calculateExpectedCash(orgId, shift_id as string);
    variance = Number((Number(declared_cash) - expectedCash).toFixed(2));

    // Include updated_at refresh. Check rowCount so a raced UPDATE that hits
    // zero rows surfaces a clear error instead of returning success.
    const upd = await client.query(
      `UPDATE shifts
       SET status = 'closed',
           closed_at = NOW(),
           closing_expected_cash = $1,
           closing_declared_cash = $2,
           closing_variance = $3,
           closed_note = $4,
           blind_close = $5,
           updated_at = NOW()
       WHERE id = $6 AND status = 'open' AND organization_id = $7`,
      [expectedCash, declared_cash, variance, note || null, blind_close || false, shift_id, orgId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Shift already closed' }, { status: 409 });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return NextResponse.json({
    success: true,
    shift: {
      id: shift_id,
      closedAt: new Date().toISOString(),
      expectedCash,
      declaredCash: Number(declared_cash),
      variance,
    },
  });
}

async function handlePayIn(
  orgId: string,
  locationId: string,
  actorEmployeeId: string,
  actorRoleKey: import("@/lib/domain/types").RoleKey,
  body: Record<string, unknown>,
) {
  const { shift_id, amount, reason, note, approval_id } = body;

  if (!shift_id || !amount || !reason) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, amount, reason' },
      { status: 400 }
    );
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 10_000) {
    return NextResponse.json({ error: 'Invalid pay-in amount' }, { status: 400 });
  }

  // R38-A-F6: threshold-gate non-trivial pay-ins too. A cashier can
  // otherwise fake a `pay_in $X` at open (padding the drawer) and
  // match it with a `pay_out $X` at close to mask a cash short — no
  // approval, no audit. Use the same threshold as pay_out so both
  // sides of the drawer movement require a manager for non-trivial
  // amounts. Managers/owners (who have approval authority) bypass.
  const isManager = hasPermission(actorRoleKey, "approval.void_transaction");
  const cfg = await getRegisterConfig(orgId);
  const payinThreshold = cfg.approvalThresholds.transactionVoidOver ?? 50;

  // Verify the shift belongs to the caller's location AND is still open,
  // then INSERT — inside one transaction so the shift can't close (via
  // a concurrent handleCloseShift) between the check and the insert and
  // land a pay-in against a just-closed shift. `FOR UPDATE` serialises
  // against the close tx.
  const client = await orgTx(orgId);
  let payInOut: { id: string; created_at: string };
  try {
    const shiftCheck = await client.query(
      `SELECT id, register_session_id FROM shifts
       WHERE id = $1 AND location_id = $2 AND organization_id = $3 AND status = 'open'
       FOR UPDATE`,
      [shift_id, locationId, orgId],
    );
    if (shiftCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Shift not found, not open, or not at this location' }, { status: 400 });
    }
    const shiftRegisterSessionId = shiftCheck.rows[0].register_session_id as string | null;

    if (!isManager && numericAmount >= payinThreshold) {
      if (!approval_id || typeof approval_id !== 'string') {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: `Pay-in exceeds $${payinThreshold}; manager approval required.` },
          { status: 403 },
        );
      }
      if (!shiftRegisterSessionId) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Shift has no associated register session' }, { status: 400 });
      }
      // Consume a `cash_payout` approval for pay-ins too — same
      // approval bucket, same permission gate (see approval-action.ts).
      // A distinct `cash_payin` code would also work but reuses the
      // existing UI flow / step-up bucket for simplicity.
      // check-pool-org-filter: scoped-by-register-session-id-from-org-gated-shift
      const consume = await client.query(
        `UPDATE register_session_exceptions
           SET status = 'consumed'
         WHERE id = $1 AND register_session_id = $2 AND status = 'pending'
           AND exception_code = 'cash_payout'
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING id`,
        [approval_id, shiftRegisterSessionId],
      );
      if (consume.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Invalid, expired, or already-used approval' }, { status: 403 });
      }
    }

    const payRes = await client.query(
      `INSERT INTO pay_in_outs
       (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
       VALUES ($1, $2, $3, 'pay_in', $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        shift_id,
        locationId,
        actorEmployeeId,
        numericAmount,
        reason,
        note || null,
        orgId,
      ],
    );
    payInOut = payRes.rows[0];

    // R46-H3: audit the pay_in INSIDE the transaction. Prior shape had
    // ZERO audit_events row — only `pay_out` was audited (in a post-
    // commit waitUntilOrAwait, itself audit-drift). An attacker with
    // cashier credentials could inject a fake pay_in $N (inflating
    // expectedCash + matching it with a legitimate-looking pay_out $N
    // that IS audited) to launder cash through the drawer. Matches the
    // "laundering via paired pay_in/pay_out" pattern documented at
    // lines ~447-455 of this file.
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'shift', $4, 'cash_pay_in', $5, now())`,
      [
        orgId,
        locationId,
        actorEmployeeId,
        shift_id,
        JSON.stringify({ amount: numericAmount, reason, note: note || null, pay_in_out_id: payInOut.id }),
      ],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json(
    {
      success: true,
      payInOut: {
        id: payInOut.id,
        direction: 'pay_in',
        amount: numericAmount,
        reason,
        createdAt: payInOut.created_at,
      },
    },
    { status: 201 }
  );
}

async function handlePayOut(orgId: string, locationId: string, actorEmployeeId: string, actorRoleKey: import("@/lib/domain/types").RoleKey, body: Record<string, unknown>) {
  const { shift_id, amount, reason, note, approval_id } = body;

  if (!shift_id || !amount || !reason) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, amount, reason' },
      { status: 400 }
    );
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 });
  }
  if (numericAmount > 10_000) {
    return NextResponse.json({ error: 'Amount exceeds maximum allowed' }, { status: 400 });
  }

  // Enforce approval threshold server-side. Managers/owners bypass (they have
  // the approval role themselves). Cashiers need a manager-approval exception.
  const isManager = hasPermission(actorRoleKey, "approval.void_transaction");
  const config = await getRegisterConfig(orgId);
  // Use transactionVoidOver as a general cash-out threshold; $50 default.
  const payoutThreshold = config.approvalThresholds.transactionVoidOver ?? 50;

  // Serialize shift check, approval consume, and pay_in_out INSERT under a
  // single transaction with FOR UPDATE on the shift row. Using three
  // separate orgQuery() calls leaked a race: a concurrent shift-close
  // between the shift-open check and the INSERT made the pay_out land
  // against a closed shift, silently inflating the next day's expected cash.
  // Matches the pay_in fix.
  type PayoutResult =
    | { kind: "ok"; id: string; created_at: string }
    | { kind: "error"; status: number; error: string };

  let payoutResult: PayoutResult;
  const payoutClient = await orgTx(orgId);
  try {
    const shiftCheck = await payoutClient.query(
      `SELECT id, register_session_id FROM shifts
       WHERE id = $1 AND location_id = $2 AND organization_id = $3 AND status = 'open'
       FOR UPDATE`,
      [shift_id, locationId, orgId],
    );
    if (shiftCheck.rows.length === 0) {
      await payoutClient.query("ROLLBACK");
      payoutResult = { kind: "error", status: 400, error: "Shift not found, not open, or not at this location" };
    } else {
      const shiftRegisterSessionId = shiftCheck.rows[0].register_session_id as string | null;

      // R38-A-F7: `>=` so a threshold set at $50 blocks a $50.00 pay-out.
      if (!isManager && numericAmount >= payoutThreshold) {
        if (!approval_id || typeof approval_id !== "string") {
          await payoutClient.query("ROLLBACK");
          payoutResult = { kind: "error", status: 403, error: `Pay-out exceeds $${payoutThreshold}; manager approval required.` };
        } else if (!shiftRegisterSessionId) {
          await payoutClient.query("ROLLBACK");
          payoutResult = { kind: "error", status: 400, error: "Shift has no associated register session" };
        } else {
          // The approval must be a `cash_payout` exception — NOT a
          // `transaction_void` — so a manager's void approval for some
          // unrelated sale can't be hijacked into authorizing a drawer
          // pay-out (R9-H-1). approvalPermissionMap in approval-action.ts
          // gates who may create a cash_payout exception.
          // check-pool-org-filter: scoped-by-register-session-id-from-org-gated-shift
          const consumeRes = await payoutClient.query(
            `UPDATE register_session_exceptions
             SET status = 'consumed'
             WHERE id = $1
               AND register_session_id = $2
               AND status = 'pending'
               AND exception_code = 'cash_payout'
               AND (expires_at IS NULL OR expires_at > now())
             RETURNING id`,
            [approval_id, shiftRegisterSessionId],
          );
          if (consumeRes.rows.length === 0) {
            await payoutClient.query("ROLLBACK");
            payoutResult = { kind: "error", status: 403, error: "Invalid, expired, or already-used approval" };
          } else {
            const insertRes = await payoutClient.query(
              `INSERT INTO pay_in_outs (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
               VALUES ($1, $2, $3, 'pay_out', $4, $5, $6, $7)
               RETURNING id, created_at`,
              [shift_id, locationId, actorEmployeeId, numericAmount, reason, note || null, orgId],
            );
            await payoutClient.query("COMMIT");
            payoutResult = { kind: "ok", id: insertRes.rows[0].id, created_at: insertRes.rows[0].created_at };
          }
        }
      } else {
        const insertRes = await payoutClient.query(
          `INSERT INTO pay_in_outs (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
           VALUES ($1, $2, $3, 'pay_out', $4, $5, $6, $7)
           RETURNING id, created_at`,
          [shift_id, locationId, actorEmployeeId, numericAmount, reason, note || null, orgId],
        );
        // R46-H3: audit INSIDE the tx. Prior shape waited until after
        // COMMIT via waitUntilOrAwait. On audit-write failure the
        // cash removal committed without a standalone audit row.
        await payoutClient.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'shift', $4, 'pay_out', $5, now())`,
          [
            orgId,
            locationId,
            actorEmployeeId,
            String(shift_id),
            JSON.stringify({
              pay_in_out_id: insertRes.rows[0].id,
              amount: numericAmount.toFixed(2),
              reason: String(reason),
              note: note ? String(note) : null,
              approval_id: approval_id ? String(approval_id) : null,
            }),
          ],
        );
        await payoutClient.query("COMMIT");
        payoutResult = { kind: "ok", id: insertRes.rows[0].id, created_at: insertRes.rows[0].created_at };
      }
    }
  } catch (e) {
    await payoutClient.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    payoutClient.release();
  }

  if (payoutResult.kind === "error") {
    return NextResponse.json({ error: payoutResult.error }, { status: payoutResult.status });
  }

  const payInOut = { id: payoutResult.id, created_at: payoutResult.created_at };

  return NextResponse.json(
    {
      success: true,
      payInOut: {
        id: payInOut.id,
        direction: 'pay_out',
        amount: numericAmount,
        reason,
        createdAt: payInOut.created_at,
      },
    },
    { status: 201 }
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calculate expected cash in the drawer for a shift:
 *   opening_float + cash_sales - cash_change_given + pay_ins - pay_outs
 *
 * Scoping rules:
 *  - Only transactions that fall between this shift's `opened_at` and
 *    `closed_at` (or NOW() for an open shift) are counted, NOT all
 *    transactions sharing the same register_session_id (which would pull
 *    prior shifts).
 *  - `change_due` is subtracted from `cash_sales` because change is physically
 *    removed from the drawer. Without this, `expectedCash` is overstated and
 *    every cash sale with change makes the drawer "short" by that amount.
 */
async function calculateExpectedCash(orgId: string, shiftId: string): Promise<number> {
  // Cash drawer math must reflect what physically moved in/out of the drawer
  // during THIS shift's open window.
  //   +opening_float
  //   +cash tenders inserted during the window (sales positive, refunds
  //    negative — handled by summing tt.amount where tt.created_at falls in
  //    the window; this correctly includes cross-shift refunds where the
  //    refund was recorded here but the original sale was earlier)
  //   -change_due given back (only for txns whose CREATED_AT is in window)
  //   +pay_ins - pay_outs
  const res = await orgQuery(
    orgId,
    `SELECT
       s.opening_float,
       COALESCE((SELECT SUM(p.amount) FROM pay_in_outs p WHERE p.shift_id = s.id AND p.direction = 'pay_in'), 0)::numeric AS pay_ins,
       COALESCE((SELECT SUM(p.amount) FROM pay_in_outs p WHERE p.shift_id = s.id AND p.direction = 'pay_out'), 0)::numeric AS pay_outs,
       COALESCE((
         SELECT SUM(tt.amount) FROM transaction_tenders tt
         JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
         WHERE t.register_session_id = s.register_session_id
           AND tt.tender_type = 'cash'
           AND tt.created_at >= s.opened_at
           AND (s.closed_at IS NULL OR tt.created_at <= s.closed_at)
       ), 0)::numeric AS cash_net,
       COALESCE((
         SELECT SUM(t.change_due) FROM transactions t
         WHERE t.register_session_id = s.register_session_id
           AND t.status = 'completed'
           AND t.organization_id = $2
           AND t.created_at >= s.opened_at
           AND (s.closed_at IS NULL OR t.created_at <= s.closed_at)
       ), 0)::numeric AS cash_change
     FROM shifts s WHERE s.id = $1 AND s.organization_id = $2`,
    [shiftId, orgId]
  );

  const row = res.rows[0];
  if (!row) return 0;
  return Number(
    (Number(row.opening_float) + Number(row.cash_net) - Number(row.cash_change) + Number(row.pay_ins) - Number(row.pay_outs)).toFixed(2)
  );
}
