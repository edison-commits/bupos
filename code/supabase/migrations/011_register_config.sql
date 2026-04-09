-- Add register configuration columns to organizations table
-- These replace the hardcoded registerConfiguration in mock-data.ts

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS approval_thresholds jsonb NOT NULL DEFAULT '{
    "discountOver": 5,
    "itemVoidOver": 15,
    "transactionVoidOver": 20,
    "storeCreditIssuanceOver": 10,
    "manualPriceOverrideOver": 10,
    "returnWithoutManagerOver": 40
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS loyalty_config jsonb NOT NULL DEFAULT '{
    "earnRatePerDollar": 1,
    "redemptionValuePerPoint": 0.01,
    "minimumRedemption": 100
  }'::jsonb;
