-- R28-M7: enforce `SUM(transaction_tenders.amount) ≈ transactions.grand_total`
-- at the database layer.
--
-- Background: the initial migration 015 shipped a `check_tender_sum`
-- trigger but a subsequent migration (021_fix_tender_trigger.sql)
-- dropped it, leaving only application-layer validation in
-- checkout-action.ts. That's adequate for normal code paths but
-- unauditable for future endpoints — a cashier-as-attacker could
-- exploit a new endpoint bug (e.g., a split-tender mix-swap between
-- cash + gift_card vs cash + store_credit) without this DB-side
-- integrity check flagging it.
--
-- New shape: a CONSTRAINT trigger on `transaction_tenders` that fires
-- at COMMIT time (not per-row) so split-tender inserts don't fail
-- intermediate states. Tolerance of 0.01 per tender row accommodates
-- IEEE-754 drift without flagging real mismatches.
--
-- Returns: NEW row unchanged; raises EXCEPTION with the delta if the
-- invariant is violated.

BEGIN;

-- Drop any prior shape defensively (021 already dropped but some
-- environments may still have a leftover).
DROP TRIGGER IF EXISTS trg_check_tender_sum ON transaction_tenders;
DROP TRIGGER IF EXISTS trg_check_tender_sum_insert ON transaction_tenders;
DROP FUNCTION IF EXISTS check_tender_sum_fn() CASCADE;

CREATE OR REPLACE FUNCTION check_tender_sum_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_grand_total numeric;
  v_positive_tender_sum numeric;
  v_txn_status text;
BEGIN
  -- R29-C1: exempt refund rows (negative-amount tender inserts posted
  -- against a completed transaction by the returns/process and register
  -- return-action flows). These rows bring the SUM below grand_total
  -- intentionally — they are NOT a new payment, they are a reversal.
  -- Without this short-circuit the first admin refund on any completed
  -- transaction 500s because the ALL-rows sum no longer equals
  -- grand_total.
  IF NEW.amount < 0 THEN
    RETURN NEW;
  END IF;

  -- Only validate when ALL tender rows for this txn are in place.
  -- A constraint trigger firing at COMMIT time gives us that: any
  -- INSERT adds a row then we verify the full set.
  SELECT grand_total, status INTO v_grand_total, v_txn_status
    FROM transactions WHERE id = NEW.transaction_id;

  -- Only enforce for completed transactions. Pending/voided/refunded
  -- transactions may legitimately have mismatched tender sums during
  -- their in-progress state.
  IF v_txn_status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  -- Sum only POSITIVE tender rows. Refund rows (negative amount, keyed
  -- by the return-action convention) are excluded so a partial refund
  -- doesn't trip the invariant on the next full-tender audit.
  SELECT COALESCE(SUM(amount), 0) INTO v_positive_tender_sum
    FROM transaction_tenders
    WHERE transaction_id = NEW.transaction_id AND amount >= 0;

  -- 0.01 tolerance for floating-point drift.
  IF ABS(v_positive_tender_sum - v_grand_total) > 0.01 THEN
    RAISE EXCEPTION 'Tender sum (%) does not match transaction grand_total (%) for transaction % (delta %)',
      v_positive_tender_sum, v_grand_total, NEW.transaction_id, ABS(v_positive_tender_sum - v_grand_total);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CONSTRAINT TRIGGER fires at end-of-statement (or deferred to
-- COMMIT), which lets multi-row inserts complete before the check
-- runs. INITIALLY DEFERRED so the checkout-action.ts ordering
-- (INSERT transaction, then INSERT tenders in bulk) works naturally
-- without manual SET CONSTRAINTS.
CREATE CONSTRAINT TRIGGER trg_check_tender_sum
  AFTER INSERT OR UPDATE ON transaction_tenders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_tender_sum_fn();

COMMIT;
