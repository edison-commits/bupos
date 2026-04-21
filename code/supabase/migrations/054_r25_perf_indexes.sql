-- R25-perf-8 + R25-perf-9: indexes to prevent performance cliffs at scale.
--
-- 1. audit_events(organization_id, created_at DESC, id DESC)
--    The /api/audit feed filters by org_id + sorts by created_at DESC
--    with keyset pagination. Separate btrees on org_id + created_at
--    force the planner to choose between sort-after-filter (slow past
--    ~100k rows/org) and reverse-scan-then-filter. A composite index
--    with DESC ordering on the trailing key serves the query as an
--    index-only walk.
--
-- 2. customers first_name / last_name / email trigram indexes
--    The customer-search modal does
--      WHERE first_name ILIKE '%q%' OR last_name ILIKE '%q%' OR email ILIKE '%q%' OR phone ILIKE '%q%'
--    None of the existing btree indexes serve a prefix-unanchored
--    ILIKE. pg_trgm + GIN indexes on each column turn 50-150ms
--    seqscan-per-keystroke into 5-15ms.
--
-- Safe on re-apply (every statement uses IF NOT EXISTS).
BEGIN;

-- 1. audit_events composite index.
CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events(organization_id, created_at DESC, id DESC);

-- 2. pg_trgm + customer search indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_first_name_trgm
  ON customers USING gin (first_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_last_name_trgm
  ON customers USING gin (last_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_email_trgm
  ON customers USING gin (email gin_trgm_ops)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm
  ON customers USING gin (phone gin_trgm_ops)
  WHERE phone IS NOT NULL;

COMMIT;
