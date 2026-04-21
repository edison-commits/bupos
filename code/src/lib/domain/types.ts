export type EntityId = string;

export type RoleKey =
  | "owner"
  | "manager"
  | "cashier"
  | "inventory_clerk"
  | "support";

export type PermissionKey =
  | "register.open"
  | "register.pin_login"
  | "catalog.manage"
  | "inventory.adjust"
  | "employee.manage"
  | "audit.view"
  | "reports.export"
  // Pricing primitives — bundle prices, compare-at prices, anything that
  // changes what a customer is CHARGED at the register. Kept separate from
  // `catalog.manage` so that inventory clerks (who need to edit SKUs and
  // product metadata) can't silently reprice a bundle from $99 → $0.01,
  // check it out, and raise the price back. Owner + manager only.
  | "pricing.manage"
  | "approval.discount"
  | "approval.void_item"
  | "approval.void_transaction"
  | "approval.store_credit"
  | "approval.price_override"
  // Cash-extraction approvals are distinct from void approvals: a manager
  // who signs off on voiding a $5 soda shouldn't also be authorizing a
  // $500 cash pay-out. Giving pay_out its own permission + exception code
  // prevents approval reuse across unrelated flows.
  | "approval.cash_payout";

export type TenderType = "cash" | "card" | "store_credit" | "loyalty" | "gift_card" | "split";

export type AuditEventKind =
  | "pin_login"
  | "catalog_update"
  | "inventory_adjustment"
  | "manager_override"
  | "shift_opened"
  | "shift_closed"
  | "pay_in"
  | "pay_out"
  | "register_session_started"
  | "register_session_ended"
  | "transaction_placeholder"
  | "layaway_created"
  | "item_added"
  | "item_removed"
  | "quantity_changed"
  | "discount_applied"
  | "cart_voided"
  | "cart_held"
  | "cart_recalled"
  | "payment_started";

export interface BaseRecord {
  id: EntityId;
  createdAt: string;
  updatedAt: string;
}

export interface Organization extends BaseRecord {
  name: string;
  slug: string;
  legalName: string;
  timezone: string;
  currencyCode: string;
  phone?: string;
  email?: string;
  website?: string;
  receiptHeader?: string;
  receiptFooter?: string;
}

export interface Location extends BaseRecord {
  organizationId: EntityId;
  name: string;
  code: string;
  address1: string;
  city: string;
  region: string;
  postalCode: string;
  phone?: string;
  taxRate: number;
  isActive: boolean;
}

export interface RoleDefinition {
  key: RoleKey;
  label: string;
  description: string;
  permissions: PermissionKey[];
}

export interface Employee extends BaseRecord {
  organizationId: EntityId;
  locationIds: EntityId[];
  roleKey: RoleKey;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  pinHint: string;
  isActive: boolean;
}

export interface Category extends BaseRecord {
  organizationId: EntityId;
  name: string;
  slug: string;
  parentCategoryId?: EntityId;
  sortOrder: number;
  imageUrl?: string;
}

export interface ModifierGroup extends BaseRecord {
  organizationId: EntityId;
  name: string;
  selectionMode: "single" | "multiple";
  minSelections: number;
  maxSelections: number;
}

export interface Modifier extends BaseRecord {
  organizationId: EntityId;
  modifierGroupId: EntityId;
  name: string;
  priceDelta: number;
  sortOrder: number;
}

export interface Product extends BaseRecord {
  organizationId: EntityId;
  categoryId: EntityId;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  isActive: boolean;
  isTouchFavorite: boolean;
  defaultVariantId?: EntityId;
  modifierGroupIds: EntityId[];
}

export interface ProductVariant extends BaseRecord {
  organizationId: EntityId;
  productId: EntityId;
  sku: string;
  barcode?: string;
  name: string;
  sizeLabel?: string;
  colorLabel?: string;
  price: number;
  compareAtPrice?: number;
  cost?: number;
  isActive: boolean;
}

export interface InventoryLevel extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  productVariantId: EntityId;
  onHand: number;
  reserved: number;
  reorderPoint: number;
}

export interface Customer extends BaseRecord {
  organizationId: EntityId;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  loyaltyPoints: number;
  totalSpend: number;
  visitCount: number;
  storeCreditBalance: number;
  notes?: string;
  taxExempt?: boolean;
  isActive: boolean;
}

// ── Phase 2: Gift Cards ──────────────────────────────────────────────

export type GiftCardStatus = "active" | "depleted" | "disabled" | "expired";
export type GiftCardTransactionType = "activation" | "reload" | "redemption" | "refund" | "adjustment" | "void";

export interface GiftCard extends BaseRecord {
  organizationId: EntityId;
  code: string;
  balance: number;
  initialBalance: number;
  status: GiftCardStatus;
  customerId?: EntityId;
  activatedBy?: EntityId;
  activatedAt: string;
  expiresAt?: string;
}

