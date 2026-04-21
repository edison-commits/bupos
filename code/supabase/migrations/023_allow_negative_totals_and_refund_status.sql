-- Migration 023: Allow negative totals for returns; broaden status values
-- The nonneg CHECK blocked refund transactions (grand_total = -refundGrandTotal).
-- The status CHECK excluded 'refunded' and 'partial_refund' values used by reporting.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_grand_total_nonneg;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check
  CHECK (status = ANY (ARRAY['completed'::text, 'voided'::text, 'pending'::text, 'refunded'::text, 'partial_refund'::text]));
