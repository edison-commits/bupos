-- Migration: register_session_exceptions
-- Table referenced by checkout-action.ts but missing from 001_initial_schema.sql

CREATE TABLE IF NOT EXISTS register_session_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  register_session_id UUID NOT NULL REFERENCES register_sessions(id) ON DELETE CASCADE,
  exception_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  approved_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_register_session_exceptions_session_id ON register_session_exceptions(register_session_id);
CREATE INDEX IF NOT EXISTS idx_register_session_exceptions_status ON register_session_exceptions(status);
