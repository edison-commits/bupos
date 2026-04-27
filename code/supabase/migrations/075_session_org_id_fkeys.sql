-- Migration 075: SCH-H2 — add FKs on sessions.organization_id and
-- register_sessions.organization_id pointing at organizations(id).
--
-- Mig 037 added sessions.organization_id NOT NULL (with backfill from
-- the joined employees row), but never declared the foreign key.
-- Mig 015 did the same for register_sessions.organization_id.
--
-- Without the FK, when an organization is deleted (cascading from
-- employees.organization_id ON DELETE CASCADE), session rows survive
-- as orphans. Reads under that orphan org_id resolve to a non-existent
-- tenant — `app.current_org_id` set to that UUID returns nothing live
-- behind it, and any future org-id reuse (UUID collision is astronomically
-- unlikely, but not impossible) would silently re-attach the orphan rows
-- to a new tenant.
--
-- This migration is the cleanup step. It first prunes orphan rows
-- (defensive — there should be none if the cascade works as designed),
-- then adds the FK with ON DELETE CASCADE so future org deletions
-- correctly cascade to sessions.

-- 1. Prune orphans defensively. If any session/register_session row
--    references a non-existent organization, the FK ADD would fail
--    with 23503. Ship deletion of orphans as part of the same migration
--    so the FK ADD always succeeds.
DELETE FROM sessions s
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = s.organization_id);

DELETE FROM register_sessions rs
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = rs.organization_id);

-- 2. Add the FKs. Idempotent: skip if the constraint already exists
--    under any name. We name them explicitly so future migrations can
--    drop them by name without pg_constraint discovery.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'sessions'
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = t.oid AND attname = 'organization_id')
      ]
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES organizations(id)
      ON DELETE CASCADE;
    RAISE NOTICE 'SCH-H2: added sessions_organization_id_fkey';
  ELSE
    RAISE NOTICE 'SCH-H2: sessions.organization_id FK already present';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'register_sessions'
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = t.oid AND attname = 'organization_id')
      ]
  ) THEN
    ALTER TABLE register_sessions
      ADD CONSTRAINT register_sessions_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES organizations(id)
      ON DELETE CASCADE;
    RAISE NOTICE 'SCH-H2: added register_sessions_organization_id_fkey';
  ELSE
    RAISE NOTICE 'SCH-H2: register_sessions.organization_id FK already present';
  END IF;
END $$;

-- 3. Verification — both FKs MUST exist after this migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'sessions'
      AND c.conname = 'sessions_organization_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SCH-H2: sessions FK did not land — abort';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'register_sessions'
      AND c.conname = 'register_sessions_organization_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SCH-H2: register_sessions FK did not land — abort';
  END IF;
END $$;
