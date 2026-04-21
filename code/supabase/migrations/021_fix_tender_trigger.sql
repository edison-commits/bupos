-- Fix broken tender sum trigger (015_transaction_integrity.sql).
--
-- The row-level trigger fires per-INSERT, which breaks split tenders:
-- inserting the first tender line triggers validation before the second line exists.
-- Tender sum validation is now enforced in application code (checkout-action.ts)
-- before inserting tender rows, preventing the split-tender race condition.
DROP TRIGGER IF EXISTS trg_check_tender_sum ON transaction_tenders;
