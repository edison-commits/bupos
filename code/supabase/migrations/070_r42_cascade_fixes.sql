-- R46-M3: explicit BEGIN/COMMIT added retroactively to match 067-069
-- / 072 pattern. Ensures atomicity across the DO blocks regardless of
-- how the runner wraps the file.

BEGIN;

-- R42-B: close employee-CASCADE destruction windows on money-holding
-- and compliance tables. Migration 046 covered shifts / transactions /
-- time_clock_entries / pay_in_outs. This migration extends the same
-- SET NULL treatment to `layaways`, `layaway_payments`, and
-- `behavior_flags` — three tables the R42 audit identified as still
-- carrying ON DELETE CASCADE on their employee FKs.
--
-- Attack/failure mode each one closes:
--   layaways.employee_id               — CASCADE wipes the entire
--                                        layaway (deposit_paid cash,
--                                        balance_due, cart_snapshot)
--                                        when its creator is deleted.
--   layaway_payments.employee_id       — CASCADE wipes per-payment
--                                        audit trail; a customer who
--                                        paid $X across N payments
--                                        loses all N records.
--   behavior_flags.employee_id         — CASCADE destroys evidence of
--                                        misconduct flags targeting a
--                                        deleted employee — the OPPOSITE
--                                        of what a compliance flag
--                                        should do.
--
-- The app uses soft-delete (is_active = false) so these hard-delete
-- cascades are only reachable via DBA operations. But a DBA-initiated
-- hard-delete that quietly destroys money and compliance data is
-- precisely the kind of hazard that doesn't survive a post-incident
-- review. SET NULL preserves the historical record; the reports and
-- audit tooling already handle employee_id IS NULL by rendering
-- "(deleted)".
--
-- Idempotent: IF EXISTS guards + DROP-then-ADD pattern matches migration
-- 046. The guard block handles environments where the constraint was
-- already recreated by hand.

-- R42-M: unify RLS policies on pay_in_outs + scheduled_shifts +
-- time_off_requests to use the direct `organization_id = ::uuid`
-- comparison, matching the pattern used across every other tenant
-- table. Prior shapes:
--   pay_in_outs: `organization_id::text = current_setting(...)` — works,
--     but diverges from the canonical `col = ::uuid` pattern. A future
--     tooling change (or schema prefix on `app.current_org_id`) would
--     silently stop matching. Text-cast also foregoes UUID-type
--     checking.
--   scheduled_shifts / time_off_requests: `location_id IN (SELECT … )`
--     / `employee_id IN (…)` — policy checks travel through a subquery
--     JOIN instead of comparing the row's OWN `organization_id` column
--     directly. Indirection is correct only while FK integrity holds;
--     a malformed INSERT with a same-tenant `location_id` but a
--     different `organization_id` on the row itself would pass today.
DO $$
BEGIN
  -- pay_in_outs: rewrite USING + WITH CHECK to ::uuid form.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'pay_in_outs'
  ) THEN
    DROP POLICY IF EXISTS pay_in_outs_tenant_access ON pay_in_outs;
    CREATE POLICY pay_in_outs_tenant_access
      ON pay_in_outs
      FOR ALL
      USING (organization_id = current_setting('app.current_org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
    RAISE NOTICE 'R42-M: pay_in_outs policy rewritten to ::uuid form';
  END IF;

  -- scheduled_shifts: direct org comparison.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'scheduled_shifts'
  ) THEN
    DROP POLICY IF EXISTS scheduled_shifts_tenant_access ON scheduled_shifts;
    CREATE POLICY scheduled_shifts_tenant_access
      ON scheduled_shifts
      FOR ALL
      USING (organization_id = current_setting('app.current_org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
    RAISE NOTICE 'R42-M: scheduled_shifts policy rewritten to direct org compare';
  END IF;

  -- time_off_requests: direct org comparison.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'time_off_requests'
  ) THEN
    DROP POLICY IF EXISTS time_off_requests_tenant_access ON time_off_requests;
    CREATE POLICY time_off_requests_tenant_access
      ON time_off_requests
      FOR ALL
      USING (organization_id = current_setting('app.current_org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
    RAISE NOTICE 'R42-M: time_off_requests policy rewritten to direct org compare';
  END IF;
END
$$;

DO $$
DECLARE
  t RECORD;
  constr TEXT;
BEGIN
  FOR t IN
    SELECT 'layaways'::text AS tbl, 'employee_id'::text AS col
    UNION ALL
    SELECT 'layaway_payments', 'employee_id'
    UNION ALL
    SELECT 'behavior_flags', 'employee_id'
  LOOP
    -- Only act if the table actually exists (behavior_flags might not
    -- exist in all environments — migration 041 optionally creates it).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t.tbl
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t.tbl;
      CONTINUE;
    END IF;

    -- Find the FK constraint targeting employees via this column.
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = t.tbl
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = t.col
       AND ccu.table_name = 'employees'
     LIMIT 1;

    IF constr IS NULL THEN
      RAISE NOTICE 'Skipping %.%: no FK to employees found (already SET NULL or different name?)', t.tbl, t.col;
      CONTINUE;
    END IF;

    -- Drop NOT NULL if present, drop old FK, add SET NULL FK.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', t.tbl, t.col);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t.tbl, constr);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES employees(id) ON DELETE SET NULL',
      t.tbl, constr, t.col
    );
    RAISE NOTICE 'R42-B: %.% rewired to ON DELETE SET NULL', t.tbl, t.col;
  END LOOP;
END
$$;

COMMIT;
