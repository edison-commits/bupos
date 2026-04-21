-- R29-H1: persist `points_earned` on each transaction so refunds reverse
-- the EXACT number of points originally credited.
--
-- Background: the refund path (register return-action.ts and admin
-- returns/process/route.ts) currently recomputes `refund_amount ×
-- earnRatePerDollar` at reversal time. If an admin changes the earn
-- rate between sale and refund, the reversal becomes wrong:
--   - rate ↓  => fewer points reversed, customer keeps a net surplus
--   - rate ↑  => more points reversed, customer's balance can hit 0
--                and lose pre-existing points (GREATEST clamp hides the
--                loss but still under-credits the customer).
-- Persisting the earned value on the sale row lets us reverse exactly
-- what was earned, prorated by the refund's share of the original total.
--
-- Safe for empty + populated tables: DEFAULT 0 means historical rows
-- (pre-R29-H1) refund as if they earned zero. Since the prior code was
-- computing `round(refund * earnRate)` with the CURRENT earn rate,
-- the pre-migration refund behaviour was already approximate; a silent
-- 0-points reversal on old transactions is strictly safer than the
-- prior behaviour (which could over- or under-reverse).

BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS points_earned integer NOT NULL DEFAULT 0
    CHECK (points_earned >= 0);

COMMENT ON COLUMN transactions.points_earned IS
  'Loyalty points credited at checkout (R29-H1). Refunds reverse a prorated portion of this value, not a recomputed one, so rate changes between sale and return can''t skew reversals.';

COMMIT;
