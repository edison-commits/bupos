"use client";

import { useState, useEffect } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { computeTotals, createCart } from "@/lib/cart/cart";
import { CustomerDisplay, type CustomerDisplayBranding } from "@/components/register/customer-display";
import { displayMessageSchema } from "@/lib/validation/display-message";

interface CustomerDisplayClientProps {
  storeName: string;
  locationName: string;
  branding?: CustomerDisplayBranding;
}

/**
 * Customer-facing display client.
 * Listens for BroadcastChannel messages from the POS terminal
 * to sync cart state in real-time across browser windows.
 *
 * R27-H7: every message is Zod-validated before touching state.
 * BroadcastChannel is same-origin but has no sender authentication,
 * so any XSS elsewhere in the app could feed crafted payloads into
 * this display to spoof totals the customer sees at payment time.
 */
export function CustomerDisplayClient({ storeName, locationName, branding }: CustomerDisplayClientProps) {
  const [cart, setCart] = useState<Cart>(() => createCart("", "", ""));
  const [totals, setTotals] = useState<CartTotals>({ subtotal: 0, modifiersTotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, itemCount: 0 });
  const [customerName, setCustomerName] = useState<string | undefined>(undefined);
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [exchangeCredit, setExchangeCredit] = useState<number | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<"pending" | "processing">("pending");

  useEffect(() => {
    // Listen for cart updates from the POS terminal via BroadcastChannel
    const channel = new BroadcastChannel("basicuniformpos_customer_display");

    channel.onmessage = (event) => {
      const parsed = displayMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        console.error(
          "[customer-display-client] dropped malformed broadcast:",
          parsed.error.issues.slice(0, 3),
        );
        return;
      }
      const data = parsed.data;
      if (data.type === "cart_update") {
        if (data.cart) {
          const cartData = data.cart as Cart;
          setCart(cartData);
          setTotals(computeTotals(cartData));
          setCustomerName(cartData.customerName);
          setAppliedPromo(data.appliedPromo ?? null);
          setExchangeCredit(data.exchangeCredit ?? null);
          setPaymentStatus("pending");
        }
      } else if (data.type === "payment_started") {
        const cartData = data.cart as Cart;
        setCart(cartData);
        setTotals(computeTotals(cartData));
        setCustomerName(cartData.customerName);
        setAppliedPromo(data.appliedPromo ?? null);
        setExchangeCredit(data.exchangeCredit ?? null);
        setPaymentStatus("processing");
      } else if (data.type === "cart_clear") {
        setCart(createCart("", "", ""));
        setTotals({ subtotal: 0, modifiersTotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, itemCount: 0 });
        setCustomerName(undefined);
        setAppliedPromo(null);
        setExchangeCredit(null);
        setPaymentStatus("pending");
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
      paymentStatus={paymentStatus}
      branding={branding}
    />
  );
}
