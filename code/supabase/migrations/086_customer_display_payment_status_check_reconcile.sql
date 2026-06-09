-- Migration 086: reconcile customer_display_state.payment_status CHECK.
--
-- Migration 035 widened this CHECK to allow 'failed'/'cancelled'. But on prod
-- the table was entirely missing (the drift the SIM-AUDIT8 guardrail caught),
-- so 035's ALTER never materialized, and the drift-repair migration 085
-- re-created the table at the narrower migration-010 set
-- (pending/processing/complete). That left prod's CHECK behind the migrations
-- — a CHECK-constraint drift the column-level drift guardrail doesn't see.
--
-- AUDIT9 tightened customerDisplaySchema.paymentStatus to the full 035 set, so
-- widen prod's CHECK to match. Idempotent: drops the existing constraint by
-- its (deterministic, inline-CHECK) name and re-adds the 035 definition. Fresh
-- DBs already carry the 035 constraint, so this just normalizes it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'customer_display_state_payment_status_check'
       AND conrelid = 'customer_display_state'::regclass
  ) THEN
    ALTER TABLE customer_display_state
      DROP CONSTRAINT customer_display_state_payment_status_check;
  END IF;
  ALTER TABLE customer_display_state
    ADD CONSTRAINT customer_display_state_payment_status_check
    CHECK (payment_status IS NULL OR payment_status IN
      ('pending', 'processing', 'complete', 'failed', 'cancelled'));
END $$;
