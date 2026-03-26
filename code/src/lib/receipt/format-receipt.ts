import { ESCPOSBuilder } from "./escpos";
import type { CartLineItem } from "@/lib/cart/types";

export interface ReceiptData {
  storeName: string;
  locationName: string;
  locationAddress?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  cashierName: string;
  timestamp: string;
  customerName?: string;
  taxExempt?: boolean;
  items: CartLineItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  tenders: { type: string; amount: number }[];
  changeDue: number;
  transactionId: string;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
}

export function formatReceipt(data: ReceiptData): Uint8Array {
  const b = new ESCPOSBuilder();

  b.init();

  // Header
  if (data.receiptHeader) {
    b.align("center").line(data.receiptHeader);
  }
  b.align("center").bold(true).doubleHeight(true).line(data.storeName);
  b.doubleHeight(false).bold(false);
  b.line(data.locationName);
  if (data.locationAddress) b.line(data.locationAddress);
  b.line(data.timestamp);
  b.line(`Cashier: ${data.cashierName}`);
  if (data.customerName) {
    b.line(`Customer: ${data.customerName}`);
    if (data.taxExempt) b.bold(true).line("*** TAX EXEMPT ***").bold(false);
  }

  b.align("left").separator();

  // Items
  for (const item of data.items) {
    const effectivePrice = item.overridePrice ?? item.unitPrice;
    const lineTotal = effectivePrice * item.quantity;
    const name = item.quantity > 1
      ? `${item.quantity}x ${item.productName} (${item.variantName})`
      : `${item.productName} (${item.variantName})`;
    b.columns(name.slice(0, 36), `$${lineTotal.toFixed(2)}`);
    if (item.lineDiscount) {
      const discAmt = item.lineDiscount.mode === "percent"
        ? (lineTotal * item.lineDiscount.value / 100)
        : item.lineDiscount.value;
      b.columns("  Discount", `-$${discAmt.toFixed(2)}`);
    }
  }

  b.separator();

  // Totals
  b.columns("Subtotal", `$${data.subtotal.toFixed(2)}`);
  if (data.discountTotal > 0) {
    b.columns("Discount", `-$${data.discountTotal.toFixed(2)}`);
  }
  if (data.taxExempt) {
    b.columns("Tax (EXEMPT)", "$0.00");
  } else {
    b.columns("Tax", `$${data.taxTotal.toFixed(2)}`);
  }
  b.bold(true).columns("TOTAL", `$${data.grandTotal.toFixed(2)}`).bold(false);

  b.separator();

  // Tenders
  for (const t of data.tenders) {
    const label = t.type === "store_credit" ? "Store Credit" : t.type.charAt(0).toUpperCase() + t.type.slice(1);
    b.columns(label, `$${t.amount.toFixed(2)}`);
  }
  if (data.changeDue > 0) {
    b.columns("Change", `$${data.changeDue.toFixed(2)}`);
  }

  // Loyalty
  if (data.loyaltyPointsEarned || data.loyaltyPointsRedeemed) {
    b.separator();
    if (data.loyaltyPointsEarned) b.columns("Points earned", String(data.loyaltyPointsEarned));
    if (data.loyaltyPointsRedeemed) b.columns("Points redeemed", String(data.loyaltyPointsRedeemed));
  }

  b.separator();

  // Footer
  b.align("center");
  b.line(`TXN ${data.transactionId.slice(0, 8).toUpperCase()}`);
  b.feed();
  b.line(data.receiptFooter ?? "Thank you for shopping with us!");

  b.cut();

  return b.build();
}
