import 'server-only';
import pool, { orgTx } from '@/lib/db';
import type {
  Customer,
  EmployeeBehaviorFlag,
  GiftCard,
  GiftCardTransaction,
  Layaway,
  LayawayPayment,
  Stocktake,
  StocktakeLine,
  StoreCreditEntry,
  Transfer,
  TransferLine,
} from '@/lib/domain/types';

// ── Row mappers ──────────────────────────────────────────────────────

function toCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    email: (r.email as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    loyaltyPoints: Number(r.loyalty_points),
    totalSpend: Number(r.total_spend),
    visitCount: Number(r.visit_count),
    storeCreditBalance: Number(r.store_credit_balance ?? 0),
    notes: (r.notes as string) ?? undefined,
    taxExempt: (r.tax_exempt as boolean) ?? false,
    isActive: r.is_active as boolean,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toGiftCard(r: Record<string, unknown>): GiftCard {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    code: r.code as string,
    balance: Number(r.balance),
    initialBalance: Number(r.initial_balance),
    status: r.status as GiftCard['status'],
    customerId: (r.customer_id as string) ?? undefined,
    activatedBy: (r.activated_by as string) ?? undefined,
    activatedAt: String(r.activated_at),
    expiresAt: r.expires_at ? String(r.expires_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toGiftCardTxn(r: Record<string, unknown>): GiftCardTransaction {
  return {
    id: r.id as string,
    giftCardId: r.gift_card_id as string,
    transactionType: r.transaction_type as GiftCardTransaction['transactionType'],
    amount: Number(r.amount),
    balanceAfter: Number(r.balance_after),
    employeeId: (r.employee_id as string) ?? undefined,
    transactionId: (r.transaction_id as string) ?? undefined,
    reason: (r.reason as string) ?? undefined,
    createdAt: String(r.created_at),
  };
}

function toStoreCreditEntry(r: Record<string, unknown>): StoreCreditEntry {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    customerId: r.customer_id as string,
    transactionType: r.transaction_type as StoreCreditEntry['transactionType'],
    amount: Number(r.amount),
    balanceAfter: Number(r.balance_after),
    employeeId: (r.employee_id as string) ?? undefined,
    transactionId: (r.transaction_id as string) ?? undefined,
    reason: (r.reason as string) ?? undefined,
    approvedBy: (r.approved_by as string) ?? undefined,
    createdAt: String(r.created_at),
  };
}

function toBehaviorFlag(r: Record<string, unknown>): EmployeeBehaviorFlag {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    employeeId: r.employee_id as string,
    locationId: (r.location_id as string) ?? undefined,
    flagType: r.flag_type as string,
    severity: r.severity as EmployeeBehaviorFlag['severity'],
    title: r.title as string,
    description: (r.description as string) ?? undefined,
    sourceRefType: (r.source_ref_type as string) ?? undefined,
    sourceRefId: (r.source_ref_id as string) ?? undefined,
    details: (r.details as Record<string, unknown>) ?? {},
    isReviewed: r.is_reviewed as boolean,
    reviewedBy: (r.reviewed_by as string) ?? undefined,
    reviewedAt: r.reviewed_at ? String(r.reviewed_at) : undefined,
    reviewNotes: (r.review_notes as string) ?? undefined,
    createdAt: String(r.created_at),
  };
}

function toLayaway(r: Record<string, unknown>): Layaway {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    locationId: r.location_id as string,
    customerId: r.customer_id as string,
    employeeId: r.employee_id as string,
    status: r.status as Layaway['status'],
    cartSnapshot: (r.cart_snapshot as Record<string, unknown>) ?? {},
    subtotal: Number(r.subtotal),
    discountTotal: Number(r.discount_total),
    taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total),
    depositPaid: Number(r.deposit_paid),
    balanceDue: Number(r.balance_due),
    minimumDeposit: Number(r.minimum_deposit),
    dueDate: r.due_date ? String(r.due_date) : undefined,
    notes: (r.notes as string) ?? undefined,
    completedTransactionId: (r.completed_transaction_id as string) ?? undefined,
    cancelledBy: (r.cancelled_by as string) ?? undefined,
    cancelledAt: r.cancelled_at ? String(r.cancelled_at) : undefined,
    cancellationReason: (r.cancellation_reason as string) ?? undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toLayawayPayment(r: Record<string, unknown>): LayawayPayment {
  return {
    id: r.id as string,
    layawayId: r.layaway_id as string,
    tenderType: r.tender_type as LayawayPayment['tenderType'],
    amount: Number(r.amount),
    employeeId: r.employee_id as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

function toStocktake(r: Record<string, unknown>): Stocktake {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    locationId: r.location_id as string,
    initiatedBy: r.initiated_by as string,
    status: r.status as Stocktake['status'],
    countType: r.count_type as Stocktake['countType'],
    categoryFilter: (r.category_filter as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    acceptedBy: (r.accepted_by as string) ?? undefined,
    acceptedAt: r.accepted_at ? String(r.accepted_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toStocktakeLine(r: Record<string, unknown>): StocktakeLine {
  return {
    id: r.id as string,
    stocktakeId: r.stocktake_id as string,
    productVariantId: r.product_variant_id as string,
    expectedQty: Number(r.expected_qty),
    countedQty: r.counted_qty != null ? Number(r.counted_qty) : undefined,
    variance: r.variance != null ? Number(r.variance) : undefined,
    countedBy: (r.counted_by as string) ?? undefined,
    countedAt: r.counted_at ? String(r.counted_at) : undefined,
    createdAt: String(r.created_at),
  };
}

function toTransfer(r: Record<string, unknown>): Transfer {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    sourceLocationId: r.source_location_id as string,
    destinationLocationId: r.destination_location_id as string,
    status: r.status as Transfer['status'],
    requestedBy: r.requested_by as string,
    shippedBy: (r.shipped_by as string) ?? undefined,
    shippedAt: r.shipped_at ? String(r.shipped_at) : undefined,
    receivedBy: (r.received_by as string) ?? undefined,
    receivedAt: r.received_at ? String(r.received_at) : undefined,
    cancelledBy: (r.cancelled_by as string) ?? undefined,
    cancelledAt: r.cancelled_at ? String(r.cancelled_at) : undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toTransferLine(r: Record<string, unknown>): TransferLine {
  return {
    id: r.id as string,
    transferId: r.transfer_id as string,
    productVariantId: r.product_variant_id as string,
    quantityRequested: Number(r.quantity_requested),
    quantityShipped: r.quantity_shipped != null ? Number(r.quantity_shipped) : undefined,
    quantityReceived: r.quantity_received != null ? Number(r.quantity_received) : undefined,
    createdAt: String(r.created_at),
  };
}

// ── Customers ────────────────────────────────────────────────────────

export async function pgReadCustomers(orgId: string): Promise<Customer[]> {
  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE organization_id = $1 ORDER BY last_name, first_name',
    [orgId],
  );
  return rows.map(toCustomer);
}

export async function pgReadCustomerById(id: string): Promise<Customer | null> {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  return rows[0] ? toCustomer(rows[0]) : null;
}

export async function pgCreateCustomer(data: {
  id: string; organizationId: string; firstName: string; lastName: string;
  email?: string; phone?: string; notes?: string;
}): Promise<Customer> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [data.id, data.organizationId, data.firstName, data.lastName, data.email ?? null, data.phone ?? null, data.notes ?? null, ts],
  );
  return toCustomer(rows[0]);
}

export async function pgUpdateCustomerLoyalty(customerId: string, pointsDelta: number, spendDelta: number): Promise<void> {
  const ts = new Date().toISOString();
  await pool.query(
    `UPDATE customers SET loyalty_points = GREATEST(0, loyalty_points + $1),
     total_spend = total_spend + $2, visit_count = visit_count + 1, updated_at = $3
     WHERE id = $4`,
    [pointsDelta, spendDelta, ts, customerId],
  );
}

export async function pgUpdateCustomerStoreCredit(customerId: string, newBalance: number): Promise<void> {
  const ts = new Date().toISOString();
  await pool.query(
    'UPDATE customers SET store_credit_balance = $1, updated_at = $2 WHERE id = $3',
    [newBalance, ts, customerId],
  );
}

// ── Gift Cards ───────────────────────────────────────────────────────

export async function pgReadGiftCards(orgId: string): Promise<GiftCard[]> {
  const { rows } = await pool.query(
    'SELECT * FROM gift_cards WHERE organization_id = $1 ORDER BY created_at DESC',
    [orgId],
  );
  return rows.map(toGiftCard);
}

export async function pgFindGiftCardByCode(orgId: string, code: string): Promise<GiftCard | null> {
  const { rows } = await pool.query(
    'SELECT * FROM gift_cards WHERE organization_id = $1 AND code = $2',
    [orgId, code],
  );
  return rows[0] ? toGiftCard(rows[0]) : null;
}

export async function pgCreateGiftCard(data: {
  id: string; organizationId: string; code: string; initialBalance: number;
  customerId?: string; activatedBy: string;
}): Promise<GiftCard> {
  const ts = new Date().toISOString();
  const client = await orgTx(data.organizationId);
  try {
    const { rows } = await client.query(
      `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, customer_id, activated_by, activated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, $7, $7, $7) RETURNING *`,
      [data.id, data.organizationId, data.code, data.initialBalance, data.customerId ?? null, data.activatedBy, ts],
    );
    // Record activation transaction
    await client.query(
      `INSERT INTO gift_card_transactions (gift_card_id, transaction_type, amount, balance_after, employee_id, created_at)
       VALUES ($1, 'activation', $2, $2, $3, $4)`,
      [data.id, data.initialBalance, data.activatedBy, ts],
    );
    await client.query('COMMIT');
    return toGiftCard(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgRedeemGiftCard(giftCardId: string, amount: number, employeeId: string, transactionId?: string): Promise<GiftCard> {
  // Get organizationId from gift card
  const { rows: cardRows } = await pool.query(
    'SELECT organization_id FROM gift_cards WHERE id = $1',
    [giftCardId],
  );
  if (!cardRows[0]) throw new Error('Gift card not found');
  const organizationId = cardRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows } = await client.query(
      `UPDATE gift_cards SET balance = balance - $1, updated_at = $2,
       status = CASE WHEN balance - $1 <= 0 THEN 'depleted' ELSE status END
       WHERE id = $3 AND balance >= $1 AND status = 'active' RETURNING *`,
      [amount, ts, giftCardId],
    );
    if (!rows[0]) throw new Error('Insufficient gift card balance or card not active');
    const card = toGiftCard(rows[0]);
    await client.query(
      `INSERT INTO gift_card_transactions (gift_card_id, transaction_type, amount, balance_after, employee_id, transaction_id, created_at)
       VALUES ($1, 'redemption', $2, $3, $4, $5, $6)`,
      [giftCardId, -amount, card.balance, employeeId, transactionId ?? null, ts],
    );
    await client.query('COMMIT');
    return card;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReloadGiftCard(giftCardId: string, amount: number, employeeId: string): Promise<GiftCard> {
  // Get organizationId from gift card
  const { rows: cardRows } = await pool.query(
    'SELECT organization_id FROM gift_cards WHERE id = $1',
    [giftCardId],
  );
  if (!cardRows[0]) throw new Error('Gift card not found');
  const organizationId = cardRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows } = await client.query(
      `UPDATE gift_cards SET balance = balance + $1, updated_at = $2,
       status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
       WHERE id = $3 RETURNING *`,
      [amount, ts, giftCardId],
    );
    if (!rows[0]) throw new Error('Gift card not found');
    const card = toGiftCard(rows[0]);
    await client.query(
      `INSERT INTO gift_card_transactions (gift_card_id, transaction_type, amount, balance_after, employee_id, created_at)
       VALUES ($1, 'reload', $2, $3, $4, $5)`,
      [giftCardId, amount, card.balance, employeeId, ts],
    );
    await client.query('COMMIT');
    return card;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadGiftCardTransactions(giftCardId: string): Promise<GiftCardTransaction[]> {
  const { rows } = await pool.query(
    'SELECT * FROM gift_card_transactions WHERE gift_card_id = $1 ORDER BY created_at DESC',
    [giftCardId],
  );
  return rows.map(toGiftCardTxn);
}

// ── Store Credit Ledger ──────────────────────────────────────────────

export async function pgIssueStoreCredit(data: {
  organizationId: string; customerId: string; amount: number;
  employeeId: string; reason?: string; approvedBy?: string; transactionId?: string;
}): Promise<StoreCreditEntry> {
  const client = await orgTx(data.organizationId);
  try {
    const ts = new Date().toISOString();
    // Update customer balance
    const { rows: custRows } = await client.query(
      'UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = $2 WHERE id = $3 RETURNING store_credit_balance',
      [data.amount, ts, data.customerId],
    );
    if (!custRows[0]) throw new Error('Customer not found');
    const balanceAfter = Number(custRows[0].store_credit_balance);
    const { rows } = await client.query(
      `INSERT INTO store_credit_ledger (organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, approved_by, created_at)
       VALUES ($1, $2, 'issuance', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [data.organizationId, data.customerId, data.amount, balanceAfter, data.employeeId, data.transactionId ?? null, data.reason ?? null, data.approvedBy ?? null, ts],
    );
    await client.query('COMMIT');
    return toStoreCreditEntry(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgRedeemStoreCredit(data: {
  organizationId: string; customerId: string; amount: number;
  employeeId: string; transactionId?: string;
}): Promise<StoreCreditEntry> {
  const client = await orgTx(data.organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows: custRows } = await client.query(
      'UPDATE customers SET store_credit_balance = store_credit_balance - $1, updated_at = $2 WHERE id = $3 AND store_credit_balance >= $1 RETURNING store_credit_balance',
      [data.amount, ts, data.customerId],
    );
    if (!custRows[0]) throw new Error('Insufficient store credit balance');
    const balanceAfter = Number(custRows[0].store_credit_balance);
    const { rows } = await client.query(
      `INSERT INTO store_credit_ledger (organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, created_at)
       VALUES ($1, $2, 'redemption', $3, $4, $5, $6, $7) RETURNING *`,
      [data.organizationId, data.customerId, -data.amount, balanceAfter, data.employeeId, data.transactionId ?? null, ts],
    );
    await client.query('COMMIT');
    return toStoreCreditEntry(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadStoreCreditLedger(customerId: string): Promise<StoreCreditEntry[]> {
  const { rows } = await pool.query(
    'SELECT * FROM store_credit_ledger WHERE customer_id = $1 ORDER BY created_at DESC',
    [customerId],
  );
  return rows.map(toStoreCreditEntry);
}

// ── Employee Behavior Flags ──────────────────────────────────────────

export async function pgCreateBehaviorFlag(data: {
  organizationId: string; employeeId: string; locationId?: string;
  flagType: string; severity: string; title: string; description?: string;
  sourceRefType?: string; sourceRefId?: string;
  details?: Record<string, unknown>;
}): Promise<EmployeeBehaviorFlag> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO behavior_flags (organization_id, employee_id, location_id, flag_type, severity, title, description, source_ref_type, source_ref_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [data.organizationId, data.employeeId, data.locationId ?? null, data.flagType, data.severity, data.title, data.description ?? null, data.sourceRefType ?? null, data.sourceRefId ?? null, JSON.stringify(data.details ?? {}), ts],
  );
  return toBehaviorFlag(rows[0]);
}

export async function pgReadBehaviorFlags(orgId: string, filters?: {
  employeeId?: string; locationId?: string; severity?: string; isReviewed?: boolean;
}): Promise<EmployeeBehaviorFlag[]> {
  const conditions = ['organization_id = $1'];
  const vals: unknown[] = [orgId];
  let i = 2;
  if (filters?.employeeId) { conditions.push(`employee_id = $${i++}`); vals.push(filters.employeeId); }
  if (filters?.locationId) { conditions.push(`location_id = $${i++}`); vals.push(filters.locationId); }
  if (filters?.severity) { conditions.push(`severity = $${i++}`); vals.push(filters.severity); }
  if (filters?.isReviewed !== undefined) { conditions.push(`is_reviewed = $${i++}`); vals.push(filters.isReviewed); }
  const { rows } = await pool.query(
    `SELECT * FROM behavior_flags WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    vals,
  );
  return rows.map(toBehaviorFlag);
}

export async function pgReviewBehaviorFlag(flagId: string, reviewedBy: string, reviewNotes?: string): Promise<EmployeeBehaviorFlag | null> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE behavior_flags SET is_reviewed = true, reviewed_by = $1, reviewed_at = $2, review_notes = $3 WHERE id = $4 RETURNING *`,
    [reviewedBy, ts, reviewNotes ?? null, flagId],
  );
  return rows[0] ? toBehaviorFlag(rows[0]) : null;
}

// ── Layaways ─────────────────────────────────────────────────────────

export async function pgCreateLayaway(data: {
  id: string; organizationId: string; locationId: string; customerId: string;
  employeeId: string; cartSnapshot: Record<string, unknown>; subtotal: number;
  discountTotal: number; taxTotal: number; grandTotal: number;
  minimumDeposit: number; dueDate?: string;
}): Promise<Layaway> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO layaways (id, organization_id, location_id, customer_id, employee_id, status, cart_snapshot,
     subtotal, discount_total, tax_total, grand_total, deposit_paid, balance_due, minimum_deposit, due_date, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, 0, $10, $11, $12, $13, $13) RETURNING *`,
    [data.id, data.organizationId, data.locationId, data.customerId, data.employeeId, JSON.stringify(data.cartSnapshot),
     data.subtotal, data.discountTotal, data.taxTotal, data.grandTotal, data.minimumDeposit, data.dueDate ?? null, ts],
  );
  return toLayaway(rows[0]);
}

export async function pgMakeLayawayPayment(data: {
  layawayId: string; tenderType: string; amount: number; employeeId: string;
  metadata?: Record<string, unknown>;
}): Promise<{ layaway: Layaway; payment: LayawayPayment }> {
  // Get organizationId from layaway
  const { rows: layRows } = await pool.query(
    'SELECT organization_id FROM layaways WHERE id = $1',
    [data.layawayId],
  );
  if (!layRows[0]) throw new Error('Layaway not found');
  const organizationId = layRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    // Insert payment
    const { rows: payRows } = await client.query(
      `INSERT INTO layaway_payments (layaway_id, tender_type, amount, employee_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [data.layawayId, data.tenderType, data.amount, data.employeeId, JSON.stringify(data.metadata ?? {}), ts],
    );
    // Update layaway balance
    const { rows: updatedLayRows } = await client.query(
      `UPDATE layaways SET deposit_paid = deposit_paid + $1, balance_due = balance_due - $1,
       status = CASE WHEN balance_due - $1 <= 0 THEN 'paid_in_full' ELSE 'partially_paid' END,
       updated_at = $2 WHERE id = $3 RETURNING *`,
      [data.amount, ts, data.layawayId],
    );
    if (!updatedLayRows[0]) throw new Error('Layaway not found');
    await client.query('COMMIT');
    return { layaway: toLayaway(updatedLayRows[0]), payment: toLayawayPayment(payRows[0]) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadLayaways(orgId: string, filters?: {
  locationId?: string; customerId?: string; status?: string;
}): Promise<Layaway[]> {
  const conditions = ['organization_id = $1'];
  const vals: unknown[] = [orgId];
  let i = 2;
  if (filters?.locationId) { conditions.push(`location_id = $${i++}`); vals.push(filters.locationId); }
  if (filters?.customerId) { conditions.push(`customer_id = $${i++}`); vals.push(filters.customerId); }
  if (filters?.status) { conditions.push(`status = $${i++}`); vals.push(filters.status); }
  const { rows } = await pool.query(
    `SELECT * FROM layaways WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    vals,
  );
  return rows.map(toLayaway);
}

export async function pgReadLayawayPayments(layawayId: string): Promise<LayawayPayment[]> {
  const { rows } = await pool.query(
    'SELECT * FROM layaway_payments WHERE layaway_id = $1 ORDER BY created_at',
    [layawayId],
  );
  return rows.map(toLayawayPayment);
}

export async function pgCancelLayaway(layawayId: string, cancelledBy: string, reason?: string): Promise<Layaway | null> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE layaways SET status = 'cancelled', cancelled_by = $1, cancelled_at = $2,
     cancellation_reason = $3, updated_at = $2 WHERE id = $4 AND status IN ('active', 'partially_paid') RETURNING *`,
    [cancelledBy, ts, reason ?? null, layawayId],
  );
  return rows[0] ? toLayaway(rows[0]) : null;
}

// ── Stocktakes ───────────────────────────────────────────────────────

export async function pgCreateStocktake(data: {
  id: string; organizationId: string; locationId: string; initiatedBy: string;
  countType: string; categoryFilter?: string; notes?: string;
}): Promise<Stocktake> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO stocktakes (id, organization_id, location_id, initiated_by, status, count_type, category_filter, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, $8, $8) RETURNING *`,
    [data.id, data.organizationId, data.locationId, data.initiatedBy, data.countType, data.categoryFilter ?? null, data.notes ?? null, ts],
  );
  return toStocktake(rows[0]);
}

export async function pgAddStocktakeLines(stocktakeId: string, lines: { productVariantId: string; expectedQty: number }[]): Promise<StocktakeLine[]> {
  const ts = new Date().toISOString();
  const results: StocktakeLine[] = [];
  for (const line of lines) {
    const { rows } = await pool.query(
      `INSERT INTO stocktake_lines (stocktake_id, product_variant_id, expected_qty, created_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [stocktakeId, line.productVariantId, line.expectedQty, ts],
    );
    results.push(toStocktakeLine(rows[0]));
  }
  return results;
}

export async function pgRecordStocktakeCount(lineId: string, countedQty: number, countedBy: string): Promise<StocktakeLine | null> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE stocktake_lines SET counted_qty = $1, counted_by = $2, counted_at = $3 WHERE id = $4 RETURNING *`,
    [countedQty, countedBy, ts, lineId],
  );
  return rows[0] ? toStocktakeLine(rows[0]) : null;
}

export async function pgAcceptStocktake(stocktakeId: string, acceptedBy: string): Promise<Stocktake | null> {
  // Get organizationId from stocktake
  const { rows: stockRows } = await pool.query(
    'SELECT organization_id FROM stocktakes WHERE id = $1',
    [stocktakeId],
  );
  if (!stockRows[0]) return null;
  const organizationId = stockRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows } = await client.query(
      `UPDATE stocktakes SET status = 'accepted', accepted_by = $1, accepted_at = $2, updated_at = $2
       WHERE id = $3 AND status IN ('in_progress', 'pending_review') RETURNING *`,
      [acceptedBy, ts, stocktakeId],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    // Apply inventory adjustments from accepted counts
    const { rows: lines } = await client.query(
      'SELECT * FROM stocktake_lines WHERE stocktake_id = $1 AND counted_qty IS NOT NULL',
      [stocktakeId],
    );
    const stocktake = toStocktake(rows[0]);
    for (const line of lines) {
      const variance = Number(line.counted_qty) - Number(line.expected_qty);
      if (variance !== 0) {
        await client.query(
          `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand + $1), updated_at = $2
           WHERE product_variant_id = $3 AND location_id = $4`,
          [variance, ts, line.product_variant_id, stocktake.locationId],
        );
        await client.query(
          `INSERT INTO inventory_adjustments (organization_id, location_id, product_variant_id, employee_id, quantity_delta, reason_code, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [stocktake.organizationId, stocktake.locationId, line.product_variant_id, acceptedBy, variance, 'stocktake_adjustment', ts],
        );
      }
    }
    await client.query('COMMIT');
    return stocktake;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadStocktakes(orgId: string, locationId?: string): Promise<Stocktake[]> {
  const conditions = ['organization_id = $1'];
  const vals: unknown[] = [orgId];
  if (locationId) { conditions.push('location_id = $2'); vals.push(locationId); }
  const { rows } = await pool.query(
    `SELECT * FROM stocktakes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    vals,
  );
  return rows.map(toStocktake);
}

export async function pgReadStocktakeLines(stocktakeId: string): Promise<StocktakeLine[]> {
  const { rows } = await pool.query(
    'SELECT * FROM stocktake_lines WHERE stocktake_id = $1 ORDER BY created_at',
    [stocktakeId],
  );
  return rows.map(toStocktakeLine);
}

// ── Inter-Store Transfers ────────────────────────────────────────────

export async function pgCreateTransfer(data: {
  id: string; organizationId: string; sourceLocationId: string;
  destinationLocationId: string; requestedBy: string; notes?: string;
  lines: { productVariantId: string; quantityRequested: number }[];
}): Promise<{ transfer: Transfer; lines: TransferLine[] }> {
  const client = await orgTx(data.organizationId);
  try {
    const ts = new Date().toISOString();
    const { rows: tRows } = await client.query(
      `INSERT INTO transfers (id, organization_id, source_location_id, destination_location_id, status, requested_by, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $7) RETURNING *`,
      [data.id, data.organizationId, data.sourceLocationId, data.destinationLocationId, data.requestedBy, data.notes ?? null, ts],
    );
    const lineResults: TransferLine[] = [];
    for (const line of data.lines) {
      const { rows: lRows } = await client.query(
        `INSERT INTO transfer_lines (transfer_id, product_variant_id, quantity_requested, created_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [data.id, line.productVariantId, line.quantityRequested, ts],
      );
      lineResults.push(toTransferLine(lRows[0]));
    }
    await client.query('COMMIT');
    return { transfer: toTransfer(tRows[0]), lines: lineResults };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgShipTransfer(transferId: string, shippedBy: string, shipments: { lineId: string; quantityShipped: number }[]): Promise<Transfer> {
  // Get organizationId from transfer
  const { rows: transRows } = await pool.query(
    'SELECT organization_id FROM transfers WHERE id = $1',
    [transferId],
  );
  if (!transRows[0]) throw new Error('Transfer not found');
  const organizationId = transRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    // Update each line with shipped quantity
    for (const s of shipments) {
      await client.query(
        'UPDATE transfer_lines SET quantity_shipped = $1 WHERE id = $2',
        [s.quantityShipped, s.lineId],
      );
    }
    // Deduct inventory from source location
    const { rows: lines } = await client.query(
      'SELECT tl.*, t.source_location_id FROM transfer_lines tl JOIN transfers t ON tl.transfer_id = t.id WHERE tl.transfer_id = $1',
      [transferId],
    );
    for (const line of lines) {
      const qty = Number(line.quantity_shipped ?? line.quantity_requested);
      await client.query(
        `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand - $1), updated_at = $2
         WHERE product_variant_id = $3 AND location_id = $4`,
        [qty, ts, line.product_variant_id, line.source_location_id],
      );
    }
    // Update transfer status
    const { rows: tRows } = await client.query(
      `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = $2, updated_at = $2
       WHERE id = $3 AND status = 'requested' RETURNING *`,
      [shippedBy, ts, transferId],
    );
    if (!tRows[0]) throw new Error('Transfer not found or not in requested status');
    await client.query('COMMIT');
    return toTransfer(tRows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReceiveTransfer(transferId: string, receivedBy: string, receipts: { lineId: string; quantityReceived: number }[]): Promise<Transfer> {
  // Get organizationId from transfer
  const { rows: transRows } = await pool.query(
    'SELECT organization_id FROM transfers WHERE id = $1',
    [transferId],
  );
  if (!transRows[0]) throw new Error('Transfer not found');
  const organizationId = transRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();
    // Update each line with received quantity
    for (const r of receipts) {
      await client.query(
        'UPDATE transfer_lines SET quantity_received = $1 WHERE id = $2',
        [r.quantityReceived, r.lineId],
      );
    }
    // Add inventory to destination location
    const { rows: lines } = await client.query(
      'SELECT tl.*, t.destination_location_id FROM transfer_lines tl JOIN transfers t ON tl.transfer_id = t.id WHERE tl.transfer_id = $1',
      [transferId],
    );
    for (const line of lines) {
      const receipt = receipts.find(r => r.lineId === line.id);
      const qty = receipt ? receipt.quantityReceived : Number(line.quantity_shipped ?? line.quantity_requested);
      await client.query(
        `UPDATE inventory_levels SET on_hand = on_hand + $1, updated_at = $2
         WHERE product_variant_id = $3 AND location_id = $4`,
        [qty, ts, line.product_variant_id, line.destination_location_id],
      );
    }
    // Update transfer status
    const { rows: tRows } = await client.query(
      `UPDATE transfers SET status = 'received', received_by = $1, received_at = $2, updated_at = $2
       WHERE id = $3 AND status = 'in_transit' RETURNING *`,
      [receivedBy, ts, transferId],
    );
    if (!tRows[0]) throw new Error('Transfer not found or not in transit');
    await client.query('COMMIT');
    return toTransfer(tRows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgReadTransfers(orgId: string, filters?: { status?: string }): Promise<Transfer[]> {
  const conditions = ['organization_id = $1'];
  const vals: unknown[] = [orgId];
  if (filters?.status) { conditions.push('status = $2'); vals.push(filters.status); }
  const { rows } = await pool.query(
    `SELECT * FROM transfers WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    vals,
  );
  return rows.map(toTransfer);
}

export async function pgReadTransferLines(transferId: string): Promise<TransferLine[]> {
  const { rows } = await pool.query(
    'SELECT * FROM transfer_lines WHERE transfer_id = $1 ORDER BY created_at',
    [transferId],
  );
  return rows.map(toTransferLine);
}

// ── Pay In/Out ───────────────────────────────────────────────────────

export async function pgCreatePayInOut(data: {
  id: string; organizationId: string; shiftId: string; locationId: string;
  employeeId: string; direction: string; amount: number; reason: string; note?: string;
}): Promise<void> {
  const ts = new Date().toISOString();
  await pool.query(
    `INSERT INTO pay_in_outs (id, organization_id, shift_id, location_id, employee_id, direction, amount, reason, note, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [data.id, data.organizationId, data.shiftId, data.locationId, data.employeeId, data.direction, data.amount, data.reason, data.note ?? null, ts],
  );
}

export async function pgReadPayInOuts(shiftId: string): Promise<{ id: string; direction: string; amount: number; reason: string; note?: string; createdAt: string }[]> {
  const { rows } = await pool.query(
    'SELECT * FROM pay_in_outs WHERE shift_id = $1 ORDER BY created_at',
    [shiftId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    direction: r.direction as string,
    amount: Number(r.amount),
    reason: r.reason as string,
    note: (r.note as string) ?? undefined,
    createdAt: String(r.created_at),
  }));
}
