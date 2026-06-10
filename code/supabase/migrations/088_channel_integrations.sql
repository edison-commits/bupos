-- Migration 088: Online Selling — sales-channel integration tables (Phase 1).
--
-- Adds a per-org Shopify connection, a SKU<->Shopify identifier map, a webhook
-- dedup ledger, and recorded online orders. One-way, POS-authoritative sync:
-- BuPOS pushes inventory to Shopify; Shopify orders webhook back to decrement.
--
-- Secrets (Shopify Admin token + webhook signing secret) are stored AES-256-GCM
-- ENCRYPTED (ciphertext only — see src/lib/channels/crypto.ts), never plaintext.
--
-- RLS: every table gets ENABLE + FORCE (the check:rls guardrail requires the
-- FORCE to match the ENABLE) + an org_isolation policy (current_setting
-- app.current_org_id, set by orgTx/orgQuery) + a service_role_full_access policy
-- (the webhook path resolves tenant via a SECURITY DEFINER RPC running as
-- service_role). The postgres role has BYPASSRLS so these are defense-in-depth.

BEGIN;

-- ── channel_integrations: one connection per (org, provider) ───────────────
CREATE TABLE IF NOT EXISTS channel_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'shopify',
  shop_domain text,
  access_token_ciphertext text,
  webhook_secret_ciphertext text,
  fulfillment_location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  shopify_location_id text,
  status text NOT NULL DEFAULT 'disconnected',
  last_sync_at timestamptz,
  last_error text,
  connected_by_employee_id uuid REFERENCES employees(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_integrations_org_provider
  ON channel_integrations(organization_id, provider);
-- A Shopify store maps to exactly one org — globally unique for webhook routing.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_integrations_shop_domain
  ON channel_integrations(shop_domain) WHERE shop_domain IS NOT NULL;

-- ── channel_product_map: BuPOS variant <-> Shopify identifiers (push index) ─
CREATE TABLE IF NOT EXISTS channel_product_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  sku text NOT NULL,
  external_variant_id text NOT NULL,
  external_inventory_item_id text NOT NULL,
  shopify_location_id text NOT NULL,
  last_pushed_on_hand integer,
  last_pushed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_map_integration_variant
  ON channel_product_map(channel_integration_id, product_variant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_map_integration_extvariant
  ON channel_product_map(channel_integration_id, external_variant_id);
CREATE INDEX IF NOT EXISTS idx_channel_map_org ON channel_product_map(organization_id);
CREATE INDEX IF NOT EXISTS idx_channel_map_variant ON channel_product_map(product_variant_id);

-- ── channel_webhook_events: dedup / replay guard ───────────────────────────
CREATE TABLE IF NOT EXISTS channel_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  webhook_id text NOT NULL,
  topic text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received'
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_webhook_integration_wid
  ON channel_webhook_events(channel_integration_id, webhook_id);
CREATE INDEX IF NOT EXISTS idx_channel_webhook_received ON channel_webhook_events(received_at);

-- ── online_orders: recorded Shopify orders ─────────────────────────────────
CREATE TABLE IF NOT EXISTS online_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  external_order_id text NOT NULL,
  external_order_number text,
  financial_status text,
  fulfillment_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  currency text,
  subtotal numeric(12, 2),
  total numeric(12, 2),
  line_items jsonb NOT NULL DEFAULT '[]',
  decrement_status text NOT NULL DEFAULT 'pending',
  unresolved_skus jsonb NOT NULL DEFAULT '[]',
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_online_orders_integration_extorder
  ON online_orders(channel_integration_id, external_order_id);
CREATE INDEX IF NOT EXISTS idx_online_orders_org ON online_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_online_orders_created ON online_orders(created_at DESC);

-- ── RLS: ENABLE + FORCE + org_isolation + service_role on all 4 ────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_integrations','channel_product_map','channel_webhook_events','online_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.current_org_id'', true)::uuid)', t);
    EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON %I', t);
    EXECUTE format('CREATE POLICY service_role_full_access ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── Pre-auth tenant resolution for the public webhook ──────────────────────
-- The Shopify webhook arrives with no session; it must resolve org by shop
-- domain BEFORE any org context exists. A raw pre-auth pool.query would trip
-- check:pool / check:pool-org-filter, so route it through a SECURITY DEFINER
-- RPC (mirrors how register-login resolves pre-auth). search_path pinned +
-- execute restricted to service_role (R21-H-3 / migration 052/077 convention).
CREATE OR REPLACE FUNCTION public.resolve_channel_by_shop_domain(p_shop_domain text)
  RETURNS TABLE(integration_id uuid, organization_id uuid, status text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $function$
  SELECT id, organization_id, status
    FROM channel_integrations
   WHERE shop_domain = p_shop_domain
     AND status = 'connected'
   LIMIT 1
$function$;
REVOKE EXECUTE ON FUNCTION public.resolve_channel_by_shop_domain(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_channel_by_shop_domain(text) TO service_role;

-- Cross-org list of connected integrations for the Bearer-gated reconcile job
-- (mirrors the run_nightly_cleanup SECDEF precedent — a system job that
-- legitimately spans tenants, kept off the raw-pool allowlist via an RPC).
CREATE OR REPLACE FUNCTION public.list_connected_channels()
  RETURNS TABLE(integration_id uuid, organization_id uuid)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $function$
  SELECT id, organization_id FROM channel_integrations WHERE status = 'connected'
$function$;
REVOKE EXECUTE ON FUNCTION public.list_connected_channels() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_connected_channels() TO service_role;

COMMIT;
