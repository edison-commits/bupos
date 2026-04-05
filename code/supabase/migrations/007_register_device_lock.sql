-- Add device_id column for multi-device register locking
-- organization_id added so we can index by (organization_id, device_id)
ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Backfill organization_id for existing sessions using the location relationship
UPDATE register_sessions
SET organization_id = loc.organization_id
FROM locations loc
WHERE register_sessions.location_id = loc.id
  AND register_sessions.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_register_sessions_active_device
  ON register_sessions(organization_id, device_id)
  WHERE status = 'active';
