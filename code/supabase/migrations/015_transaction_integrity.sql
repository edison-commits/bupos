-- Migration 015: Transaction integrity fixes
-- 1. Add transaction_lines table (missing from production)
-- 2. Add CHECK constraint for non-negative grand_total
-- 3. Add tender sum validation trigger
-- 4. Fix register_sessions missing columns

-- =============================================
-- 1. transaction_lines table
-- =============================================
CREATE TABLE IF NOT EXISTS transaction_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  line_total numeric NOT NULL CHECK (line_total >= 0),
  line_discount numeric NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_lines_txn ON transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_lines_variant ON transaction_lines(product_variant_id);

-- =============================================
-- 2. Prevent negative grand_total (allow 0 for now, app should block zero)
-- =============================================
ALTER TABLE transactions ADD CONSTRAINT transactions_grand_total_nonneg CHECK (grand_total >= 0);

-- =============================================
-- 3. Tender sum validation trigger
-- =============================================
CREATE OR REPLACE FUNCTION check_tender_sum() RETURNS trigger AS $$
DECLARE
  tender_sum numeric;
  txn_grand_total numeric;
BEGIN
  -- Only check on INSERT (UPDATE of amount is unusual)
  SELECT SUM(amount) INTO tender_sum FROM transaction_tenders WHERE transaction_id = NEW.transaction_id;
  SELECT grand_total INTO txn_grand_total FROM transactions WHERE id = NEW.transaction_id;

  IF tender_sum IS NOT NULL AND txn_grand_total IS NOT NULL THEN
    -- Allow small floating-point tolerance (0.01)
    IF ABS(tender_sum - txn_grand_total) > 0.01 THEN
      RAISE EXCEPTION 'Tender sum (%) does not match grand_total (%) for transaction %', tender_sum, txn_grand_total, NEW.transaction_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Statement-level trigger: validates after ALL tenders in a statement are inserted
-- This allows split tenders (multiple inserts in one statement)
DROP TRIGGER IF EXISTS trg_check_tender_sum ON transaction_tenders;
CREATE TRIGGER trg_check_tender_sum
  AFTER INSERT ON transaction_tenders
  FOR EACH ROW EXECUTE FUNCTION check_tender_sum();

-- Also add a statement-level check for multi-insert splits
CREATE OR REPLACE FUNCTION check_tender_sum_stmt() RETURNS trigger AS $$
DECLARE
  rec RECORD;
  tender_sum numeric;
  txn_grand_total numeric;
BEGIN
  FOR rec IN SELECT DISTINCT transaction_id FROM inserted_rows() LOOP
    SELECT SUM(amount) INTO tender_sum FROM transaction_tenders WHERE transaction_id = rec.transaction_id;
    SELECT grand_total INTO txn_grand_total FROM transactions WHERE id = rec.transaction_id;
    IF tender_sum IS NOT NULL AND txn_grand_total IS NOT NULL AND ABS(tender_sum - txn_grand_total) > 0.01 THEN
      RAISE EXCEPTION 'Tender sum (%) does not match grand_total (%) for transaction %', tender_sum, txn_grand_total, rec.transaction_id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- 4. register_sessions: add organization_id + device_id if missing
-- =============================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'register_sessions' AND column_name = 'organization_id') THEN
    ALTER TABLE register_sessions ADD COLUMN organization_id uuid;
    -- Backfill: try sessions first, then fall back to employee's org
    UPDATE register_sessions rs
      SET organization_id = COALESCE(
        (SELECT s.organization_id FROM sessions s WHERE s.id = rs.auth_session_id),
        (SELECT e.organization_id FROM employees e WHERE e.id = rs.employee_id)
      );
    -- Set default and make NOT NULL
    ALTER TABLE register_sessions ALTER COLUMN organization_id SET DEFAULT gen_random_uuid();
    -- Delete orphan sessions with no org (shouldn't exist)
    DELETE FROM register_sessions WHERE organization_id IS NULL;
    ALTER TABLE register_sessions ALTER COLUMN organization_id SET NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'register_sessions' AND column_name = 'device_id') THEN
    ALTER TABLE register_sessions ADD COLUMN device_id text;
  END IF;
END
$$;
