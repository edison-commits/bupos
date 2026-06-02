-- Migration 082: re-pin search_path on register_login_create_session.
--
-- Migration 081 added a cross-row org-consistency guard to
-- register_login_create_session via CREATE OR REPLACE. That is correct
-- behaviourally, but CREATE OR REPLACE RESETS a function's configuration
-- (proconfig) — it silently wiped the `SET search_path = public` that
-- migration 052 had pinned on this SECURITY DEFINER function. A SECDEF
-- function without a pinned search_path is a privilege-escalation vector
-- (the R21-H-3 integration gate fails closed on exactly this), so 081
-- regressed that hardening even though the function still worked.
--
-- Re-pin it the same way migration 052 originally did (separate ALTER).
-- This is idempotent and converges every environment to the same end
-- state: prod (where 081 already applied without the path) gets the path
-- back here; a fresh DB creates the fn in 081 then pins it here. Future
-- CREATE OR REPLACE on this function MUST include `SET search_path =
-- public` inline (see migration 077's RPCs) so the path survives the
-- replace — this ALTER only repairs the 081 regression.

ALTER FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz)
  SET search_path = public;
