# Rollback Runbook

This runbook covers reverting a bad deploy. Two classes of rollback:

1. **Worker-only rollback** — the new code is broken but the
   migrations are fine. Fast and safe.
2. **Migration rollback** — a migration shipped a schema change that
   the old code can't tolerate. Slower and per-migration.

**Default policy: roll the Worker back first. Only roll migrations
back if a Worker-only rollback can't recover.** Most R30-R36
migrations are designed to be backwards-compatible (RENAME is atomic,
`ADD COLUMN` is additive, new policies tighten but don't break old
queries), so the old Worker usually still runs against the new
schema.

## Worker-only rollback (preferred)

Via Cloudflare dashboard OR wrangler:

```bash
cd code

# List recent deploys (newest first)
npx wrangler deployments list

# Roll back to a specific deploy id. This flips prod traffic back to
# that bundle without redoing migrations.
npx wrangler rollback --message "<reason>" <deployment-id>
```

After rollback:
1. Verify `/api/health` returns 200 with `status: ok`.
2. Check recent `api_route_client_error` events in Cloudflare logs for
   5xx or step-up-related 400 floods (confirm the rollback actually
   cleared whatever triggered the incident).
3. File a post-mortem issue referencing the rolled-back commit sha.

## Migration rollback — only when Worker rollback isn't enough

Reverse SQL by migration. Run in REVERSE numeric order — i.e. if you
need to revert 066, 065, 064, run 066's reverse first.

### 066 — `idx_transactions_org_loc_created_completed`

```sql
DROP INDEX IF EXISTS idx_transactions_org_loc_created_completed;
DELETE FROM _migrations WHERE filename = '066_r35_perf_transaction_index.sql';
```

No data is lost. The index is purely a query-speed optimization.

### 065 — `bupos_nightly_cleanup` pg_cron job

```sql
SELECT cron.unschedule('bupos_nightly_cleanup');
DROP FUNCTION IF EXISTS public.run_nightly_cleanup() CASCADE;
DELETE FROM _migrations WHERE filename = '065_r33_pg_cron_cleanup.sql';
```

No data is lost — the underlying cleanup functions stay; just the
scheduled call is removed.

### 064 — R32 follow-ups (RLS policy rewrite + search_path + orchestrator)

```sql
-- The RLS policy swap is the main risk: dropping the new policy
-- without re-creating the OLD one would leave the table with no
-- policy, which under `FORCE ROW LEVEL SECURITY` means no tenant
-- can read. So re-create the pre-064 policy first.
DROP POLICY IF EXISTS inventory_adjustments_org_isolation ON inventory_adjustments;
CREATE POLICY parent_org_isolation ON inventory_adjustments
  USING (
    organization_id::text = current_setting('app.current_org_id', true)
    OR organization_id IS NULL
  )
  WITH CHECK (
    organization_id::text = current_setting('app.current_org_id', true)
  );
DROP FUNCTION IF EXISTS public.run_nightly_cleanup() CASCADE;
DELETE FROM _migrations WHERE filename = '064_r32_followups.sql';
```

### 063 — `inventory_adjustments.organization_id` NOT NULL

```sql
-- Drop the NOT NULL + backfilled FK. WARNING: legacy rows that were
-- backfilled with synthesized org_ids will retain them; there's no
-- lossless way to identify which values were backfilled vs real.
ALTER TABLE inventory_adjustments
  ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE inventory_adjustments
  DROP CONSTRAINT IF EXISTS inventory_adjustments_organization_id_fkey;
DELETE FROM _migrations WHERE filename = '063_r32_d6_inventory_adjustments_org_id.sql';
```

### 062 — R32 hashed tokens at rest

```sql
-- Column renames revert. NOTE: this leaves hashed values in the
-- `_hash` → renamed-back column. Any pre-062 email link is already
-- useless (hashed tokens don't round-trip); customers must request
-- new verification/reset emails after rollback.
ALTER TABLE pending_signups RENAME COLUMN verification_token_hash TO verification_token;
ALTER TABLE pending_signups
  DROP CONSTRAINT IF EXISTS pending_signups_verification_token_hash_key;
ALTER TABLE pending_signups
  ADD CONSTRAINT pending_signups_verification_token_key UNIQUE (verification_token);
ALTER TABLE password_resets RENAME COLUMN token_hash TO token;
DROP INDEX IF EXISTS uniq_password_resets_token_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_resets_token ON password_resets(token);
DELETE FROM _migrations WHERE filename = '062_r32_hash_tokens_at_rest.sql';
```

### 061 — R31 schema hardening (audit_events prevent_tamper triggers)

```sql
DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON audit_events;
DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
DROP FUNCTION IF EXISTS audit_events_prevent_tamper() CASCADE;
-- Other 061 changes are additive indexes + unique constraints — safe
-- to drop individually if a specific one blocks rollback; otherwise
-- leave them in place.
DELETE FROM _migrations WHERE filename = '061_r31_schema_hardening.sql';
```

### Older migrations (≤ 060)

If you need to revert further back, prefer a **point-in-time
restore** of the Postgres snapshot rather than hand-crafting reverse
SQL. The bupos primary is on Supabase / Neon, both of which keep
recent snapshots.

## Client-side: invalidate cached content

After any rollback, browsers may hold a stale SW cache. Bump the
`CACHE_NAME` in `public/sw.js` (R34-SW-bump pattern) OR instruct
users to hard-reload the register / admin tabs.

## Post-rollback checklist

- [ ] `/api/health` returns 200 `{status: "ok"}`
- [ ] Smoke test (manually run `node code/scripts/smoke-test.js`
      with prod env vars) passes all four checks
- [ ] Cloudflare Worker logs: no `api_route_error` spike in the last
      5 min
- [ ] Telegram deploy bot has posted success for the rollback commit
- [ ] Post-mortem issue filed with the rolled-back commit sha +
      failure signal
