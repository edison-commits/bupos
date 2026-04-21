/**
 * R27-H7: Zod schema for the customer-display BroadcastChannel.
 *
 * Two consumers:
 *   • src/app/customer-display/page.tsx (unauthenticated public display)
 *   • src/app/register/customer-display/customer-display-client.tsx
 *     (paired-display rendered inside an authenticated register layout)
 *
 * Both receive same-origin BroadcastChannel messages from the POS
 * terminal. Since BroadcastChannel has NO sender authentication
 * within the origin, any XSS anywhere in the app (admin comment,
 * product description, SSRF'd resource) can post arbitrary payloads
 * into the channel. Trusting `event.data` without validation means
 * an XSS attacker can:
 *   • Show the customer a $0.01 total while the cashier rings $100
 *   • Display a fake "payment complete" screen and walk out with stock
 *   • Inject a phishing overlay ("Please hand the register your PIN")
 *     since the page reads message.cart / message.totals directly
 *
 * This schema is intentionally strict on the fields that drive the
 * display's trust model (types, numbers finite, quantities non-neg).
 * Unknown top-level types are REJECTED (discriminatedUnion), and
 * each message variant lists its allowed fields exhaustively (no
 * `.passthrough()`).
 */
import { z } from "zod";

// R28-C7: price/total/quantity fields are `.nonnegative()` (not merely
// `.finite()`) — the display renders these directly; a same-origin XSS
// payload with negative values could misrepresent totals as "store owes
// customer $50" or "grandTotal = $0.01" to social-engineer the
// customer. Upper-bounded at 10M to match the server-side MAX_MONEY
// cap (schemas.ts:25). quantity is `.int().positive()` because a
// broadcast should never contain zero-quantity lines.
const money = z.number().finite().nonnegative().max(10_000_000);

const cartLineItemSchema = z.object({
  id: z.string(),
  productVariantId: z.string(),
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  unitPrice: money,
  overridePrice: money.optional(),
  quantity: z.number().int().positive(),
  modifierIds: z.array(z.string()),
  modifierTotal: money,
  lineDiscount: z
    .object({
      mode: z.enum(["amount", "percent"]).optional(),
      value: money.optional(),
    })
    .optional(),
  bundleId: z.string().optional(),
  bundleComponents: z
    .array(
      z.object({
        productVariantId: z.string(),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  promoCodeId: z.string().optional(),
}).strict();

const cartSchema = z.object({
  id: z.string(),
  registerSessionId: z.string(),
  employeeId: z.string(),
  locationId: z.string(),
  customerId: z.string().optional(),
  customerName: z.string().optional(),
  items: z.array(cartLineItemSchema).max(500),
  discountAmount: money,
  discountMode: z.enum(["amount", "percent"]),
  // Tax rate is a FRACTION (e.g., 0.1025 for 10.25%). Cap at 1.0 — any
  // broadcast claiming tax > 100% is malicious.
  taxRate: z.number().finite().nonnegative().max(1),
  status: z.enum(["open", "checked_out", "voided"]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const cartTotalsSchema = z.object({
  subtotal: money,
  modifiersTotal: money,
  discountTotal: money,
  taxTotal: money,
  grandTotal: money,
  itemCount: z.number().int().nonnegative(),
}).strict();

export const displayMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cart_update"),
    cart: cartSchema.optional(),
    appliedPromo: z.string().nullable().optional(),
    exchangeCredit: z.number().finite().nullable().optional(),
  }),
  z.object({ type: z.literal("payment_started") }),
  z.object({
    type: z.literal("receipt"),
    totals: cartTotalsSchema.optional(),
  }),
  z.object({ type: z.literal("cart_clear") }),
]);
