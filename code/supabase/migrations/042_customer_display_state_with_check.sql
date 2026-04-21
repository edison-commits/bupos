-- R13-H-3: migration 010 created the RLS policy on customer_display_state
-- with only a USING clause, no WITH CHECK. USING filters SELECTs; WITH CHECK
-- is required to block cross-tenant INSERT/UPDATE. Migration 024's global
-- RLS-with-check sweep missed this one table (it's a child table scoped via
-- register_sessions → employees, and 024's child-table list didn't include
-- customer_display_state).
--
-- Today the app path always passes the caller's verified register_session_id,
-- so no production exploit exists. But this is defense-in-depth: every other
-- child table got WITH CHECK in round 8, and an attacker with direct SQL
-- access (compromised postgres role, rogue migration) could insert rows
-- pointing at foreign tenants' register sessions without this guard.

-- Production has not applied migration 010 (table doesn't exist there —
-- the /api/customer-display feature uses a different backing store in
-- prod today). This migration is therefore guarded on table existence
-- so it's a no-op in prod but tightens the policy on any fresh-DB that
-- DOES run migration 010. When 010 eventually lands in prod, re-running
-- 042 will pick up the policy upgrade cleanly.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'customer_display_state') THEN
    DROP POLICY IF EXISTS parent_org_isolation ON customer_display_state;
    CREATE POLICY parent_org_isolation ON customer_display_state
      USING (EXISTS (
        SELECT 1 FROM register_sessions rs
        JOIN employees e ON e.id = rs.employee_id
        WHERE rs.id = customer_display_state.register_session_id
          AND e.organization_id = current_setting('app.current_org_id', true)::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM register_sessions rs
        JOIN employees e ON e.id = rs.employee_id
        WHERE rs.id = customer_display_state.register_session_id
          AND e.organization_id = current_setting('app.current_org_id', true)::uuid
      ));
  END IF;
END $$;
