-- R20-LOW-1: migration 015 created `transaction_lines` but never ran
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Migration 024 created a
-- `parent_org_isolation` policy on it — but the policy was DORMANT on
-- fresh-DB because RLS was never enabled. Prod had RLS enabled ad-hoc
-- but never FORCE'd, meaning the `postgres` role (BYPASSRLS) still
-- skipped the policy.
--
-- No app code currently reads or writes `transaction_lines` — line items
-- live in `transactions.cart_snapshot` (JSONB). But any future engineer
-- who adds an INSERT/SELECT against this table expecting RLS to scope
-- by tenant would silently create a cross-tenant write primitive.
-- Closing the latent surface now, idempotently.
--
-- The `check-rls-force-matching` lint was extended in the same round to
-- detect `CREATE POLICY ON X` without a matching `ENABLE` in the
-- migration tree, so this class can't recur.

ALTER TABLE IF EXISTS transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS transaction_lines FORCE ROW LEVEL SECURITY;
