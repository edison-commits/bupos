-- Cycle-count review support: require an operator-entered reason when a
-- counted line posts a non-zero variance. NOT VALID preserves historical
-- accepted counts while enforcing the constraint for new/updated rows.
BEGIN;

ALTER TABLE stocktake_lines
  ADD COLUMN IF NOT EXISTS variance_reason TEXT;

ALTER TABLE stocktake_lines
  DROP CONSTRAINT IF EXISTS variance_reason_required;

ALTER TABLE stocktake_lines
  ADD CONSTRAINT variance_reason_required
  CHECK (
    counted_qty IS NULL
    OR variance IS NULL
    OR variance = 0
    OR NULLIF(BTRIM(variance_reason), '') IS NOT NULL
  ) NOT VALID;

COMMIT;
