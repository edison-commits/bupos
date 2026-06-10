-- 090: sales digest configuration (P3.2).
-- The admin console has had a "Sales digest emails" settings panel since the
-- console era, but it was a stub — nothing persisted and nothing sent. This
-- adds the per-org config (same jsonb-on-organizations pattern as
-- approval_thresholds / loyalty_config from migration 011) and a SECURITY
-- DEFINER list RPC for the cross-org hourly sender (mirrors 088's
-- list_connected_channels conventions).
BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS digest_config jsonb NOT NULL DEFAULT '{
    "dailyEnabled": false,
    "weeklyEnabled": false,
    "recipients": [],
    "sendHour": 8,
    "lastDailySentOn": null,
    "lastWeeklySentOn": null
  }'::jsonb;

-- Cross-org listing for the Bearer-gated internal sender. Returns only orgs
-- with a digest enabled; the sender then operates per-org via org-scoped
-- queries. service_role only — never callable from anon/authenticated.
CREATE OR REPLACE FUNCTION public.list_digest_orgs()
  RETURNS TABLE(organization_id uuid, timezone text, digest_config jsonb)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $function$
  SELECT id, timezone, digest_config
  FROM organizations
  WHERE (digest_config->>'dailyEnabled')::boolean = true
     OR (digest_config->>'weeklyEnabled')::boolean = true
$function$;
REVOKE EXECUTE ON FUNCTION public.list_digest_orgs() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_digest_orgs() TO service_role;

COMMIT;
