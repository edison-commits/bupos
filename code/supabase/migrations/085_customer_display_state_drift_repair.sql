-- Migration 085: repair customer_display_state production drift.
--
-- Found by the new prod schema-drift guardrail (check:prod-drift): the
-- `customer_display_state` TABLE — created in migration 010 and read/written
-- by /api/customer-display (INSERT/SELECT/DELETE) — does not exist in prod at
-- all, so the entire customer-facing display feature 500s (42P01 undefined_
-- table). Same root cause as 083/084: prod's _migrations tracker records 010
-- as applied, but the object was never materialized (prod was bootstrapped
-- from a snapshot that predated/omitted it). check:schema stayed green because
-- it models the migrations, not the live DB.
--
-- Re-create the table idempotently, matching migration 010 (no later migration
-- adds columns to it; 035/042/044/067 only harden RLS, which is cosmetic under
-- the app's BYPASSRLS postgres role — tenancy is enforced in app WHERE
-- clauses). CREATE TABLE IF NOT EXISTS is a no-op on every fresh DB.

CREATE TABLE IF NOT EXISTS customer_display_state (
  register_session_id UUID PRIMARY KEY REFERENCES register_sessions(id) ON DELETE CASCADE,
  cart JSONB NOT NULL DEFAULT '{}',
  totals JSONB NOT NULL DEFAULT '{}',
  payment_status TEXT CHECK (payment_status IN ('pending', 'processing', 'complete')),
  amount_tendered NUMERIC(12, 2),
  change_due NUMERIC(12, 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE customer_display_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_display_state FORCE ROW LEVEL SECURITY;

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
