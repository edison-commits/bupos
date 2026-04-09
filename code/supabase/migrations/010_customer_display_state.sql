-- Migration: durable customer display state table
-- Replaces the in-memory Map in /api/customer-display with a DB-backed store
-- that survives Worker restarts.

CREATE TABLE IF NOT EXISTS customer_display_state (
  register_session_id UUID PRIMARY KEY REFERENCES register_sessions(id) ON DELETE CASCADE,
  cart JSONB NOT NULL DEFAULT '{}',
  totals JSONB NOT NULL DEFAULT '{}',
  payment_status TEXT CHECK (payment_status IN ('pending', 'processing', 'complete')),
  amount_tendered NUMERIC(12, 2),
  change_due NUMERIC(12, 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: secured via register_sessions → employees → organization
ALTER TABLE customer_display_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON customer_display_state
  USING (EXISTS (
    SELECT 1 FROM register_sessions rs
    JOIN employees e ON e.id = rs.employee_id
    WHERE rs.id = customer_display_state.register_session_id
      AND e.organization_id = current_setting('app.current_org_id', true)::uuid
  ));
