import { BUPOS_LOCATION_ID } from '@/lib/env';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPermission } from '@/lib/authz';
import pool, { orgQuery, orgTx } from '@/lib/db';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';

const LOCATION_ID = BUPOS_LOCATION_ID;

/**
 * GET /api/cash-drawer?action=status|history
 *
 * action=status: Returns current open shift (if any) with pay_in_outs totals
 * action=history: Returns last 10 closed shifts with summary
 */
export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const action = req.nextUrl.searchParams.get('action') || 'status';

    if (action === 'status') {
      return handleGetStatus(orgId);
    } else if (action === 'history') {
      return handleGetHistory(orgId);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[cash-drawer GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch cash drawer data' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cash-drawer
 * Body: { action: 'open_shift' | 'close_shift' | 'pay_in' | 'pay_out', ... }
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAdminPermission('register.open');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {

    const body = await req.json();
    const { action } = body;
    const actorEmployeeId = ctx.employee.id;

    if (action === 'open_shift') {
      return handleOpenShift(orgId, actorEmployeeId, body);
    } else if (action === 'close_shift') {
      return handleCloseShift(orgId, body);
    } else if (action === 'pay_in') {
      return handlePayIn(orgId, actorEmployeeId, body);
    } else if (action === 'pay_out') {
      return handlePayOut(orgId, actorEmployeeId, body);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[cash-drawer POST]', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET Handlers
// ────────────────────────────────────────────────────────────────────────────

async function handleGetStatus(orgId: string) {
  // Single query: fetch open shift with pay_in_outs totals via subqueries
  const shiftRes = await orgQuery(
    orgId,
    `SELECT s.id, s.employee_id, s.opened_at, s.opening_float, s.status,
            e.display_name AS employee_name,
            COALESCE((SELECT SUM(amount) FROM pay_in_outs WHERE shift_id = s.id AND direction = 'pay_in'), 0)::numeric AS pay_ins,
            COALESCE((SELECT SUM(amount) FROM pay_in_outs WHERE shift_id = s.id AND direction = 'pay_out'), 0)::numeric AS pay_outs
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.location_id = $1 AND s.status = 'open'
     ORDER BY s.opened_at DESC
     LIMIT 1`,
    [LOCATION_ID]
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

async function handleGetHistory(orgId: string) {
  // Fetch last 10 closed shifts with summary
  const shiftsRes = await orgQuery(
    orgId,
    `SELECT s.id, s.employee_id, e.display_name AS employee_name,
            s.opened_at, s.closed_at, s.opening_float,
            s.closing_expected_cash, s.closing_declared_cash,
            s.closing_variance
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.location_id = $1 AND s.status = 'closed'
     ORDER BY s.closed_at DESC
     LIMIT 10`,
    [LOCATION_ID]
  );

  const shifts = shiftsRes.rows.map((row: any) => ({
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

async function handleOpenShift(orgId: string, actorEmployeeId: string, body: any) {
  const { opening_float, note } = body;

  if (opening_float === undefined) {
    return NextResponse.json(
      { error: 'Missing required field: opening_float' },
      { status: 400 }
    );
  }

  // Get or create register session
  const regSessionRes = await orgQuery(
    orgId,
    `SELECT id FROM register_sessions
     WHERE location_id = $1 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [LOCATION_ID]
  );

  let registerSessionId = regSessionRes.rows[0]?.id;

  if (!registerSessionId) {
    // Create new register session
    const newRegSessionRes = await orgQuery(
      orgId,
      `INSERT INTO register_sessions
       (auth_session_id, employee_id, location_id, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, 'active', NOW())
       RETURNING id`,
      [actorEmployeeId, LOCATION_ID]
    );
    registerSessionId = newRegSessionRes.rows[0].id;
  }

  // Create shift
  const shiftRes = await orgQuery(
    orgId,
    `INSERT INTO shifts
     (location_id, employee_id, register_session_id, opening_float, opened_note, status)
     VALUES ($1, $2, $3, $4, $5, 'open')
     RETURNING id, opened_at`,
    [
      LOCATION_ID,
      actorEmployeeId,
      registerSessionId,
      opening_float,
      note || null,
    ]
  );

  const shift = shiftRes.rows[0];

  return NextResponse.json(
    {
      success: true,
      shift: {
        id: shift.id,
        openedAt: shift.opened_at,
        openingFloat: Number(opening_float),
      },
    },
    { status: 201 }
  );
}

async function handleCloseShift(orgId: string, body: any) {
  const { shift_id, declared_cash, note, blind_close } = body;

  if (!shift_id || declared_cash === undefined) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, declared_cash' },
      { status: 400 }
    );
  }

  // Fetch shift and build expected cash
  const shiftRes = await orgQuery(
    orgId,
    `SELECT s.id, s.opening_float, s.register_session_id
     FROM shifts s
     WHERE s.id = $1 AND s.location_id = $2`,
    [shift_id, LOCATION_ID]
  );

  if (shiftRes.rows.length === 0) {
    return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
  }

  const shift = shiftRes.rows[0];
  const expectedCash = await calculateExpectedCash(orgId, shift_id);
  const variance = Number(declared_cash) - expectedCash;

  // Update shift with closure details
  const client = await orgTx(orgId);
  try {
    await client.query(
      `UPDATE shifts
       SET status = 'closed',
           closed_at = NOW(),
           closing_expected_cash = $1,
           closing_declared_cash = $2,
           closing_variance = $3,
           closed_note = $4,
           blind_close = $5
       WHERE id = $6`,
      [expectedCash, declared_cash, variance, note || null, blind_close || false, shift_id]
    );
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

async function handlePayIn(orgId: string, actorEmployeeId: string, body: any) {
  const { shift_id, amount, reason, note } = body;

  if (!shift_id || !amount || !reason) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, amount, reason' },
      { status: 400 }
    );
  }

  const payRes = await orgQuery(
    orgId,
    `INSERT INTO pay_in_outs
     (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
     VALUES ($1, $2, $3, 'pay_in', $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      shift_id,
      LOCATION_ID,
      actorEmployeeId,
      amount,
      reason,
      note || null,
      orgId,
    ]
  );

  const payInOut = payRes.rows[0];

  return NextResponse.json(
    {
      success: true,
      payInOut: {
        id: payInOut.id,
        direction: 'pay_in',
        amount: Number(amount),
        reason,
        createdAt: payInOut.created_at,
      },
    },
    { status: 201 }
  );
}

async function handlePayOut(orgId: string, actorEmployeeId: string, body: any) {
  const { shift_id, amount, reason, note } = body;

  if (!shift_id || !amount || !reason) {
    return NextResponse.json(
      { error: 'Missing required fields: shift_id, amount, reason' },
      { status: 400 }
    );
  }

  const payRes = await orgQuery(
    orgId,
    `INSERT INTO pay_in_outs
     (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
     VALUES ($1, $2, $3, 'pay_out', $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      shift_id,
      LOCATION_ID,
      actorEmployeeId,
      amount,
      reason,
      note || null,
      orgId,
    ]
  );

  const payInOut = payRes.rows[0];

  return NextResponse.json(
    {
      success: true,
      payInOut: {
        id: payInOut.id,
        direction: 'pay_out',
        amount: Number(amount),
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
 * Calculate expected cash for a shift:
 * opening_float + cash_sales + pay_ins - pay_outs
 */
async function calculateExpectedCash(orgId: string, shiftId: string): Promise<number> {
  // Single query with subqueries to avoid multiple connections
  const res = await orgQuery(
    orgId,
    `SELECT
       s.opening_float,
       COALESCE((SELECT SUM(p.amount) FROM pay_in_outs p WHERE p.shift_id = s.id AND p.direction = 'pay_in'), 0)::numeric AS pay_ins,
       COALESCE((SELECT SUM(p.amount) FROM pay_in_outs p WHERE p.shift_id = s.id AND p.direction = 'pay_out'), 0)::numeric AS pay_outs,
       COALESCE((
         SELECT SUM(tt.amount) FROM transaction_tenders tt
         JOIN transactions t ON t.id = tt.transaction_id
         WHERE t.register_session_id = s.register_session_id
           AND tt.tender_type = 'cash' AND t.status = 'completed'
       ), 0)::numeric AS cash_sales
     FROM shifts s WHERE s.id = $1`,
    [shiftId]
  );

  const row = res.rows[0];
  if (!row) return 0;
  return Number(row.opening_float) + Number(row.cash_sales) + Number(row.pay_ins) - Number(row.pay_outs);
}
