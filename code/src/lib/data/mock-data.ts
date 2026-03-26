import { defaultApprovalThresholds } from "@/lib/config/thresholds";
import { roleDefinitions } from "@/lib/domain/permissions";
import type {
  Category,
  Employee,
  InventoryLevel,
  Location,
  Modifier,
  ModifierGroup,
  Organization,
  Product,
  ProductVariant,
  Register,
  RegisterConfiguration,
  TransactionEventPlaceholder,
  TransactionExceptionPlaceholder,
  TransactionTenderPlaceholder,
} from "@/lib/domain/types";

const now = "2026-03-22T00:00:00.000Z";

export const organization: Organization = {
  id: "org_casualwear",
  name: "Casualwear",
  slug: "casualwear",
  legalName: "Casualwear Retail LLC",
  timezone: "America/Los_Angeles",
  currencyCode: "USD",
  phone: "",
  email: "",
  website: "",
  receiptHeader: "",
  receiptFooter: "Thank you for shopping with us!",
  createdAt: now,
  updatedAt: now,
};

export const locations: Location[] = [
  {
    id: "loc_bellflower",
    organizationId: organization.id,
    name: "Bellflower",
    code: "BELL",
    address1: "16108 Lakewood Blvd",
    city: "Bellflower",
    region: "CA",
    postalCode: "90706",
    phone: "",
    taxRate: 0.1025,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
];

export const employees: Employee[] = [
  {
    id: "emp_owner_1",
    organizationId: organization.id,
    locationIds: [locations[0].id],
    roleKey: "owner",
    firstName: "Edison",
    lastName: "Owner",
    displayName: "Edison O.",
    email: "owner@basicuniformpos.local",
    pinHint: "4-digit owner PIN",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "emp_mgr_1",
    organizationId: organization.id,
    locationIds: [locations[0].id],
    roleKey: "manager",
    firstName: "Maya",
    lastName: "Manager",
    displayName: "Maya M.",
    email: "manager@basicuniformpos.local",
    pinHint: "4-digit manager PIN",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "emp_cash_1",
    organizationId: organization.id,
    locationIds: [locations[0].id],
    roleKey: "cashier",
    firstName: "Chris",
    lastName: "Cashier",
    displayName: "Chris C.",
    pinHint: "4-digit cashier PIN",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
];

export const categories: Category[] = [
  {
    id: "cat_denim",
    organizationId: organization.id,
    name: "Denim",
    slug: "denim",
    sortOrder: 1,
    imageUrl: "https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=800&q=80",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "cat_tops",
    organizationId: organization.id,
    name: "Tops",
    slug: "tops",
    sortOrder: 2,
    imageUrl: "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=800&q=80",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "cat_accessories",
    organizationId: organization.id,
    name: "Accessories",
    slug: "accessories",
    sortOrder: 3,
    imageUrl: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80",
    createdAt: now,
    updatedAt: now,
  },
];

export const modifierGroups: ModifierGroup[] = [
  {
    id: "mgift",
    organizationId: organization.id,
    name: "Gift Services",
    selectionMode: "multiple",
    minSelections: 0,
    maxSelections: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "mhem",
    organizationId: organization.id,
    name: "Alterations",
    selectionMode: "single",
    minSelections: 0,
    maxSelections: 1,
    createdAt: now,
    updatedAt: now,
  },
];

export const modifiers: Modifier[] = [
  {
    id: "mod_gift_wrap",
    organizationId: organization.id,
    modifierGroupId: "mgift",
    name: "Gift wrap",
    priceDelta: 4,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "mod_gift_bag",
    organizationId: organization.id,
    modifierGroupId: "mgift",
    name: "Gift bag",
    priceDelta: 2,
    sortOrder: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "mod_basic_hem",
    organizationId: organization.id,
    modifierGroupId: "mhem",
    name: "Basic hem",
    priceDelta: 8,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  },
];

export const products: Product[] = [
  {
    id: "prod_high_rise_jean",
    organizationId: organization.id,
    categoryId: "cat_denim",
    name: "High Rise Straight Jean",
    slug: "high-rise-straight-jean",
    description: "Touch-friendly featured denim style with image-forward browsing.",
    imageUrl: "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=1200&q=80",
    isActive: true,
    isTouchFavorite: true,
    defaultVariantId: "var_high_rise_28_blue",
    modifierGroupIds: ["mhem"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "prod_oversized_tee",
    organizationId: organization.id,
    categoryId: "cat_tops",
    name: "Oversized Essential Tee",
    slug: "oversized-essential-tee",
    description: "Fast-scan everyday tee with simple size variants.",
    imageUrl: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=1200&q=80",
    isActive: true,
    isTouchFavorite: true,
    defaultVariantId: "var_tee_m_black",
    modifierGroupIds: ["mgift"],
    createdAt: now,
    updatedAt: now,
  },
];

export const variants: ProductVariant[] = [
  {
    id: "var_high_rise_28_blue",
    organizationId: organization.id,
    productId: "prod_high_rise_jean",
    sku: "DEN-HR-28-BLU",
    barcode: "123456789028",
    name: "28 / Blue",
    sizeLabel: "28",
    colorLabel: "Blue",
    price: 54,
    cost: 24,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "var_high_rise_30_blue",
    organizationId: organization.id,
    productId: "prod_high_rise_jean",
    sku: "DEN-HR-30-BLU",
    barcode: "123456789030",
    name: "30 / Blue",
    sizeLabel: "30",
    colorLabel: "Blue",
    price: 54,
    cost: 24,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "var_tee_m_black",
    organizationId: organization.id,
    productId: "prod_oversized_tee",
    sku: "TOP-OS-M-BLK",
    barcode: "987654321100",
    name: "Medium / Black",
    sizeLabel: "M",
    colorLabel: "Black",
    price: 22,
    cost: 8,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "var_tee_l_white",
    organizationId: organization.id,
    productId: "prod_oversized_tee",
    sku: "TOP-OS-L-WHT",
    barcode: "987654321101",
    name: "Large / White",
    sizeLabel: "L",
    colorLabel: "White",
    price: 22,
    cost: 8,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
];

export const inventory: InventoryLevel[] = variants.map((variant, index) => ({
  id: `inv_${variant.id}`,
  organizationId: organization.id,
  locationId: locations[0].id,
  productVariantId: variant.id,
  onHand: 8 + index * 3,
  reserved: index === 0 ? 1 : 0,
  reorderPoint: 4,
  createdAt: now,
  updatedAt: now,
}));

export const registerConfiguration: RegisterConfiguration = {
  locationId: locations[0].id,
  noReceiptEnabled: true,
  receiptMode: "browser-print",
  supportedTenders: ["cash", "card", "store_credit", "loyalty", "gift_card", "split"],
  approvalThresholds: defaultApprovalThresholds,
  loyalty: {
    earnRatePerDollar: 1,
    redemptionValuePerPoint: 0.01,
    minimumRedemption: 100,
  },
};

export const transactionTenderPlaceholders: TransactionTenderPlaceholder[] = [
  {
    id: "tt_placeholder_cash_card",
    transactionId: "txn_placeholder_1",
    tenderType: "split",
    amount: 76,
    metadata: {
      note: "Reserved for Milestone 2 checkout composition.",
      expected_breakdown: "cash + card",
    },
  },
];

export const transactionEventPlaceholders: TransactionEventPlaceholder[] = [
  {
    id: "te_pin_login_1",
    transactionId: "txn_placeholder_1",
    eventKind: "pin_login",
    actorEmployeeId: employees[2].id,
    notes: "Illustrates cashier accountability before full checkout exists.",
    payload: {
      source: "register-login",
      location_id: locations[0].id,
    },
    createdAt: now,
  },
];

export const transactionExceptionPlaceholders: TransactionExceptionPlaceholder[] = [
  {
    id: "txe_discount_threshold_1",
    transactionId: "txn_placeholder_1",
    exceptionCode: "discount_threshold",
    requiresManagerApproval: true,
  },
];

const now2 = now;

export const registers: Register[] = [
  {
    id: "reg_1",
    organizationId: organization.id,
    locationId: locations[0].id,
    name: "Register 1",
    code: "REG1",
    isActive: true,
    createdAt: now2,
    updatedAt: now2,
  },
  {
    id: "reg_2",
    organizationId: organization.id,
    locationId: locations[0].id,
    name: "Register 2",
    code: "REG2",
    isActive: true,
    createdAt: now2,
    updatedAt: now2,
  },
];

export const seedBundle = {
  organization,
  locations,
  employees,
  roles: roleDefinitions,
  categories,
  modifierGroups,
  modifiers,
  products,
  variants,
  inventory,
  registerConfiguration,
  transactionTenderPlaceholders,
  transactionEventPlaceholders,
  transactionExceptionPlaceholders,
  bundles: [],
  suppliers: [],
  purchaseOrders: [],
  registers,
  recountSchedules: [],
};
