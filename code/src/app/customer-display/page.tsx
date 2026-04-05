"use client";

import { useState, useEffect } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { computeTotals } from "@/lib/cart/cart";
import { CustomerDisplay } from "@/components/register/customer-display";

interface DisplayMessage {
  type: "cart_update" | "payment_started" | "receipt" | "cart_clear";
  cart?: Cart;
  totals?: CartTotals;
  appliedPromo?: string | null;
  exchangeCredit?: number | null;
}

export default function CustomerDisplayPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [totals, setTotals] = useState<CartTotals | null>(null);
  const [paymentStarted, setPaymentStarted] = useState(false);
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [exchangeCredit, setExchangeCredit] = useState<number | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel("basicuniformpos_customer_display");

    const handleMessage = (event: MessageEvent<DisplayMessage>) => {
      const message = event.data;

      switch (message.type) {
        case "cart_update":
          if (message.cart) {
            setCart(message.cart);
            const newTotals = computeTotals(message.cart);
            setTotals(newTotals);
            setAppliedPromo(message.appliedPromo ?? null);
            setExchangeCredit(message.exchangeCredit ?? null);
            setPaymentStarted(false);
          }
          break;

        case "payment_started":
          setPaymentStarted(true);
          break;

        case "receipt":
          if (message.totals) {
            setTotals(message.totals);
          }
          break;

        case "cart_clear":
          setCart(null);
          setTotals(null);
          setAppliedPromo(null);
          setExchangeCredit(null);
          setPaymentStarted(false);
          break;
        default:
          // Unknown message type — ignore silently to avoid noise from future protocol extensions
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
      appliedPromo={appliedPromo}
      exchangeCredit={exchangeCredit}
    />
  );
}
