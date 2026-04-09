-- M-02 (completion): Add NOT NULL constraint to register_sessions.organization_id
-- The column was converted from TEXT to UUID in 012_audit_fixes.sql but NOT NULL was omitted.
ALTER TABLE register_sessions ALTER COLUMN organization_id SET NOT NULL;
