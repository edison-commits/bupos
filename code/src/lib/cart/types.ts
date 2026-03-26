import type { EntityId, TenderType } from '@/lib/domain/types';

export type DiscountMode = "fixed" | "percent";

export interface LineDiscount {
  mode: DiscountMode;
  value: number; // dollar amount or percentage (0–100)
  reason?: string;
}

export interface CartLineItem {
  id: string;
  productVariantId: EntityId;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  overridePrice?: number;
  quantity: number;
  modifierIds: EntityId[];
  modifierTotal: number;
  lineDiscount?: LineDiscount;
}

export interface CartTotals {
  subtotal: number;
  modifiersTotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  itemCount: number;
}

export interface Cart {
  id: string;
  registerSessionId: EntityId;
  employeeId: EntityId;
  locationId: EntityId;
  customerId?: EntityId;
  customerName?: string;
  items: CartLineItem[];
  discountAmount: number;
  discountMode: DiscountMode;
  taxRate: number;
  status: 'open' | 'checked_out' | 'voided';
  createdAt: string;
  updatedAt: string;
}

export interface TenderLine {
  type: TenderType;
  amount: number;
  metadata?: Record<string, string>;
}

export interface CheckoutRequest {
  cartId: string;
  tenders: TenderLine[];
}

export interface CheckoutResult {
  transactionId: string;
  cartId: string;
  grandTotal: number;
  tenders: TenderLine[];
  changeDue: number;
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
}
