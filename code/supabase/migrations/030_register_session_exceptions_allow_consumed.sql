-- Record (idempotently) that `register_session_exceptions.status` can take
-- the terminal value 'consumed'. The live database already has this CHECK
-- — it was added via ad-hoc migration in an earlier round — but no
-- migration file in the repo captures it. Without this file, a fresh
-- environment built from migrations alone would inherit the original
-- `CHECK (status IN ('pending', 'approved', 'denied'))` from 003, and the
-- checkout / offline-sync / cash-drawer approval-burn paths would all
-- trip a check_violation (23514) on every sale that used a manager
-- approval, aborting the transaction.
--
-- Safe to re-run: we drop any constraint whose definition does NOT include
-- 'consumed', then add the canonical one if it's missing.

DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO current_def
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  WHERE cls.relname = 'register_session_exceptions'
    AND con.contype = 'c'
    AND con.conname = 'register_session_exceptions_status_check';

  IF current_def IS NULL THEN
    ALTER TABLE register_session_exceptions
      ADD CONSTRAINT register_session_exceptions_status_check
      CHECK (status IN ('pending', 'approved', 'denied', 'consumed'));
  ELSIF current_def NOT LIKE '%consumed%' THEN
    ALTER TABLE register_session_exceptions
      DROP CONSTRAINT register_session_exceptions_status_check;
    ALTER TABLE register_session_exceptions
      ADD CONSTRAINT register_session_exceptions_status_check
      CHECK (status IN ('pending', 'approved', 'denied', 'consumed'));
  END IF;
END $$;
