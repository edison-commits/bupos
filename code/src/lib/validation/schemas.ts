import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

// Reasonable length limits to prevent DoS via large payloads
const MAX_STRING = 2000;

const requiredString = z.string().trim().min(1).max(MAX_STRING);
const optionalString = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().trim().max(MAX_STRING).optional(),
);
const optionalEmail = z.preprocess(
  // Treat empty-string email fields as undefined (HTML forms send "" when cleared)
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().email().max(320).optional(),
);
// Bounded money amount — caps at $10M to prevent integer overflow / abuse.
// (POS transactions > $10M should be rejected at the business-logic layer
// long before reaching the DB.)
const MAX_MONEY = 10_000_000;
const nonnegativeNumber = z.number().nonnegative().max(MAX_MONEY);
const positiveInt = z.number().int().positive().max(1_000_000);
const pinString = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");
// R33-M-admin-image-url: every admin-writable imageUrl (product,
// bundle, category) must be https or a relative path. Prior shape
// (`optionalString`) accepted `javascript:`, `data:text/html`, etc.
// <img src="javascript:..."> doesn't execute in modern browsers but
// `<a href>` bindings or future SSR that inlines into <script> or
// attribute operands would.
const imageUrlField = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().trim().max(2000)
    .refine(
      // SEC-AUDIT10: a relative path must be `/path`, NOT `//evil.com`
      // (protocol-relative). Today imageUrl only renders in <img src>, but if
      // it ever reaches an <a href>/CSS url() a `//host` becomes a redirect/
      // exfil vector — reject it at the boundary.
      (s) => /^https:\/\//i.test(s) || (s.startsWith('/') && !s.startsWith('//')),
      "imageUrl must be an https URL or a relative path",
    )
    .refine(
      (s) => !/^(?:javascript|data|vbscript|file):/i.test(s),
      "imageUrl must not use javascript/data/vbscript/file protocols",
    )
    .optional(),
);
// R30-M1 / R31-M1: pinHint is free-text but must NEVER be readable
// as a PIN. A manager could otherwise reset a cashier's PIN, write
// the plaintext PIN into the pinHint field, and later impersonate
// that cashier at a different register. Reject any value whose
// non-letter characters could spell out a sequence of digits:
//   - pure digits ("1234")
//   - digits + whitespace or punctuation ("1 2 3 4", "1-2-3-4",
//     "1.2.3.4", "1,2,3,4", "1/2/3/4", "1:2:3:4", "1|2|3|4")
// Positive test: the value must contain at least ONE letter. That's
// the simplest mechanical rule that makes "pin is my birthday" OK
// while rejecting every digit-smuggling variant.
const pinHintField = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().trim().max(MAX_STRING)
    .refine(
      (s) => /\p{L}/u.test(s),
      "PIN hint must contain at least one letter (prevents digit-only leaks of the PIN)",
    )
    .optional(),
);
const roleKeyEnum = z.enum(["owner", "manager", "cashier", "inventory_clerk", "support"]);
const isoDateTime = z.string().datetime({ offset: true });
// Shared refund-method enum — used by both returnCreateSchema and returnProcessSchema
const refundMethodEnum = z.enum([
  "original_tender", "cash", "store_credit", "gift_card", "credit_card", "debit_card", "exchange",
]);

// SIM-AUDIT8: the `returns.reason` column has a DB CHECK constraint. The
// schemas typed `reason` as a free string, so any value outside this set
// (e.g. the admin returns UI's 'damaged') passed validation and 500'd at the
// CHECK instead of failing as a clean 400. Mirror the DB CHECK here.
const returnReasonEnum = z.enum([
  "defective", "wrong_size", "wrong_item", "changed_mind", "other",
]);

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
  first_name: requiredString.optional(),
  last_name: requiredString.optional(),
  email: optionalEmail,
  phone: optionalString,
  address: optionalString,
  notes: optionalString,
  is_active: z.boolean().optional(),
});

export const customerPreferenceSchema = z.object({
  category: requiredString,
  size_label: optionalString,
  fit_preference: optionalString,
  preferred_colors: z.array(requiredString).max(12).optional().default([]),
  preferred_brands: z.array(requiredString).max(12).optional().default([]),
  style_notes: optionalString,
}).strict();

export const customerPreferencesUpdateSchema = z.object({
  customer_id: uuid,
  preferences: z.array(customerPreferenceSchema).max(24),
}).strict();

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

