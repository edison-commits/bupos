"use client";

import { useState, useEffect } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { computeTotals, createCart } from "@/lib/cart/cart";
import { CustomerDisplay } from "@/components/register/customer-display";

interface CustomerDisplayClientProps {
  storeName: string;
  locationName: string;
}

/**
 * Customer-facing display client.
 * Listens for BroadcastChannel messages from the POS terminal
 * to sync cart state in real-time across browser windows.
 */
export function CustomerDisplayClient({ storeName, locationName }: CustomerDisplayClientProps) {
  const [cart, setCart] = useState<Cart>(() => createCart("", "", ""));
  const [totals, setTotals] = useState<CartTotals>({ subtotal: 0, modifiersTotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, itemCount: 0 });
  const [customerName, setCustomerName] = useState<string | undefined>(undefined);
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [exchangeCredit, setExchangeCredit] = useState<number | null>(null);

  useEffect(() => {
    // Listen for cart updates from the POS terminal via BroadcastChannel
    const channel = new BroadcastChannel("basicuniformpos_customer_display");

    channel.onmessage = (event) => {
      const data = event.data;
      if (data.type === "cart_update") {
        const cartData = data.cart as Cart;
        setCart(cartData);
        setTotals(computeTotals(cartData));
        setCustomerName(cartData.customerName);
        setAppliedPromo(data.appliedPromo ?? null);
        setExchangeCredit(data.exchangeCredit ?? null);
      } else if (data.type === "cart_clear") {
        setCart(createCart("", "", ""));
        setTotals({ subtotal: 0, modifiersTotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, itemCount: 0 });
        setCustomerName(undefined);
        setAppliedPromo(null);
        setExchangeCredit(null);
      }
    };

    return () => channel.close();
  }, []);

  return (
    <CustomerDisplay
      cart={cart}
      totals={totals}
      storeName={`${storeName} — ${locationName}`}
      customerName={customerName}
      appliedPromo={appliedPromo}
      exchangeCredit={exchangeCredit}
    />
  );
}