export interface GiftCardTransaction {
  id: EntityId;
  giftCardId: EntityId;
  transactionType: GiftCardTransactionType;
  amount: number;
  balanceAfter: number;
  employeeId?: EntityId;
  transactionId?: EntityId;
  reason?: string;
  createdAt: string;
}

// ── Phase 2: Store Credit Ledger ─────────────────────────────────────

export type StoreCreditTransactionType = "issuance" | "redemption" | "adjustment" | "refund" | "void";

export interface StoreCreditEntry {
  id: EntityId;
  organizationId: EntityId;
  customerId: EntityId;
  transactionType: StoreCreditTransactionType;
  amount: number;
  balanceAfter: number;
  employeeId?: EntityId;
  transactionId?: EntityId;
  reason?: string;
  approvedBy?: EntityId;
  createdAt: string;
}

// ── Phase 2: Employee Behavior Flags ─────────────────────────────────

export type BehaviorFlagSeverity = "low" | "medium" | "high";

export interface EmployeeBehaviorFlag {
  id: EntityId;
  organizationId: EntityId;
  employeeId: EntityId;
  locationId?: EntityId;
  flagType: string;
  severity: BehaviorFlagSeverity;
  title: string;
  description?: string;
  sourceRefType?: string;
  sourceRefId?: EntityId;
  details: Record<string, unknown>;
  isReviewed: boolean;
  reviewedBy?: EntityId;
  reviewedAt?: string;
  reviewNotes?: string;
  createdAt: string;
}

// ── Phase 2: Layaway ─────────────────────────────────────────────────

export type LayawayStatus =
  | "active"
  | "partially_paid"
  | "paid_in_full"
  | "collected"
  | "cancelled"
  | "forfeited";

export interface Layaway extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  customerId: EntityId;
  employeeId: EntityId;
  status: LayawayStatus;
  cartSnapshot: Record<string, unknown>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  depositPaid: number;
  balanceDue: number;
  minimumDeposit: number;
  dueDate?: string;
  notes?: string;
  completedTransactionId?: EntityId;
  cancelledBy?: EntityId;
  cancelledAt?: string;
  cancellationReason?: string;
}

export interface LayawayPayment {
  id: EntityId;
  layawayId: EntityId;
  tenderType: TenderType;
  amount: number;
  employeeId: EntityId;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Phase 2: Stocktakes ──────────────────────────────────────────────

export type StocktakeStatus = "in_progress" | "pending_review" | "accepted" | "cancelled";
export type StocktakeCountType = "full" | "cycle";

export interface Stocktake extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  initiatedBy: EntityId;
  status: StocktakeStatus;
  countType: StocktakeCountType;
  categoryFilter?: EntityId;
  notes?: string;
  acceptedBy?: EntityId;
  acceptedAt?: string;
}

export interface StocktakeLine {
  id: EntityId;
  stocktakeId: EntityId;
  productVariantId: EntityId;
  expectedQty: number;
  countedQty?: number;
  variance?: number;
  countedBy?: EntityId;
  countedAt?: string;
  createdAt: string;
}

// ── Phase 2: Inter-Store Transfers ───────────────────────────────────

export type TransferStatus = "requested" | "in_transit" | "received" | "cancelled";

export interface Transfer extends BaseRecord {
  organizationId: EntityId;
  sourceLocationId: EntityId;
  destinationLocationId: EntityId;
  status: TransferStatus;
  requestedBy: EntityId;
  shippedBy?: EntityId;
  shippedAt?: string;
  receivedBy?: EntityId;
  receivedAt?: string;
  cancelledBy?: EntityId;
  cancelledAt?: string;
  notes?: string;
}

export interface TransferLine {
  id: EntityId;
  transferId: EntityId;
  productVariantId: EntityId;
  quantityRequested: number;
  quantityShipped?: number;
  quantityReceived?: number;
  createdAt: string;
}

// ── Phase 3: Time Clock ─────────────────────────────────────────────

export type TimeClockEventType = "clock_in" | "clock_out" | "break_start" | "break_end";

export interface TimeClockEntry extends BaseRecord {
  organizationId: EntityId;
  employeeId: EntityId;
  locationId: EntityId;
  eventType: TimeClockEventType;
  note?: string;
}

export interface TimesheetSummary {
  employeeId: EntityId;
  employeeName: string;
  date: string;
  clockIn?: string;
  clockOut?: string;
  breaks: { start: string; end?: string }[];
  totalWorkedMs: number;
  totalBreakMs: number;
  status: "clocked_in" | "on_break" | "clocked_out";
}

// ── Phase 3: Promo Codes ────────────────────────────────────────────

export type PromoCodeType = "fixed" | "percent" | "bogo" | "free_item";
export type PromoCodeStatus = "active" | "expired" | "disabled" | "depleted";

