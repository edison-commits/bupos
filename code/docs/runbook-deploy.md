# Deploy Runbook

## Ordering invariant

**Migrations MUST land before code.** Several R30-R34 migrations rename
columns or add NOT NULL constraints that the new application code
expects. Deploying code first produces an auth outage window; deploying
migrations first is safe (old code still works against the new column
because `RENAME` is atomic + column aliases preserve behavior).

## Standard deploy sequence

```bash
# 1. Connect to prod Postgres
#    (Supabase: `supabase link --project-ref <ref>` or psql with DATABASE_URL)

# 2. Run pending migrations. Supabase CLI:
supabase db push

# Or raw psql, applying each migration in numeric order:
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f" -v ON_ERROR_STOP=1
done

# 3. Verify schema state (sanity spot-checks)
psql "$DATABASE_URL" -c "\d pending_signups" | grep verification_token_hash
psql "$DATABASE_URL" -c "\d inventory_adjustments" | grep organization_id

# 4. Deploy the Worker
npm run deploy
```

## Rollback procedure

See `runbook-rollback.md` for per-migration reverse SQL.

## Duplicate-data remediation

See `runbook-061-duplicates.md` for the SQL queries that identify
`(organization_id, slug)` / `(organization_id, return_number)`
collisions before migration 061 adds the unique indexes.

## Nightly cleanup cron

Migration 065 installs a pg_cron schedule that calls
`run_nightly_cleanup()` at 07:00 UTC daily. Verify it's running:

```sql
SELECT * FROM cron.job WHERE jobname = 'bupos_nightly_cleanup';
SELECT * FROM cron.job_run_details
  WHERE jobname = 'bupos_nightly_cleanup'
  ORDER BY start_time DESC LIMIT 10;
```

If pg_cron is unavailable on your Postgres tier, wire an external
scheduler (Cloudflare Workflow, Supabase Edge Function with CRON,
or a simple GitHub Action) to POST to
`https://your-worker.../api/internal/run-cleanup` with
`Authorization: Bearer $OPS_CLEANUP_SECRET`.

## OPS_CLEANUP_SECRET provisioning

The manual cleanup endpoint requires `OPS_CLEANUP_SECRET` set as a
Wrangler secret:

```bash
# Generate a strong secret
openssl rand -base64 48

# Set on the Worker
wrangler secret put OPS_CLEANUP_SECRET
# (paste the generated value)
```

## Large-table index creation (migration 066 onwards)

Migration 066 adds `idx_transactions_org_loc_created_completed` with a
vanilla `CREATE INDEX`. That works on a small-to-mid `transactions`
table but takes an `AccessExclusive` lock, which blocks INSERTs for
the duration of the build. For production databases with >1M completed
rows, run the equivalent index as `CONCURRENTLY` manually OUTSIDE the
migration:

```sql
-- 1. Disable migration 066 from auto-running (apply 065, then 067+).
--    Verify 066 is NOT in supabase_migrations.schema_migrations.
-- 2. Run this WITHOUT a transaction:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_org_loc_created_completed
  ON transactions (organization_id, location_id, created_at DESC)
  WHERE status = 'completed';

-- 3. After success, manually mark 066 applied:
INSERT INTO supabase_migrations.schema_migrations (version)
  VALUES ('066') ON CONFLICT DO NOTHING;
```

If the index build fails mid-run (rare), drop the invalid leftover:

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'transactions'
  AND indexname = 'idx_transactions_org_loc_created_completed';
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_org_loc_created_completed;
```

## Emergency: cron stopped running

If table sizes start growing faster than expected, pg_cron may be
paused or the job may be disabled. Re-enable:

```sql
SELECT cron.schedule(
  'bupos_nightly_cleanup',
  '0 7 * * *',
  $cron$SELECT public.run_nightly_cleanup();$cron$
);
```

If the return count for any cleanup function indicates zero rows
ever cleared (false-positive "no stale data"), manually invoke:

```sql
SELECT public.cleanup_stale_pending_signups('7 days'::interval);
SELECT public.cleanup_stale_rate_limit_buckets();
SELECT public.cleanup_stale_idempotency_keys('90 days'::interval);
```