// R62-L2 / R64-C1: `.strict()` with `variant` OPTIONAL. The POST
// handler has two branches:
//   (a) `body.product_id && body.variant` → variant-create on an
//       existing product. Both required in this branch.
//   (b) `body.category` → category-create (unrelated to product
//       fields).
//   (c) default → product-create via productCreateSchema shape
//       alone (AddProductModal in the admin UI uses this and
//       doesn't submit a nested `variant`).
// R62-L2 initially made `variant` required, which broke (c). Now
// it's optional; the handler's own branching still requires it on
// (a).
export const productCreateSchema = z.object({
  name: requiredString,
  slug: optionalString,
  category_id: uuid.optional(),
  description: optionalString,
  // FE-MED1: route through `imageUrlField` so `javascript:` / `data:` /
  // `vbscript:` / `file:` URIs are rejected at the validation boundary.
  // Bundle/category schemas (lines 786, 799) use it; product schemas
  // had drifted to bare `optionalString`. Today nothing renders
  // `<a href={imageUrl}>`, but the documented invariant per R33-M-
  // admin-image-url is "every admin-writable imageUrl" — restore parity.
  image_url: imageUrlField,
  is_active: z.boolean().optional(),
  is_touch_favorite: z.boolean().optional(),
  variant: variantCreateSchema.optional(),
  // Used by the variant-create branch (POST with product_id +
  // variant.*).
  product_id: uuid.optional(),
  actorPassword: z.string().max(200).optional(),
}).strict();

// R62-L2 / R64-C1: `.strict()` with product_id OPTIONAL at the
// schema level (either branch is valid: product-update requires
// product_id, variant-update requires variant_id; the handler's
// branching does the actual presence check). The schema guards
// unknown keys and validates types of the fields it lists.
export const productUpdateSchema = z.object({
  product_id: uuid.optional(),
  name: requiredString.optional(),
  slug: optionalString,
  category_id: uuid.optional(),
  description: optionalString,
  // FE-MED1: parity with productCreateSchema — `imageUrlField` rejects
  // `javascript:` / `data:` / `vbscript:` / `file:` URIs.
  image_url: imageUrlField,
  is_active: z.boolean().optional(),
  is_touch_favorite: z.boolean().optional(),
  variant: variantUpdateSchema.optional(),
  // Top-level variant-update fields (the handler uses a "variant_id
  // + flat price/cost" shape, distinct from the `variant: {...}`
  // nested shape above).
  variant_id: uuid.optional(),
  price: z.union([z.number(), z.string()]).optional(),
  cost: z.union([z.number(), z.string()]).optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
  // Step-up password lives on every mutating admin endpoint.
  actorPassword: z.string().max(200).optional(),
}).strict();

// R26-F8: tighten per-field caps for CSV import. The generic
// `requiredString` / `optionalString` allow 2000 chars each — multiplied
// across 7 string fields × 2000 rows, an adversarial payload reaches
// ~28MB, blowing past the 2MB MAX_REQUEST_BODY_BYTES gate AND making
// the row-cap × field-cap math impossible to keep under budget.
//
// Realistic CSV rows have short names/SKUs (POS products are rarely
// > 200 chars per field). These dedicated caps keep worst-case
// row-size bounded: 7 × 200 + 3 × 20 ≈ 1.5KB. 1500 rows × 1.5KB ≈
// 2.2MB, which fits the (newly-aware) 3MB import-route limit with
// headroom for JSON overhead.
const csvShortString = z.string().trim().min(1).max(200);
const csvShortOptionalString = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().trim().max(200).optional(),
);

// FE2-LOW1: csvImportRowSchema previously omitted `image_url`,
// `description`, `is_active`. The route handler reads them via
// `row.image_url || row.imageUrl || row.IMAGE_URL`, but Zod's default
// strip-mode dropped every unknown key — so the URL/description/
// is_active flag from the CSV silently never threaded through. Three
// fields added below; all kept optional so existing imports keep
// working unchanged. `image_url` uses the same `imageUrlField`
// validator as productCreateSchema so `javascript:` / `data:` URIs
// are rejected at the validation boundary.
const csvImportRowSchema = z.object({
  name: csvShortString,
  sku: csvShortString,
  price: nonnegativeNumber,
  category: csvShortOptionalString,
  barcode: csvShortOptionalString,
  size: csvShortOptionalString,
  color: csvShortOptionalString,
  cost: nonnegativeNumber.optional(),
  compare_at_price: nonnegativeNumber.optional(),
  image_url: imageUrlField,
  description: csvShortOptionalString,
  // CSVs ship `is_active` as the string "true"/"false". Pre-process to
  // a boolean so the route's `String(row.is_active).toLowerCase() !==
  // "false"` shape keeps working with both the raw CSV string AND a
  // future parser that hands us a boolean.
  is_active: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? undefined : String(v)),
    z.string().max(10).optional(),
  ),
});

