import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("customer display payment status integration", () => {
  it("broadcast schema allows payment_started with a full cart, never scalar trusted totals", () => {
    const schema = read("src/lib/validation/display-message.ts");
    const paymentSchema = schema.slice(schema.indexOf('type: z.literal("payment_started")'), schema.indexOf('type: z.literal("receipt")'));
    expect(paymentSchema).toContain('type: z.literal("payment_started")');
    expect(paymentSchema).toContain("cart: cartSchema");
    expect(paymentSchema).not.toContain("totals: cartTotalsSchema");
  });

  it("POS terminal hook broadcasts payment_started when tender begins", () => {
    const src = read("src/components/register/usePOSTerminal.ts");
    expect(src).toContain('type: "payment_started"');
    expect(src).toContain('screen === "tender"');
    expect(src).toContain("broadcastCustomerDisplay");
  });

  it("register customer display client turns payment_started into payment mode with recomputed totals", () => {
    const client = read("src/app/register/customer-display/customer-display-client.tsx");
    expect(client).toContain('data.type === "payment_started"');
    expect(client).toContain('setPaymentStatus("processing")');
    expect(client).toContain("computeTotals(cartData)");
    expect(client).toContain("paymentStatus={paymentStatus}");
  });

  it("public customer display page handles payment_started without trusting scalar totals", () => {
    const page = read("src/app/customer-display/page.tsx");
    expect(page).toContain('case "payment_started"');
    const paymentWindow = page.slice(page.indexOf('case "payment_started"'), page.indexOf('case "receipt"'));
    expect(paymentWindow).toContain("computeTotals");
    expect(paymentWindow).not.toContain("message.totals");
  });

  it("customer display renders a customer-facing payment screen", () => {
    const component = read("src/components/register/customer-display.tsx");
    expect(component).toContain("paymentStatus?:");
    expect(component).toContain("PaymentScreen");
    expect(component).toContain("Payment in progress");
    expect(component).toContain("Amount due");
  });
});
