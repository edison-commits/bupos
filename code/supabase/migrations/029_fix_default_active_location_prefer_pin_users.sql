-- Fix dead-end PIN login: the old RPC picked the first location by
-- created_at, which often returns a "Main Store" row from a seed org that
-- has ZERO active PIN users. Every cashier who visits /register then hits
-- a PIN-failed loop with no way to switch locations.
--
-- New logic: prefer a location that has at least one active employee with
-- a PIN. Rank 0 > rank 1 so login-capable locations bubble up. Named
-- locations still beat blank-named ones within the same rank. Fallback to
-- the old behaviour if no PIN-enabled location exists (e.g. brand-new
-- installs where admin still hasn't set any cashier PINs).

CREATE OR REPLACE FUNCTION public.get_default_active_location()
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ranked AS (
    SELECT l.id,
           -- Use a sensible display name if the stored name is blank
           CASE WHEN COALESCE(l.name, '') = '' THEN 'Store'
                ELSE l.name END AS name,
           l.created_at,
           CASE WHEN EXISTS (
             SELECT 1
             FROM employees e
             JOIN auth_credentials ac ON ac.employee_id = e.id
             WHERE e.is_active = true
               AND ac.pin_hash IS NOT NULL
               AND l.id = ANY(e.location_ids)
           ) THEN 0 ELSE 1 END AS login_rank,
           CASE WHEN COALESCE(l.name, '') = '' THEN 1 ELSE 0 END AS name_rank
    FROM locations l
    WHERE l.is_active = true
  )
  SELECT id, name
  FROM ranked
  ORDER BY login_rank ASC, name_rank ASC, created_at ASC
  LIMIT 1;
$function$;

-- get_default_active_location is the ONE anon-callable RPC (pre-login
-- register page). Keep its public grant intact.
GRANT EXECUTE ON FUNCTION public.get_default_active_location() TO anon, authenticated, service_role;
