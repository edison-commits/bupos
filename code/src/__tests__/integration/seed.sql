-- R8-L-12 integration harness seed data.
--
-- Two independent organizations with the same shape (owner + manager +
-- cashier, location, product + variant, customer). Tests then try to
-- write across the boundary — each cross-tenant attempt should be
-- blocked by the RLS / WITH CHECK regime we built across rounds 8-20.
--
-- Fixed UUIDs so tests can reference specific rows without maintaining
-- a factory-output snapshot. Idempotent — wipes + reinserts via TRUNCATE
-- so re-running the seed leaves known state.
--
-- UUID naming convention: every UUID has a 2-char type prefix (hex-only
-- since UUIDs are hex), and then all-`a` chars for Org A or all-`b` for
-- Org B. Prefixes: 11=org, 22=location, 33=category, 44=employee-owner,
-- 55=employee-mgr, 66=employee-cashier, 77=customer, 88=product, 99=variant.

BEGIN;

-- The wipe below cascades into append-only tables (audit_events and the
-- other tamper-protected ledgers hardened in migrations 061-076) whose
-- triggers BLOCK TRUNCATE/UPDATE/DELETE — so `TRUNCATE organizations
-- CASCADE` aborts with "audit_events is append-only". Disable triggers for
-- the wipe via session_replication_role (the seed runs as the superuser),
-- then restore DEFAULT before the fixture inserts so they run with normal
-- FK + trigger behavior. (INSERTs into audit_events stay allowed — the
-- guard only blocks mutation/deletion, not appends.)
SET session_replication_role = replica;

-- Tenanted tables: TRUNCATE organizations CASCADE wipes every row whose
-- FK chain leads back to `organizations`. Explicit TRUNCATEs for the
-- non-tenanted and SET-NULL-FK tables follow (R21-L-2).
TRUNCATE organizations CASCADE;
TRUNCATE auth_credentials CASCADE;
TRUNCATE sessions CASCADE;

-- R21-L-2: non-tenanted or SET-NULL-FK tables don't cascade from
-- `organizations`. Without these explicit TRUNCATEs, re-running the
-- seed against a dirty DB (common local flow: `npm run docker:up &&
-- simulate-month.mjs && npm run test:integration`) accumulated state
-- across runs.
TRUNCATE pending_signups CASCADE;
TRUNCATE rate_limit_buckets CASCADE;
-- `time_clock_entries` is per-employee (FK to employees ON DELETE
-- CASCADE — the TRUNCATE organizations CASCADE above should reach
-- it, but guard against schema drift that loosens the FK).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='time_clock_entries') THEN
    EXECUTE 'TRUNCATE time_clock_entries CASCADE';
  END IF;
END $$;

-- Wipe complete — restore normal trigger + FK enforcement for the inserts.
SET session_replication_role = DEFAULT;

-- ── Org A ──
INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active)
  VALUES ('11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha Store', 'alpha', 'Alpha Store LLC', 'America/Los_Angeles', 'USD', 'free', true);

INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active)
  VALUES ('22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'Alpha Main', 'ALPHA-MAIN', '1 Alpha St', 'LA', 'CA', '90001', 0.095, true);

INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids)
  VALUES
    ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'owner', 'Alice', 'Owner', 'Alice Owner', 'alice.owner@alpha.test', '', true,
     ARRAY['22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[]),
    ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'manager', 'Alan', 'Manager', 'Alan Manager', 'alan.manager@alpha.test', '', true,
     ARRAY['22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[]),
    ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'cashier', 'Anna', 'Cashier', 'Anna Cashier', 'anna.cashier@alpha.test', '', true,
     ARRAY['22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[]);

INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, is_active)
  VALUES
    ('77aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'Aaron', 'Customer', 'aaron@alpha.test', '555-0001', true);

INSERT INTO categories (id, organization_id, name, slug, sort_order)
  VALUES ('33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'Uniforms', 'uniforms', 0);

INSERT INTO products (id, organization_id, category_id, name, slug, is_active)
  VALUES ('88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha Shirt', 'alpha-shirt', true);

INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, price, cost, is_active)
  VALUES ('99aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ALPHA-SHIRT-M', 'BARCODE-A-M',
          'Alpha Shirt M', 19.99, 5.00, true);

INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point)
  VALUES ('11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '99aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100, 0, 10);

-- ── Org B ──
INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active)
  VALUES ('11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Store', 'beta', 'Beta Store LLC', 'America/New_York', 'USD', 'free', true);

INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active)
  VALUES ('22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          'Beta Main', 'BETA-MAIN', '2 Beta Ave', 'NY', 'NY', '10001', 0.08875, true);

INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids)
  VALUES
    ('44bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'owner', 'Bob', 'Owner', 'Bob Owner', 'bob.owner@beta.test', '', true,
     ARRAY['22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[]),
    ('66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'cashier', 'Betty', 'Cashier', 'Betty Cashier', 'betty@beta.test', '', true,
     ARRAY['22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[]);

INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, is_active)
  VALUES
    ('77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'Barry', 'Customer', 'barry@beta.test', '555-0002', true);

INSERT INTO categories (id, organization_id, name, slug, sort_order)
  VALUES ('33bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          'Uniforms', 'uniforms', 0);

INSERT INTO products (id, organization_id, category_id, name, slug, is_active)
  VALUES ('88bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          '33bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Pants', 'beta-pants', true);

INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, price, cost, is_active)
  VALUES ('99bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          '88bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'BETA-PANTS-L', 'BARCODE-B-L',
          'Beta Pants L', 39.99, 10.00, true);

INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point)
  VALUES ('11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '99bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          '22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 50, 0, 5);

COMMIT;
