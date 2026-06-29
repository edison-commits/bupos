"use client";

import { useState, useEffect } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { computeTotals } from "@/lib/cart/cart";
import { CustomerDisplay } from "@/components/register/customer-display";
import { displayMessageSchema } from "@/lib/validation/display-message";

export default function CustomerDisplayPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [totals, setTotals] = useState<CartTotals | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [exchangeCredit, setExchangeCredit] = useState<number | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<"pending" | "processing">("pending");

  useEffect(() => {
    const channel = new BroadcastChannel("basicuniformpos_customer_display");

    const handleMessage = (event: MessageEvent<unknown>) => {
      // R27-H7: validate before trusting. `event.data` is attacker-
      // controllable if the app has any XSS surface elsewhere.
      const parsed = displayMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        console.error(
          "[customer-display] dropped malformed broadcast:",
          parsed.error.issues.slice(0, 3),
        );
        return;
      }
      const message = parsed.data;

      switch (message.type) {
        case "cart_update":
          if (message.cart) {
            setCart(message.cart as Cart);
            const newTotals = computeTotals(message.cart as Cart);
            setTotals(newTotals);
            setAppliedPromo(message.appliedPromo ?? null);
            setExchangeCredit(message.exchangeCredit ?? null);
            setPaymentStatus("pending");
          }
          break;

        case "payment_started":
          setCart(message.cart as Cart);
          setTotals(computeTotals(message.cart as Cart));
          setAppliedPromo(message.appliedPromo ?? null);
          setExchangeCredit(message.exchangeCredit ?? null);
          setPaymentStatus("processing");
          break;

        case "receipt":
          // R28-C7: intentional no-op. Prior version set `totals`
          // directly from `message.totals` WITHOUT recomputation —
          // any same-origin XSS could post a `receipt` message with
          // `grandTotal: 0.01` and spoof the customer-facing display
          // while the cashier's real transaction rang $100. The POS
          // now re-sends the full `cart_update` when transitioning
          // into the receipt view, and `cart_update`'s totals are
          // recomputed server-side via `computeTotals(cart)` which
          // can't be spoofed through scalar payload values.
          break;

        case "cart_clear":
          setCart(null);
          setTotals(null);
          setAppliedPromo(null);
          setExchangeCredit(null);
          setPaymentStatus("pending");
          break;
      }
    };

    channel.addEventListener("message", handleMessage);

    return () => {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    };
  }, []);

  // Show idle screen when no cart data
  if (!cart || !totals) {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-full bg-slate-950 text-white">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">Basic Uniform</h1>
          <p className="text-xl text-slate-400">Ready for next customer</p>
        </div>
      </div>
    );
  }

  return (
    <CustomerDisplay
      cart={cart}
      totals={totals}
      storeName="Basic Uniform"
      customerName={cart.customerName}
      appliedPromo={appliedPromo}
      exchangeCredit={exchangeCredit}
      paymentStatus={paymentStatus}
    />
  );
}
