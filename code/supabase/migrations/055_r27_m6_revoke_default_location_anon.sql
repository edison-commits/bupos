-- R27-M6: stop leaking a live tenant's locationId to unauthenticated
-- visitors of `/register`.
--
-- Previously `get_default_active_location()` was granted to `anon`
-- specifically because the Next.js server component on `/register`
-- called it via the anon key (to render "PIN login for <store name>"
-- before any session cookie exists). Any unauthenticated client on
-- the open internet could POST
--   /rest/v1/rpc/get_default_active_location
-- with the public anon key and receive the UUID of whichever live
-- tenant bubbled to the top of the ranking (predictable: live PIN
-- users → alphabetical by name → oldest). That UUID was then a valid
-- `locationId` seed for brute-forcing the tenant's employee PINs via
-- /api/auth/register-login, with zero prior access required.
--
-- The paired app change (src/app/register/page.tsx) moves the same
-- query to server-side direct pool access, so the anon grant is no
-- longer needed. Revoke it; keep `service_role` for migration / DBA
-- access.

REVOKE EXECUTE ON FUNCTION public.get_default_active_location() FROM anon, authenticated;

-- Idempotent: GRANT is already in place to service_role from
-- migration 029, and duplicate GRANTs are no-ops. Re-asserting for
-- clarity on the intended final state.
GRANT EXECUTE ON FUNCTION public.get_default_active_location() TO service_role;
