import { NextRequest, NextResponse } from "next/server";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { getRegisterSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/authz";

/**
 * In-memory store for customer display state
 * Keyed by registerSessionId
 * In production, this could read from a Redis cache or database
 */
const displayStateStore = new Map<
  string,
  {
    cart: Cart;
    totals: CartTotals;
    paymentStatus?: "pending" | "processing" | "complete";
    amountTendered?: number;
    changeDue?: number;
    updatedAt: number;
  }
>();

async function authorizeRegisterSession(registerSessionId: string) {
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
  return null;
}

/**
 * POST /api/customer-display
 *
 * The POS terminal POSTs the current register state here when cart updates.
 * Body:
 *   {
 *     registerSessionId: string,
 *     cart: Cart,
 *     totals: CartTotals,
 *     paymentStatus?: 'pending' | 'processing' | 'complete',
 *     amountTendered?: number,
 *     changeDue?: number
 *   }
 */
export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const {
      registerSessionId,
      cart,
      totals,
      paymentStatus,
      amountTendered,
      changeDue,
    } = data;

    if (!registerSessionId) {
      return NextResponse.json(
        { error: "registerSessionId is required" },
        { status: 400 }
      );
    }
    const authError = await authorizeRegisterSession(registerSessionId);
    if (authError) {
      return authError;
    }

    if (!cart || !totals) {
      return NextResponse.json(
        { error: "cart and totals are required" },
        { status: 400 }
      );
    }

    // Store the state with timestamp
    displayStateStore.set(registerSessionId, {
      cart,
      totals,
      paymentStatus,
      amountTendered,
      changeDue,
      updatedAt: Date.now(),
    });

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
 * Query params:
 *   registerSessionId - the session ID to fetch state for
 *   timeout - how long to wait for updates (ms, default 2000)
 */
export async function GET(req: NextRequest) {
  const registerSessionId = req.nextUrl.searchParams.get("registerSessionId");

  if (!registerSessionId) {
    return NextResponse.json(
      { error: "registerSessionId query param is required" },
      { status: 400 }
    );
  }
  const authError = await authorizeRegisterSession(registerSessionId);
  if (authError) {
    return authError;
  }

  const state = displayStateStore.get(registerSessionId);

  if (!state) {
    // Return empty cart state
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

  // Return the stored state
  return NextResponse.json(state, { status: 200 });
}

/**
 * DELETE /api/customer-display
 *
 * Clear the display state for a session (called when transaction completes)
 * Query params:
 *   registerSessionId - the session ID to clear
 */
export async function DELETE(req: NextRequest) {
  const registerSessionId = req.nextUrl.searchParams.get("registerSessionId");

  if (!registerSessionId) {
    return NextResponse.json(
      { error: "registerSessionId query param is required" },
      { status: 400 }
    );
  }
  const authError = await authorizeRegisterSession(registerSessionId);
  if (authError) {
    return authError;
  }

  displayStateStore.delete(registerSessionId);

  return NextResponse.json(
    { success: true, message: "Customer display state cleared" },
    { status: 200 }
  );
}