export const productImportSchema = z.object({
  action: z.literal("import"),
  // R18-LOW-3 + R26-F8: upper bound on batch size.
  //
  // Math: 1200 rows × ~1.5KB per row ≈ 1.8MB worst case, fits within
  // the 2MB MAX_REQUEST_BODY_BYTES gate (src/lib/api/with-auth.ts)
  // with headroom for JSON structural overhead. The prior 2000 cap
  // paired with the generic 2KB/field caps was unsatisfiable — a
  // valid-schema payload could exceed the body limit (rejected at 413)
  // AND a valid-body payload could exceed the Workers CPU budget.
  rows: z.array(csvImportRowSchema).min(1).max(1200),
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
  expected_at: isoDateTime.optional(),
  // R18-LOW-3: upper bound — see productImportSchema for rationale. 500
  // lines is far above any real PO we've seen.
  lines: z.array(purchaseOrderLineSchema).min(1).max(500),
});

export const purchaseOrderUpdateSchema = z.object({
  id: uuid,
  // DB CHECK constraint: ('draft','submitted','partial','received','cancelled').
  // Keep this in sync with the DB constraint — 'ordered' was wrong and rejected by DB.
  status: z.enum(["draft", "submitted", "partial", "received", "cancelled"]).optional(),
  notes: optionalString,
  expected_at: isoDateTime.optional(),
  ordered_at: isoDateTime.optional(),
});

const receiveLineSchema = z.object({
  line_id: uuid,
  quantity_received: z.number().int().nonnegative(),
});

export const purchaseOrderReceiveSchema = z.object({
  id: uuid,
  // R18-LOW-3
  receives: z.array(receiveLineSchema).min(1).max(500),
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const expenseCreateSchema = z.object({
  // AUDIT9: mirror the expenses_category_check / _recurrence_period_check DB
  // CHECKs (migration 041) so an off-list value is a clean 400, not a 23514
  // 500. The admin UI's <select> already constrains to these.
  category: z.enum([
    "rent", "utilities", "payroll", "supplies", "marketing",
    "insurance", "maintenance", "shipping", "taxes", "other",
  ]),
  description: requiredString,
  amount: nonnegativeNumber,
  expense_date: optionalString,
  is_recurring: z.boolean().optional(),
  recurrence_period: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]).optional(),
  notes: optionalString,
});

export const expenseDeleteSchema = z.object({
  id: uuid,
});

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

// R38-A-F5: cap per-line receiving quantity at 10,000 units and
// batch size at 500 lines (already). Prior shape used `positiveInt`
// (max 1,000,000) × 500 lines = 500M units per POST — inventory_clerk
// with `inventory.adjust` could mint arbitrary stock in adhoc mode
// (no PO) with no step-up, no alert. Adhoc receiving is usually
// small corrections; real PO receives rarely exceed a few hundred
// units per line. Above-cap needs to be split into multiple batches
// so each one has its own audit row.
const receivingQuantity = z.number().int().positive().max(10_000);
const receivingItemSchema = z.object({
  product_variant_id: uuid,
  quantity: receivingQuantity,
  po_line_id: uuid.optional(),
});

