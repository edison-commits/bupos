import { NextRequest, NextResponse } from "next/server";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { getRegisterSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/authz";
import { orgQuery } from "@/lib/db";
import { validateBody, customerDisplaySchema } from "@/lib/validation/schemas";

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

/**
 * POST /api/customer-display
 *
 * The POS terminal POSTs the current register state here when cart updates.
 */
export async function POST(req: NextRequest) {
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

    return NextResponse.json(
      { success: true, message: "Customer display state updated" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error updating customer display state:", error);
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

  const { rows } = await orgQuery(
    orgId,
    `SELECT cart, totals, payment_status, amount_tendered, change_due, updated_at
     FROM customer_display_state WHERE register_session_id = $1`,
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
      { status: 200 }
    );
  }

  const row = rows[0];
  return NextResponse.json(
    {
      cart: row.cart,
      totals: row.totals,
      paymentStatus: row.payment_status,
      amountTendered: row.amount_tendered ? Number(row.amount_tendered) : null,
      changeDue: row.change_due ? Number(row.change_due) : null,
      updatedAt: row.updated_at,
    },
    { status: 200 }
  );
}

/**
 * DELETE /api/customer-display
 *
 * Clear the display state for a session (called when transaction completes)
 */
export async function DELETE(req: NextRequest) {
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
