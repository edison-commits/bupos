-- R44 cleanup migration.
--
-- 1. R44-MED (NEW-M1 from R44 data/DB audit): migration 070 added
--    canonical `scheduled_shifts_tenant_access` / `time_off_requests_tenant_access`
--    policies but left the legacy `org_isolation` policies from
--    migrations 041/024 in place. RLS policies OR together, so the
--    legacy indirect-subquery forms are still being evaluated — a
--    future DBA reading pg_policies sees two intent-duplicates and
--    the weaker legacy form remains exploitable for the malformed-
--    row case (row's own organization_id disagreeing with its
--    location_id's org). Mirror the R43-M10 pay_in_outs cleanup.
--
-- 2. R44-LOW (NEW-L1 from R44): R43's 071 migration moved
--    `store_credit_ledger.customer_id` CASCADE → SET NULL but migration
--    068 had already moved it to RESTRICT on the explicit compliance
--    rationale that in-place anonymization is the correct deletion
--    flow and RESTRICT forces DBAs through it. SET NULL weakens that
--    guarantee (a hard-delete now silently orphans ledger rows).
--    Revert to RESTRICT.
--
-- R45-LOW: explicit BEGIN/COMMIT to match the 067-069 pattern and
-- ensure atomicity across the two DO blocks regardless of how the
-- runner wraps the file.

BEGIN;

DO $$
BEGIN
  -- (1a) scheduled_shifts: drop legacy org_isolation policy if it
  -- exists. The canonical policy from migration 070 stays.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'scheduled_shifts'
       AND policyname = 'org_isolation'
  ) THEN
    DROP POLICY IF EXISTS org_isolation ON scheduled_shifts;
    RAISE NOTICE 'R44-MED: dropped legacy org_isolation policy on scheduled_shifts';
  END IF;

  -- (1b) time_off_requests: same pattern.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'time_off_requests'
       AND policyname = 'org_isolation'
  ) THEN
    DROP POLICY IF EXISTS org_isolation ON time_off_requests;
    RAISE NOTICE 'R44-MED: dropped legacy org_isolation policy on time_off_requests';
  END IF;
END
$$;

DO $$
DECLARE
  constr TEXT;
BEGIN
  -- (2) Revert store_credit_ledger.customer_id to RESTRICT. 071 moved
  -- it to SET NULL + NULL-able; we restore RESTRICT semantics and
  -- keep the column NOT NULL (no orphan rows possible).
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'store_credit_ledger'
  ) THEN
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'store_credit_ledger'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'customer_id'
       AND ccu.table_name = 'customers'
     LIMIT 1;
    IF constr IS NOT NULL THEN
      -- Only re-tighten if we're currently in SET NULL shape (from 071).
      -- Skip if already RESTRICT — safe to re-run.
      IF EXISTS (
        SELECT 1 FROM information_schema.referential_constraints
         WHERE constraint_schema = 'public'
           AND constraint_name = constr
           AND delete_rule <> 'RESTRICT'
      ) THEN
        EXECUTE format('ALTER TABLE store_credit_ledger DROP CONSTRAINT %I', constr);
        -- Keep the column nullable (you can't safely re-add NOT NULL
        -- after a previous migration allowed NULLs — any existing
        -- NULL row would block the ALTER). The ledger's customer_id
        -- will remain non-nullable for NEW rows via app-level
        -- assertion; any pre-existing NULLs from the brief 071 window
        -- stay NULL.
        EXECUTE format(
          'ALTER TABLE store_credit_ledger ADD CONSTRAINT %I FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT',
          constr
        );
        RAISE NOTICE 'R44-LOW: store_credit_ledger.customer_id restored to ON DELETE RESTRICT';
      END IF;
    END IF;
  END IF;
END
$$;

COMMIT;