export const receivingCreateSchema = z.object({
  type: z.literal("receive"),
  // R18-LOW-3
  items: z.array(receivingItemSchema).min(1).max(500),
  po_id: uuid.optional(),
  mode: optionalString,
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Section-specific schemas prevent arbitrary column injection via settings API.
// Every section is .strict() so unknown keys are rejected rather than silently
// dropped — the settings UPDATE builder then can't accidentally route an
// unexpected key through to a real column via the field map.
const customerDisplaySettingsSchema = z.object({
  displayName: z.string().max(200).optional(),
  welcomeText: z.string().max(120).optional(),
  idleMessage: z.string().max(160).optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}).strict();

const storeSettingsSchema = z.object({
  name: z.string().max(200).optional(),
  legalName: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(320).optional(),
  website: z.string().max(500).optional(),
  timezone: z.string().max(80).optional(),
  currencyCode: z.string().length(3).optional(),
}).strict();
const locationSettingsSchema = z.object({
  name: z.string().max(200).optional(),
  code: z.string().max(40).optional(),
  address1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  phone: z.string().max(40).optional(),
  taxRate: z.number().min(0).max(1).optional(),
  // R60-A1 (CRITICAL): the admin UI serializes the full
  // `StoreSettings['location']` shape on every save — including
  // `isActive` — so a `.strict()` schema without this field rejected
  // every Location Details save with "Unrecognized key: 'isActive'".
  // Accepting it here is safe because `buildDynamicUpdate` below
  // only writes keys that exist in the route-level fieldMap; if a
  // future PR wants to wire location activation it needs to thread
  // the column into that map explicitly.
  isActive: z.boolean().optional(),
}).strict();
const receiptSettingsSchema = z.object({
  header: z.string().max(2000).optional(),
  footer: z.string().max(2000).optional(),
  showLogo: z.boolean().optional(),
  storeName: z.string().max(200).optional(),
  storeAddress: z.string().max(200).optional(),
  storeCity: z.string().max(100).optional(),
  storeRegion: z.string().max(100).optional(),
  storePostalCode: z.string().max(20).optional(),
  storePhone: z.string().max(40).optional(),
}).strict();
export const settingsUpdateSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('store'), data: storeSettingsSchema }),
  z.object({ section: z.literal('location'), data: locationSettingsSchema }),
  z.object({ section: z.literal('receipt'), data: receiptSettingsSchema }),
  z.object({ section: z.literal('customerDisplay'), data: customerDisplaySettingsSchema }),
]);

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
  // R19-LOW-2: bound lines to prevent self-DoS via 10k-line payload.
  lines: z.array(transferLineSchema).max(500).optional(),
  id: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------

export const loyaltyAdjustSchema = z.object({
  customer_id: uuid,
  // Bound adjustment to ±1M points — catches malformed input without hurting real usage.
  adjustment: z.number().int().min(-1_000_000).max(1_000_000),
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
  amount: nonnegativeNumber,
  reason: optionalString,
  approvedBy: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Tax Config
// ---------------------------------------------------------------------------

export const taxConfigUpdateSchema = z.object({
  locationId: uuid,
  taxRate: z.number().min(0).max(1), // 0-100% (expressed as 0.00 to 1.00)
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
  approvedExceptions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Promo Codes
// ---------------------------------------------------------------------------

// Promo-code create/update payload. `free_item` is structurally different
// from `fixed` / `percent` / `bogo` because it gives away a specific
// variant rather than a cart-level discount — `freeVariantId` MUST be
// provided for `free_item` and MUST be omitted for the others. Enforced
// by the `.superRefine` below so the server rejects malformed payloads
// before hitting the DB CHECK constraint.
export const promoCodeSchema = z.object({
  code: requiredString,
  description: optionalString,
  type: z.enum(["fixed", "percent", "bogo", "free_item"]),
  // `value` is dollars off / percent off / ignored for bogo + free_item.
  // Keep nonnegativeNumber so callers can send 0 for the types that don't
  // use it; the per-type meaning is enforced by the refine below.
  value: nonnegativeNumber,
  minimumPurchase: nonnegativeNumber.optional(),
  maxRedemptions: z.number().int().positive().max(10_000_000).optional(),
  // R28-M6: per-customer cap. NULL/undefined = unlimited (back-compat).
  maxRedemptionsPerCustomer: z.number().int().positive().max(10_000).optional(),
  startsAt: isoDateTime.optional(),
  expiresAt: isoDateTime.optional(),
  freeVariantId: uuid.optional(),
  // Mirror every branch accepted by POST /api/promo-codes. `redeem` and
  // `disable` don't flow through `validateBody(promoCodeSchema, …)`
  // today, but shipping them in the enum keeps the schema as an
  // accurate contract for the route — prevents the "list says toggle
  // but server says disable" drift that confused last audit.
  action: z.enum(["create", "toggle", "redeem", "disable"]).optional(),
}).superRefine((data, ctx) => {
  if (data.type === "free_item") {
    if (!data.freeVariantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "freeVariantId is required for free_item promos",
        path: ["freeVariantId"],
      });
    }
  } else if (data.freeVariantId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "freeVariantId is only valid for free_item promos",
      path: ["freeVariantId"],
    });
  }
  if (data.type === "fixed" && data.value <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Fixed-discount promos must have value > 0",
      path: ["value"],
    });
  }
  if (data.type === "percent" && (data.value <= 0 || data.value > 100)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Percent-discount promos must have value in (0, 100]",
      path: ["value"],
    });
  }
  // An expires-at earlier than the starts-at produces a permanently
  // unusable promo (always "expired" or always "not yet active"). Reject
  // at create time rather than let admins ship broken promos.
  if (data.startsAt && data.expiresAt) {
    const starts = new Date(data.startsAt).getTime();
    const expires = new Date(data.expiresAt).getTime();
    if (Number.isFinite(starts) && Number.isFinite(expires) && expires <= starts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be after startsAt",
        path: ["expiresAt"],
      });
    }
  }
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
  restock: z.boolean().optional(),
});

