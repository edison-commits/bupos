import type {
  Category,
  Customer,
  Employee,
  EmployeeBehaviorFlag,
  GiftCard,
  GiftCardTransaction,
  InventoryLevel,
  Layaway,
  LayawayPayment,
  Location,
  Modifier,
  ModifierGroup,
  Organization,
  PayInOutRecord,
  Product,
  ProductBundle,
  ProductVariant,
  PromoCode,
  PromoRedemption,
  PurchaseOrder,
  RecountSchedule,
  Register,
  RegisterConfiguration,
  RegisterSessionRecord,
  RoleDefinition,
  ShiftRecord,
  Stocktake,
  StocktakeLine,
  StoreCreditEntry,
  Supplier,
  TimeClockEntry,
  TransactionEventPlaceholder,
  TransactionExceptionPlaceholder,
  TransactionTenderPlaceholder,
  Transfer,
  TransferLine,
} from "@/lib/domain/types";

export interface InventoryAdjustmentRecord {
  id: string;
  inventoryLevelId: string;
  productVariantId: string;
  locationId: string;
  employeeId: string;
  reason: string;
  delta: number;
  resultingOnHand: number;
  createdAt: string;
}

export interface AuthCredentialRecord {
  employeeId: string;
  email?: string;
  passwordHash?: string;
  pinHash?: string;
  passwordLastRotatedAt?: string;
  pinLastRotatedAt?: string;
}

export interface SessionRecord {
  id: string;
  employeeId: string;
  organizationId: string;
  scope: "admin" | "register";
  locationId?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface LocalStoreData {
  organization: Organization;
  locations: Location[];
  employees: Employee[];
  roles: RoleDefinition[];
  categories: Category[];
  modifierGroups: ModifierGroup[];
  modifiers: Modifier[];
  products: Product[];
  variants: ProductVariant[];
  inventory: InventoryLevel[];
  customers: Customer[];
  inventoryAdjustments: InventoryAdjustmentRecord[];
  registerConfiguration: RegisterConfiguration;
  shifts: ShiftRecord[];
  payInOuts: PayInOutRecord[];
  registerSessions: RegisterSessionRecord[];
  transactionTenderPlaceholders: TransactionTenderPlaceholder[];
  transactionEventPlaceholders: TransactionEventPlaceholder[];
  transactionExceptionPlaceholders: TransactionExceptionPlaceholder[];
  authCredentials: AuthCredentialRecord[];
  sessions: SessionRecord[];
  // Phase 2 entities
  giftCards: GiftCard[];
  giftCardTransactions: GiftCardTransaction[];
  storeCreditLedger: StoreCreditEntry[];
  behaviorFlags: EmployeeBehaviorFlag[];
  layaways: Layaway[];
  layawayPayments: LayawayPayment[];
  stocktakes: Stocktake[];
  stocktakeLines: StocktakeLine[];
  transfers: Transfer[];
  transferLines: TransferLine[];
  // Phase 3 entities
  timeClockEntries: TimeClockEntry[];
  promoCodes: PromoCode[];
  promoRedemptions: PromoRedemption[];
  // Product Bundles & Purchase Orders
  bundles?: ProductBundle[];
  suppliers?: Supplier[];
  purchaseOrders?: PurchaseOrder[];
  registers?: Register[];
  recountSchedules?: RecountSchedule[];
}

export interface CustomerDisplayBrandingData {
  storeName: string;
  locationName: string;
  displayName: string;
  welcomeText: string;
  idleMessage: string;
  accentColor: string;
}

export interface AdminSessionContext {
  session: SessionRecord;
  employee: Employee;
}

export interface RegisterSessionContext {
  session: SessionRecord;
  employee: Employee;
  location: Location;
  registerSession: RegisterSessionRecord;
  activeShift: ShiftRecord | null;
}
