-- Round 8 audit fixes (applied to prod via Supabase MCP).
--   (1) Missing columns the app reads/writes but the repo migrations never declared:
--         employees.phone, shifts.organization_id, idempotency_key on transactions/returns/transfers/shifts.
--   (2) Every RLS policy recreated with a WITH CHECK clause matching its USING clause so
--       cross-tenant INSERTs and UPDATEs are actually blocked (USING alone only filters SELECTs).

-- ============================================================================
-- 1. Missing columns
-- ============================================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS organization_id uuid;
UPDATE shifts s SET organization_id = l.organization_id FROM locations l
 WHERE s.location_id = l.id AND s.organization_id IS NULL;
ALTER TABLE shifts ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shifts_organization_id_fkey') THEN
    ALTER TABLE shifts ADD CONSTRAINT shifts_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_shifts_org_status ON shifts(organization_id, status);

-- idempotency_key columns for all relevant tables
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE returns      ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE transfers    ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE shifts       ADD COLUMN IF NOT EXISTS idempotency_key text;

DROP INDEX IF EXISTS idx_transactions_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_org_idempotency_key
  ON transactions(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_org_idempotency_key
  ON returns(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_org_idempotency_key
  ON transfers(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_org_idempotency_key
  ON shifts(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- 2. RLS policies with WITH CHECK on every org-scoped and child table.
--    Drop first so the migration is idempotent; recreate with matching WITH CHECK.
-- ============================================================================

-- Direct org-scoped tables
--
-- R13-H-2: per-table existence check so fresh-DB bootstrap doesn't fail
-- when `suppliers` / `purchase_orders` / `expenses` don't exist yet —
-- those tables are codified in migration 041 and its policy-refresh
-- block picks up whatever this migration skips. In prod, all tables
-- already exist so nothing is skipped.
DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'organizations','locations','employees','categories','modifier_groups','modifiers',
    'products','product_variants','inventory_levels','customers','transactions',
    'audit_events','gift_cards','store_credit_ledger','behavior_flags','layaways',
    'stocktakes','transfers','time_clock_entries','promo_codes','returns','shifts',
    'suppliers','purchase_orders','expenses'
  ];
  col text;
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', tbl);
    col := CASE WHEN tbl = 'organizations' THEN 'id' ELSE 'organization_id' END;
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (%I = current_setting(''app.current_org_id'', true)::uuid) WITH CHECK (%I = current_setting(''app.current_org_id'', true)::uuid)',
      tbl, col, col
    );
  END LOOP;
END$$;

-- Child tables scoped by FK to a secured parent table
DROP POLICY IF EXISTS parent_org_isolation ON transaction_tenders;
CREATE POLICY parent_org_isolation ON transaction_tenders
  USING (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_tenders.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_tenders.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON transaction_events;
CREATE POLICY parent_org_isolation ON transaction_events
  USING (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_events.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_events.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON transaction_exceptions;
CREATE POLICY parent_org_isolation ON transaction_exceptions
  USING (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_exceptions.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_exceptions.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON transaction_lines;
CREATE POLICY parent_org_isolation ON transaction_lines
  USING (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_lines.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_lines.transaction_id AND t.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON pay_in_outs;
CREATE POLICY parent_org_isolation ON pay_in_outs
  USING (EXISTS (SELECT 1 FROM locations l WHERE l.id = pay_in_outs.location_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM locations l WHERE l.id = pay_in_outs.location_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON auth_credentials;
CREATE POLICY parent_org_isolation ON auth_credentials
  USING (EXISTS (SELECT 1 FROM employees e WHERE e.id = auth_credentials.employee_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM employees e WHERE e.id = auth_credentials.employee_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON sessions;
CREATE POLICY parent_org_isolation ON sessions
  USING (EXISTS (SELECT 1 FROM employees e WHERE e.id = sessions.employee_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM employees e WHERE e.id = sessions.employee_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON register_sessions;
CREATE POLICY org_isolation ON register_sessions
  USING (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid));

-- R13-H-2: scheduled_shifts + time_off_requests are created by migration 041
-- (they exist in prod but had no CREATE TABLE migration). On fresh-DB, guard
-- with existence checks; 041 re-applies the policies via its own DO block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'scheduled_shifts') THEN
    DROP POLICY IF EXISTS parent_org_isolation ON scheduled_shifts;
    CREATE POLICY org_isolation ON scheduled_shifts
      USING (location_id IN (SELECT id FROM locations WHERE organization_id = current_setting('app.current_org_id', true)::uuid))
      WITH CHECK (location_id IN (SELECT id FROM locations WHERE organization_id = current_setting('app.current_org_id', true)::uuid));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'time_off_requests') THEN
    DROP POLICY IF EXISTS parent_org_isolation ON time_off_requests;
    CREATE POLICY org_isolation ON time_off_requests
      USING (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid))
      WITH CHECK (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid));
  END IF;
END $$;

DROP POLICY IF EXISTS parent_org_isolation ON inventory_adjustments;
CREATE POLICY parent_org_isolation ON inventory_adjustments
  USING (EXISTS (SELECT 1 FROM locations l WHERE l.id = inventory_adjustments.location_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM locations l WHERE l.id = inventory_adjustments.location_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON gift_card_transactions;
CREATE POLICY parent_org_isolation ON gift_card_transactions
  USING (EXISTS (SELECT 1 FROM gift_cards gc WHERE gc.id = gift_card_transactions.gift_card_id AND gc.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM gift_cards gc WHERE gc.id = gift_card_transactions.gift_card_id AND gc.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON layaway_payments;
CREATE POLICY parent_org_isolation ON layaway_payments
  USING (EXISTS (SELECT 1 FROM layaways l WHERE l.id = layaway_payments.layaway_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM layaways l WHERE l.id = layaway_payments.layaway_id AND l.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON stocktake_lines;
CREATE POLICY parent_org_isolation ON stocktake_lines
  USING (EXISTS (SELECT 1 FROM stocktakes st WHERE st.id = stocktake_lines.stocktake_id AND st.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM stocktakes st WHERE st.id = stocktake_lines.stocktake_id AND st.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON transfer_lines;
CREATE POLICY parent_org_isolation ON transfer_lines
  USING (EXISTS (SELECT 1 FROM transfers tr WHERE tr.id = transfer_lines.transfer_id AND tr.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM transfers tr WHERE tr.id = transfer_lines.transfer_id AND tr.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON promo_redemptions;
CREATE POLICY parent_org_isolation ON promo_redemptions
  USING (EXISTS (SELECT 1 FROM promo_codes pc WHERE pc.id = promo_redemptions.promo_code_id AND pc.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM promo_codes pc WHERE pc.id = promo_redemptions.promo_code_id AND pc.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON product_modifier_groups;
CREATE POLICY parent_org_isolation ON product_modifier_groups
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_modifier_groups.product_id AND p.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_modifier_groups.product_id AND p.organization_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS parent_org_isolation ON return_lines;
CREATE POLICY parent_org_isolation ON return_lines
  USING (EXISTS (SELECT 1 FROM returns r WHERE r.id = return_lines.return_id AND r.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM returns r WHERE r.id = return_lines.return_id AND r.organization_id = current_setting('app.current_org_id', true)::uuid));

-- R13-H-2: purchase_order_lines + purchase_orders are created by migration 041
-- (they exist in prod but had no CREATE TABLE migration). On fresh-DB, 041
-- runs after 024, so we guard this stanza. 041 re-applies the policy itself
-- via its own DO block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'purchase_order_lines') THEN
    DROP POLICY IF EXISTS parent_org_isolation ON purchase_order_lines;
    CREATE POLICY parent_org_isolation ON purchase_order_lines
      USING (EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_lines.purchase_order_id AND po.organization_id = current_setting('app.current_org_id', true)::uuid))
      WITH CHECK (EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_lines.purchase_order_id AND po.organization_id = current_setting('app.current_org_id', true)::uuid));
  END IF;
END $$;

DROP POLICY IF EXISTS parent_org_isolation ON register_session_exceptions;
CREATE POLICY parent_org_isolation ON register_session_exceptions
  USING (EXISTS (SELECT 1 FROM register_sessions rs JOIN employees e ON e.id = rs.employee_id WHERE rs.id = register_session_exceptions.register_session_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM register_sessions rs JOIN employees e ON e.id = rs.employee_id WHERE rs.id = register_session_exceptions.register_session_id AND e.organization_id = current_setting('app.current_org_id', true)::uuid));
