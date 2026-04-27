-- Migration 076: SCH-M3 — extend `check_audit_triggers()` to cover
-- the 14 additional tamper triggers added in mig 067.
--
-- The original health probe in mig 068 only enumerated the 3 audit_events
-- triggers (no_update / no_delete / no_truncate). Mig 067 attached the
-- same audit_events_prevent_tamper() to:
--   transaction_tenders   (3 triggers)
--   transaction_events    (3 triggers)
--   pay_in_outs           (3 triggers)
--   layaway_payments      (3 triggers)
--   promo_redemptions     (2 triggers — no _no_delete in mig 067)
--
-- = 14 triggers that the /api/admin/health probe currently doesn't
-- check. If a DBA drops any of them, health reports green.
--
-- This migration redefines `check_audit_triggers()` to enumerate the
-- complete set. The view shape is unchanged: TABLE(trigger_name TEXT,
-- is_present BOOLEAN). Callers (admin/health/route.ts) iterate the rows
-- and degrade status if any is_present = false.

CREATE OR REPLACE FUNCTION public.check_audit_triggers()
  RETURNS TABLE(trigger_name TEXT, is_present BOOLEAN)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  WITH expected(name) AS (
    VALUES
      -- audit_events itself (mig 068 set)
      ('trg_audit_events_no_update'),
      ('trg_audit_events_no_delete'),
      ('trg_audit_events_no_truncate'),
      -- transaction_tenders (mig 067 set)
      ('trg_transaction_tenders_no_update'),
      ('trg_transaction_tenders_no_delete'),
      ('trg_transaction_tenders_no_truncate'),
      -- transaction_events (mig 067 set)
      ('trg_transaction_events_no_update'),
      ('trg_transaction_events_no_delete'),
      ('trg_transaction_events_no_truncate'),
      -- pay_in_outs (mig 067 set)
      ('trg_pay_in_outs_no_update'),
      ('trg_pay_in_outs_no_delete'),
      ('trg_pay_in_outs_no_truncate'),
      -- layaway_payments (mig 067 set)
      ('trg_layaway_payments_no_update'),
      ('trg_layaway_payments_no_delete'),
      ('trg_layaway_payments_no_truncate'),
      -- promo_redemptions (mig 067 attached only update + truncate;
      -- delete is intentionally NOT blocked because expired/disabled
      -- redemptions can be cleaned up by ops scripts)
      ('trg_promo_redemptions_no_update'),
      ('trg_promo_redemptions_no_truncate')
  )
  SELECT
    e.name,
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = e.name) AS is_present
  FROM expected e;
$$;

REVOKE EXECUTE ON FUNCTION public.check_audit_triggers() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_audit_triggers() TO service_role;

-- Verification: function exists and returns the expected count.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM check_audit_triggers();
  IF v_count <> 17 THEN
    RAISE EXCEPTION 'SCH-M3: check_audit_triggers() returns % rows, expected 17', v_count;
  END IF;
END $$;
