-- R43 cleanup migration — closes schema-level findings from the R43
-- round-2 audit.
--
-- 1. R43-M10: drop the legacy `pay_in_outs_org_isolation` policy that
--    migration 067 created. Migration 070 added the newer canonical
--    `pay_in_outs_tenant_access` (::uuid form) but did NOT drop its
--    predecessor, so after 070 applies the table carries TWO
--    simultaneous RLS policies that OR together. Behaviorally
--    identical today; confusing for any DBA reading pg_policies.
--
-- 2. R43-M8: rewire `register_sessions.employee_id` FK from
--    ON DELETE CASCADE to ON DELETE SET NULL. Migration 046 did this
--    for shifts / transactions / time_clock_entries / pay_in_outs;
--    migration 070 extended to layaways / layaway_payments /
--    behavior_flags. `register_sessions` was missed. A DBA hard-delete
--    of an employee cascades through register_sessions → transactions
--    (via register_session_id CASCADE at 001:261), then triggers the
--    mig-067 append-only trigger and aborts — but the error surface
--    is confusing, and if the trigger is ever dropped the destruction
--    becomes real. SET NULL matches the rest of the file.
--
-- 3. R43-M9: rewire money-audit FKs from CASCADE → SET NULL / RESTRICT
--    on parent delete to preserve compliance evidence:
--      - store_credit_ledger.customer_id: SET NULL (compliance trail)
--      - gift_card_transactions.gift_card_id: RESTRICT (can't lose
--        redemption history when a card is deleted; DBA must cancel
--        the card cleanly instead)
--      - layaway_payments.layaway_id: RESTRICT (same logic)

DO $$
BEGIN
  -- (1) Drop legacy duplicate policy if it exists.
  DROP POLICY IF EXISTS pay_in_outs_org_isolation ON pay_in_outs;
END
$$;

DO $$
DECLARE
  constr TEXT;
BEGIN
  -- (2) register_sessions.employee_id CASCADE → SET NULL.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'register_sessions'
  ) THEN
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'register_sessions'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'employee_id'
       AND ccu.table_name = 'employees'
     LIMIT 1;
    IF constr IS NOT NULL THEN
      EXECUTE 'ALTER TABLE register_sessions ALTER COLUMN employee_id DROP NOT NULL';
      EXECUTE format('ALTER TABLE register_sessions DROP CONSTRAINT %I', constr);
      EXECUTE format(
        'ALTER TABLE register_sessions ADD CONSTRAINT %I FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL',
        constr
      );
      RAISE NOTICE 'R43-M8: register_sessions.employee_id rewired to ON DELETE SET NULL';
    END IF;
  END IF;
END
$$;

DO $$
DECLARE
  constr TEXT;
BEGIN
  -- (3a) store_credit_ledger.customer_id CASCADE → SET NULL.
  -- Compliance trail must survive customer deletion. The balance
  -- history is already disambiguated by transaction_id + timestamp;
  -- customer_id NULL simply means "original customer deleted".
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'store_credit_ledger'
  ) THEN
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'store_credit_ledger'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'customer_id'
       AND ccu.table_name = 'customers'
     LIMIT 1;
    IF constr IS NOT NULL THEN
      EXECUTE 'ALTER TABLE store_credit_ledger ALTER COLUMN customer_id DROP NOT NULL';
      EXECUTE format('ALTER TABLE store_credit_ledger DROP CONSTRAINT %I', constr);
      EXECUTE format(
        'ALTER TABLE store_credit_ledger ADD CONSTRAINT %I FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL',
        constr
      );
      RAISE NOTICE 'R43-M9a: store_credit_ledger.customer_id rewired to ON DELETE SET NULL';
    END IF;
  END IF;

  -- (3b) gift_card_transactions.gift_card_id CASCADE → RESTRICT.
  -- RESTRICT because the transaction row is meaningless without the
  -- parent card — we want the DBA to go through a controlled
  -- "disable + archive" flow instead of a hard delete that silently
  -- loses redemption history.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'gift_card_transactions'
  ) THEN
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'gift_card_transactions'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'gift_card_id'
       AND ccu.table_name = 'gift_cards'
     LIMIT 1;
    IF constr IS NOT NULL THEN
      EXECUTE format('ALTER TABLE gift_card_transactions DROP CONSTRAINT %I', constr);
      EXECUTE format(
        'ALTER TABLE gift_card_transactions ADD CONSTRAINT %I FOREIGN KEY (gift_card_id) REFERENCES gift_cards(id) ON DELETE RESTRICT',
        constr
      );
      RAISE NOTICE 'R43-M9b: gift_card_transactions.gift_card_id rewired to ON DELETE RESTRICT';
    END IF;
  END IF;

  -- (3c) layaway_payments.layaway_id CASCADE → RESTRICT. Same logic —
  -- can't silently lose per-payment history when a layaway is deleted.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'layaway_payments'
  ) THEN
    SELECT tc.constraint_name INTO constr
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'layaway_payments'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'layaway_id'
       AND ccu.table_name = 'layaways'
     LIMIT 1;
    IF constr IS NOT NULL THEN
      EXECUTE format('ALTER TABLE layaway_payments DROP CONSTRAINT %I', constr);
      EXECUTE format(
        'ALTER TABLE layaway_payments ADD CONSTRAINT %I FOREIGN KEY (layaway_id) REFERENCES layaways(id) ON DELETE RESTRICT',
        constr
      );
      RAISE NOTICE 'R43-M9c: layaway_payments.layaway_id rewired to ON DELETE RESTRICT';
    END IF;
  END IF;
END
$$;