export interface PromoCode extends BaseRecord {
  organizationId: EntityId;
  code: string;
  description?: string;
  type: PromoCodeType;
  value: number; // dollar off, percent off, 0 for BOGO, or 0 for free_item (variant's price is the "value")
  minimumPurchase: number;
  maxRedemptions: number;
  currentRedemptions: number;
  status: PromoCodeStatus;
  startsAt: string;
  expiresAt?: string;
  /**
   * Set iff `type === 'free_item'`. Points at the product_variants row
   * that gets added to the cart at $0 when this promo is redeemed. The
   * DB CHECK enforces consistency (see migration 033).
   */
  freeVariantId?: EntityId;
}

export interface PromoRedemption {
  id: EntityId;
  promoCodeId: EntityId;
  transactionId: EntityId;
  employeeId: EntityId;
  discountAmount: number;
  createdAt: string;
}

// ── Product Bundles ─────────────────────────────────────────────────

export interface ProductBundle extends BaseRecord {
  organizationId: EntityId;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  bundlePrice: number;
  compareAtPrice?: number;
  isActive: boolean;
  items: BundleItem[];
}

export interface BundleItem {
  id: EntityId;
  bundleId: EntityId;
  productVariantId: EntityId;
  quantity: number;
}

// ── Purchase Orders ─────────────────────────────────────────────────

export type PurchaseOrderStatus = "draft" | "submitted" | "partially_received" | "received" | "cancelled";

export interface Supplier extends BaseRecord {
  organizationId: EntityId;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  isActive: boolean;
}

export interface PurchaseOrder extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  supplierId: EntityId;
  employeeId: EntityId;
  status: PurchaseOrderStatus;
  orderNumber: string;
  notes?: string;
  expectedDate?: string;
  subtotal: number;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrderLine {
  id: EntityId;
  purchaseOrderId: EntityId;
  productVariantId: EntityId;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  createdAt: string;
}

export interface ApprovalThresholds {
  discountOver: number;
  itemVoidOver: number;
  transactionVoidOver: number;
  storeCreditIssuanceOver: number;
  manualPriceOverrideOver: number;
  returnWithoutManagerOver: number;
}

export interface LoyaltyConfig {
  /** Points earned per dollar spent (e.g. 1 = 1 point per $1) */
  earnRatePerDollar: number;
  /** Dollar value of each loyalty point when redeemed (e.g. 0.01 = 1 cent per point) */
  redemptionValuePerPoint: number;
  /** Minimum points required for redemption */
  minimumRedemption: number;
}

export interface RegisterConfiguration {
  locationId: EntityId;
  noReceiptEnabled: boolean;
  receiptMode: "browser-print" | "none";
  supportedTenders: TenderType[];
  approvalThresholds: ApprovalThresholds;
  loyalty: LoyaltyConfig;
}

export interface PayInOutRecord {
  id: EntityId;
  shiftId: EntityId;
  locationId: EntityId;
  employeeId: EntityId;
  direction: "pay_in" | "pay_out";
  amount: number;
  reason: string;
  note?: string;
  createdAt: string;
}

export interface ShiftRecord {
  id: EntityId;
  locationId: EntityId;
  employeeId: EntityId;
  registerSessionId: EntityId;
  status: "open" | "closed";
  openedAt: string;
  openingFloat: number;
  openedNote?: string;
  closedAt?: string;
  closingExpectedCash?: number;
  closingDeclaredCash?: number;
  closingVariance?: number;
  closedNote?: string;
  blindClose?: boolean;
}

// ── Multi-Register ─────────────────────────────────────────────────

export interface Register extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  name: string;
  code: string;
  isActive: boolean;
}

export interface RegisterSessionRecord {
  id: EntityId;
  authSessionId: EntityId;
  employeeId: EntityId;
  locationId: EntityId;
  registerId?: EntityId;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
  activeShiftId?: EntityId;
  lastCartId?: EntityId;
  lastTransactionId?: EntityId;
  pendingExceptionIds: EntityId[];
  deviceId?: string;
}

// ── Recount Schedule ──────────────────────────────────────────────

export type RecountFrequency = "weekly" | "biweekly" | "monthly";

export interface RecountSchedule extends BaseRecord {
  organizationId: EntityId;
  locationId: EntityId;
  categoryId?: EntityId;
  frequency: RecountFrequency;
  dayOfWeek: number; // 0=Sun, 1=Mon, ...
  lastRunAt?: string;
  nextRunAt: string;
  isActive: boolean;
}

export interface TransactionTenderPlaceholder {
  id: EntityId;
  transactionId: EntityId;
  tenderType: TenderType;
  amount: number;
  metadata?: Record<string, string>;
}

export interface TransactionEventPlaceholder {
  id: EntityId;
  transactionId: EntityId;
  eventKind: AuditEventKind;
  actorEmployeeId: EntityId;
  notes?: string;
  payload?: Record<string, string>;
  createdAt: string;
}

export interface TransactionExceptionPlaceholder {
  id: EntityId;
  transactionId: EntityId;
  exceptionCode:
    | "discount_threshold"
    | "item_void_threshold"
    | "transaction_void_threshold"
    | "store_credit_threshold"
    | "manual_price_override_threshold"
    | "return_threshold";
  requiresManagerApproval: boolean;
  resolvedAt?: string;
}
