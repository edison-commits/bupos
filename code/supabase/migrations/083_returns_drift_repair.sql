-- Migration 083: repair returns-table production drift.
--
-- Surfaced by a month-of-usage simulation: EVERY return via
-- /api/returns/process and /api/returns 500'd with "Failed to process
-- return". Root cause: prod's `returns` table is missing two columns that
-- migration 002_returns_tables.sql defines:
--
--   * transaction_id  — the INSERT in returns/process and the SELECTs/PUT
--                       in /api/returns reference it. Missing -> 42703
--                       undefined_column -> the savepoint loop re-throws
--                       (non-unique) -> generic 500. Return CREATION broken.
--   * updated_at      — /api/returns PUT does
--                       `UPDATE returns SET status=$1, processed_by=$2,
--                        updated_at=NOW()`. Missing -> 42703 -> 500.
--                       Return STATUS TRANSITIONS (approve/complete/reject)
--                       broken.
--
-- Why prod drifted while fresh DBs are fine: migration 002 uses
-- `CREATE TABLE IF NOT EXISTS returns (...)`. Prod's returns table was
-- created out-of-band (its indexes don't match 002's either), so the 002
-- definition — including these two columns — was a silent no-op. check:schema
-- builds its model FROM the migrations, so it sees both columns and passes;
-- only the live prod table diverged. Same drift class as migration 080
-- (products.supplier_id).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on every fresh DB (already
-- has both from 002) and adds the columns on the drifted prod table. Both are
-- safe to add online — transaction_id is nullable; updated_at takes 002's
-- default so existing historical rows backfill to now() at ALTER time.

ALTER TABLE returns ADD COLUMN IF NOT EXISTS transaction_id uuid;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The /api/returns PUT path looks up `WHERE r.transaction_id = $2`; index it.
CREATE INDEX IF NOT EXISTS idx_returns_transaction_id ON returns(transaction_id);
