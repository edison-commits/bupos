import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

const requiredString = z.string().trim().min(1);
const optionalString = z.string().trim().optional();
const optionalEmail = z.string().trim().email().optional();
const nonnegativeNumber = z.number().nonnegative();
const positiveInt = z.number().int().positive();

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const customerCreateSchema = z.object({
  first_name: requiredString,
  last_name: requiredString,
  email: optionalEmail,
  phone: optionalString,
  address: optionalString,
  notes: optionalString,
  is_active: z.boolean().optional(),
});

export const customerUpdateSchema = z.object({
  id: uuid,
  first_name: requiredString,
  last_name: requiredString,
  email: optionalEmail,
  phone: optionalString,
  address: optionalString,
  notes: optionalString,
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const variantCreateSchema = z.object({
  sku: requiredString,
  barcode: optionalString,
  name: requiredString,
  size_label: optionalString,
  color_label: optionalString,
  price: nonnegativeNumber,
  compare_at_price: nonnegativeNumber.optional(),
  cost: nonnegativeNumber.optional(),
});

const variantUpdateSchema = z.object({
  sku: requiredString.optional(),
  barcode: optionalString,
  name: requiredString.optional(),
  size_label: optionalString,
  color_label: optionalString,
  price: nonnegativeNumber.optional(),
  compare_at_price: nonnegativeNumber.optional(),
  cost: nonnegativeNumber.optional(),
});

export const productCreateSchema = z.object({
  name: requiredString,
  slug: optionalString,
  category_id: uuid,
  description: optionalString,
  image_url: optionalString,
  is_active: z.boolean().optional(),
  variant: variantCreateSchema,
});

export const productUpdateSchema = z.object({
  product_id: uuid,
  name: requiredString.optional(),
  slug: optionalString,
  category_id: uuid.optional(),
  description: optionalString,
  image_url: optionalString,
  is_active: z.boolean().optional(),
  variant: variantUpdateSchema.optional(),
});

const csvImportRowSchema = z.object({
  name: requiredString,
  sku: requiredString,
  price: nonnegativeNumber,
  category: optionalString,
  barcode: optionalString,
  size: optionalString,
  color: optionalString,
  cost: nonnegativeNumber.optional(),
  compare_at_price: nonnegativeNumber.optional(),
});

export const productImportSchema = z.object({
  action: z.literal("import"),
  rows: z.array(csvImportRowSchema).min(1),
});

export const productDeleteSchema = z.object({
  product_id: uuid,
});

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const supplierCreateSchema = z.object({
  name: requiredString,
  contact_name: optionalString,
  email: optionalEmail,
  phone: optionalString,
  address: optionalString,
  notes: optionalString,
});

export const supplierUpdateSchema = z.object({
  id: uuid,
  name: requiredString.optional(),
  contact_name: optionalString,
  email: optionalEmail,
  phone: optionalString,
  address: optionalString,
  notes: optionalString,
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------------

const purchaseOrderLineSchema = z.object({
  product_variant_id: uuid,
  quantity: positiveInt,
  unit_cost: nonnegativeNumber,
});

export const purchaseOrderCreateSchema = z.object({
  supplier_id: uuid,
  notes: optionalString,
  expected_at: optionalString,
  lines: z.array(purchaseOrderLineSchema).min(1),
});

export const purchaseOrderUpdateSchema = z.object({
  id: uuid,
  status: optionalString,
  notes: optionalString,
  expected_at: optionalString,
  ordered_at: optionalString,
});

const receiveLineSchema = z.object({
  line_id: uuid,
  quantity_received: z.number().int().nonnegative(),
});

export const purchaseOrderReceiveSchema = z.object({
  id: uuid,
  receives: z.array(receiveLineSchema).min(1),
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const expenseCreateSchema = z.object({
  category: requiredString,
  description: requiredString,
  amount: nonnegativeNumber,
  expense_date: optionalString,
  is_recurring: z.boolean().optional(),
  recurrence_period: optionalString,
  notes: optionalString,
});

export const expenseDeleteSchema = z.object({
  id: uuid,
});

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

const receivingItemSchema = z.object({
  product_variant_id: uuid,
  quantity: positiveInt,
});

export const receivingCreateSchema = z.object({
  type: z.literal("receive"),
  items: z.array(receivingItemSchema).min(1),
  po_id: uuid.optional(),
  mode: optionalString,
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsUpdateSchema = z.object({
  section: requiredString,
  data: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Shift Close
// ---------------------------------------------------------------------------

export const shiftCloseSchema = z.object({
  shiftId: uuid,
  declaredCash: nonnegativeNumber,
  notes: optionalString,
});

// ---------------------------------------------------------------------------
// Cash Drawer
// ---------------------------------------------------------------------------

export const cashDrawerSchema = z.object({
  action: z.enum(["open_shift", "close_shift", "pay_in", "pay_out"]),
  opening_float: nonnegativeNumber.optional(),
  shift_id: uuid.optional(),
  declared_cash: nonnegativeNumber.optional(),
  amount: nonnegativeNumber.optional(),
  reason: optionalString,
  note: optionalString,
  blind_close: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

const transferLineSchema = z.object({
  productVariantId: uuid,
  quantity: positiveInt,
});

export const transferSchema = z.object({
  action: z.enum(["create", "ship", "receive", "cancel"]),
  sourceLocationId: uuid.optional(),
  destinationLocationId: uuid.optional(),
  notes: optionalString,
  lines: z.array(transferLineSchema).optional(),
  id: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------

export const loyaltyAdjustSchema = z.object({
  customer_id: uuid,
  adjustment: z.number(),
  reason: optionalString,
});

// ---------------------------------------------------------------------------
// Gift Cards
// ---------------------------------------------------------------------------

export const giftCardSchema = z.object({
  action: z.enum(["activate", "reload", "disable"]),
  code: optionalString,
  amount: nonnegativeNumber.optional(),
  customerId: uuid.optional(),
  giftCardId: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Store Credit
// ---------------------------------------------------------------------------

export const storeCreditSchema = z.object({
  customerId: uuid,
  amount: z.number(),
  reason: optionalString,
  approvedBy: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Tax Config
// ---------------------------------------------------------------------------

export const taxConfigUpdateSchema = z.object({
  locationId: uuid,
  taxRate: nonnegativeNumber,
});

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export const shiftCreateSchema = z.object({
  employeeId: uuid,
  locationId: uuid,
  openingFloat: nonnegativeNumber,
  openedNote: optionalString,
});

// ---------------------------------------------------------------------------
// Email Receipt
// ---------------------------------------------------------------------------

export const emailReceiptSchema = z.object({
  to: z.string().trim().email(),
  transactionId: uuid,
  storeName: optionalString,
  items: z.array(z.unknown()).optional(),
  subtotal: nonnegativeNumber.optional(),
  tax: nonnegativeNumber.optional(),
  total: nonnegativeNumber.optional(),
  tenders: z.array(z.unknown()).optional(),
  loyaltyEarned: z.number().optional(),
  date: optionalString,
});

// ---------------------------------------------------------------------------
// Offline Sync
// ---------------------------------------------------------------------------

export const offlineSyncSchema = z.object({
  id: requiredString,
  cart: z.unknown(),
  tenders: z.unknown(),
  timestamp: optionalString,
  registerSessionId: uuid.optional(),
  approvedExceptions: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Promo Codes
// ---------------------------------------------------------------------------

export const promoCodeSchema = z.object({
  code: requiredString,
  description: optionalString,
  type: z.enum(["fixed", "percent", "bogo"]),
  value: nonnegativeNumber,
  minimumPurchase: nonnegativeNumber.optional(),
  maxRedemptions: z.number().int().positive().optional(),
  startsAt: optionalString,
  expiresAt: optionalString,
  action: z.enum(["create", "toggle"]).optional(),
});

// ---------------------------------------------------------------------------
// Shift Report
// ---------------------------------------------------------------------------

export const shiftReportSchema = z.object({
  action: z.literal("close_shift"),
  shiftId: uuid,
  declaredCash: nonnegativeNumber,
  note: optionalString,
  blindClose: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

const returnLineSchema = z.object({
  product_variant_id: uuid,
  quantity: positiveInt,
  unit_price: nonnegativeNumber,
});

export const returnCreateSchema = z.object({
  customer_name: optionalString,
  reason: optionalString,
  notes: optionalString,
  refund_method: optionalString,
  lines: z.array(returnLineSchema).min(1),
});

export const returnUpdateSchema = z.object({
  id: uuid,
  status: requiredString,
  processed_by: uuid.optional(),
});

const returnProcessItemSchema = z.object({
  variantId: uuid,
  quantity: positiveInt,
  unitPrice: nonnegativeNumber,
  restock: z.boolean().optional(),
});

export const returnProcessSchema = z.object({
  transaction_id: uuid,
  customer_name: optionalString,
  reason: optionalString,
  notes: optionalString,
  refund_method: optionalString,
  items: z.array(returnProcessItemSchema).min(1),
  refund_amount: nonnegativeNumber,
});

// ---------------------------------------------------------------------------
// EOD Report
// ---------------------------------------------------------------------------

export const eodReportSchema = z.object({
  action: optionalString,
});

// ---------------------------------------------------------------------------
// Customer Display
// ---------------------------------------------------------------------------

export const customerDisplaySchema = z.object({
  registerSessionId: uuid,
  cart: z.unknown(),
  totals: z.unknown(),
  paymentStatus: optionalString,
  amountTendered: nonnegativeNumber.optional(),
  changeDue: nonnegativeNumber.optional(),
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const employeeCreateSchema = z.object({
  firstName: requiredString,
  lastName: requiredString,
  displayName: optionalString,
  email: optionalEmail,
  phone: optionalString,
  roleKey: requiredString,
  pin: requiredString,
  pinHint: optionalString,
  locationIds: z.array(uuid).min(1),
});

export const employeeUpdateSchema = z.object({
  id: uuid,
  firstName: requiredString.optional(),
  lastName: requiredString.optional(),
  displayName: optionalString,
  email: optionalEmail,
  phone: optionalString,
  roleKey: requiredString.optional(),
  pin: requiredString.optional(),
  pinHint: optionalString,
  locationIds: z.array(uuid).optional(),
  isActive: z.boolean().optional(),
});

export const employeePatchSchema = z.object({
  id: uuid,
  action: z.enum(["deactivate", "reset_pin"]),
  pin: requiredString.optional(),
});

// ---------------------------------------------------------------------------
// Generic validate helper
// ---------------------------------------------------------------------------

export function validateBody<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { success: true, data: result.data };
}