export const returnCreateSchema = z.object({
  // transaction_id links the return to an originating sale. Without this,
  // an admin can mint arbitrary refunds for items never sold.
  transaction_id: uuid,
  customer_name: optionalString,
  reason: returnReasonEnum.optional(),
  notes: optionalString,
  refund_method: refundMethodEnum.optional(),
  // R18-LOW-3
  lines: z.array(returnLineSchema).min(1).max(500),
});

export const returnUpdateSchema = z.object({
  id: uuid,
  status: z.enum(["pending", "approved", "completed", "rejected", "cancelled"]),
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
  reason: returnReasonEnum.optional(),
  notes: optionalString,
  refund_method: refundMethodEnum.optional(),
  // R18-LOW-3
  items: z.array(returnProcessItemSchema).min(1).max(500),
  refund_amount: nonnegativeNumber,
});

// ---------------------------------------------------------------------------
// EOD Report
// ---------------------------------------------------------------------------

export const eodReportSchema = z.object({
  action: z.enum(["generate", "email", "print", "download"]).optional(),
});

// ---------------------------------------------------------------------------
// Customer Display
// ---------------------------------------------------------------------------

// customer-display state: bound the cart/totals shape so a malicious or
// buggy register client can't persist megabytes of JSON into the state
// row (which every GET-poll then serves back). Previously cart/totals
// were z.unknown() with no size guard; the jsonb column accepts up to
// 1 GB per row and polling happens every ~2s (R11-H-5).
const displayCartLine = z.object({
  productVariantId: uuid.optional(),
  bundleId: uuid.optional(),
  productName: z.string().max(500).optional(),
  variantName: z.string().max(500).optional(),
  sku: z.string().max(100).optional(),
  unitPrice: z.number().optional(),
  quantity: z.number().optional(),
  overridePrice: z.number().nullable().optional(),
  modifierTotal: z.number().optional(),
  promoCodeId: uuid.optional(),
}).strict();

const displayTotals = z.object({
  subtotal: z.number().optional(),
  discountTotal: z.number().optional(),
  taxTotal: z.number().optional(),
  grandTotal: z.number().optional(),
  modifiersTotal: z.number().optional(),
  itemCount: z.number().optional(),
}).strict();

export const customerDisplaySchema = z.object({
  registerSessionId: uuid,
  // R27-M11: .strict() rejects unknown fields. Previously .passthrough()
  // persisted arbitrary keys into the jsonb column, which then got
  // polled back to the display every ~2s. A future render change
  // that trusts an unknown key would be stored-XSS; .strict() makes
  // that class of bug unreachable.
  cart: z.object({
    id: z.string().max(100).optional(),
    items: z.array(displayCartLine).max(500),
    customerId: uuid.nullable().optional(),
    customerName: z.string().max(500).optional(),
  }).strict(),
  totals: displayTotals,
  // AUDIT9: mirror the customer_display_state.payment_status DB CHECK
  // (migration 035: pending/processing/complete/failed/cancelled). The prior
  // enum allowed idle/selecting/error — none valid at the DB, so any such
  // value would 23514 -> 500 instead of a clean 400. Migration 086 reconciles
  // prod's CHECK (which mig 085 re-created at the narrower 010 set) to match.
  paymentStatus: z.enum(["pending", "processing", "complete", "failed", "cancelled"]).optional(),
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
  roleKey: roleKeyEnum,
  pin: pinString,
  pinHint: pinHintField,
  // R18-LOW-3: no org has 100 simultaneous locations, let alone 1000s.
  locationIds: z.array(uuid).min(1).max(100),
});

export const employeeUpdateSchema = z.object({
  id: uuid,
  firstName: requiredString.optional(),
  lastName: requiredString.optional(),
  displayName: optionalString,
  email: optionalEmail,
  phone: optionalString,
  roleKey: roleKeyEnum.optional(),
  pin: pinString.optional(),
  pinHint: pinHintField,
  // R19-LOW-1: bound to 100 (no real org has >100 locations). R18-LOW-3
  // bounded the POST schema but this update schema was missed.
  locationIds: z.array(uuid).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const employeePatchSchema = z.object({
  id: uuid,
  // R28-H4: explicit `activate` vs `deactivate` actions.
  //
  // Prior shape: a single `deactivate` action that ran
  // `SET is_active = NOT is_active` — a TOGGLE. Semantically ambiguous
  // (the name lied for re-activation), and a stolen-cookie attacker
  // could deactivate every employee (store-wide DoS) or silently
  // re-activate previously-fired hostile employees. Making activate/
  // deactivate explicit lets the handler refuse no-op transitions
  // (activate-an-active, deactivate-an-inactive) and pin intent.
  action: z.enum(["activate", "deactivate", "reset_pin"]),
  pin: pinString.optional(),
  // R27-M7 + R28-H4: step-up auth. Required for ALL three actions now —
  // the prior exemption for `deactivate` let a session-theft attacker
  // silently DoS the store or re-hire fired employees.
  actorPassword: z.string().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Product Bundles
// ---------------------------------------------------------------------------

// Bundle items have a tighter quantity cap than the generic `positiveInt`
// (1_000_000) because migration 031's CHECK constraint enforces <= 1000.
// Without this, a client POST with quantity=1001 passes Zod but trips a
// CHECK violation returned as a generic "Failed to create bundle" 500.
const bundleItemQty = z.number().int().positive().max(1000);

// Bundle prices must be strictly positive. A $0 bundle is a distinct
// feature ("free with purchase") whose pricing and redemption semantics
// differ — it should be modeled separately rather than sharing the bundle
// codepath. See follow-up task in tracker.
const bundlePriceSchema = z.number().positive().max(MAX_MONEY);

const bundleItemInputSchema = z.object({
  productVariantId: uuid,
  quantity: bundleItemQty,
});

export const bundleCreateSchema = z.object({
  name: requiredString,
  slug: optionalString,
  description: optionalString,
  imageUrl: imageUrlField,
  bundlePrice: bundlePriceSchema,
  compareAtPrice: nonnegativeNumber.optional(),
  isActive: z.boolean().optional(),
  // Bundles need at least 2 items to be meaningful (a 1-item "bundle" is
  // just a variant with a discount — use a promo code for that instead).
  items: z.array(bundleItemInputSchema).min(2).max(50),
});

export const bundleUpdateSchema = z.object({
  id: uuid,
  name: requiredString.optional(),
  description: optionalString,
  imageUrl: imageUrlField,
  bundlePrice: bundlePriceSchema.optional(),
  compareAtPrice: nonnegativeNumber.optional(),
  isActive: z.boolean().optional(),
  // Optional full-replace of the component items. If present, the PATCH
  // handler deletes the existing bundle_items rows and inserts these new
  // ones in a single transaction.
  items: z.array(bundleItemInputSchema).min(2).max(50).optional(),
});

export const bundleDeleteSchema = z.object({
  id: uuid,
});

// ---------------------------------------------------------------------------
// Online Selling (Shopify channel integration)
// ---------------------------------------------------------------------------
export const shopifyConfigSchema = z.object({
  shop_domain: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, "shop_domain must be a <store>.myshopify.com domain")
    .max(200),
  fulfillment_location_id: uuid,
  // Sensitive — only sent when (re)setting; omitted means "keep the existing
  // encrypted value". The token is write-only and never returned by any API.
  access_token: z.string().min(1).max(2000).optional(),
  webhook_secret: z.string().min(1).max(2000).optional(),
  // Optional explicit Shopify location GID; otherwise resolved on test-connection.
  shopify_location_id: z.string().max(200).optional(),
  // Phase 2: whether to push BuPOS prices to Shopify (POS-authoritative).
  sync_prices: z.boolean().optional(),
  // Step-up password for writing/rotating the token (a powerful credential).
  actorPassword: z.string().max(200).optional(),
}).strict();

// P3.2: sales-digest configuration (organizations.digest_config). The
// lastDailySentOn / lastWeeklySentOn bookkeeping fields are server-managed
// and deliberately NOT accepted from the client (strict() rejects them).
export const digestConfigSchema = z.object({
  dailyEnabled: z.boolean(),
  weeklyEnabled: z.boolean(),
  recipients: z.array(z.string().trim().email().max(254)).max(5),
  sendHour: z.number().int().min(0).max(23),
}).strict();

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
