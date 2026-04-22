# Deploy Runbook

## Source of truth: the GitHub Actions workflow

**Prod deploys run automatically on push to `master` via
`.github/workflows/deploy.yml`.** That workflow is authoritative — the
manual steps below are only for out-of-band or DR scenarios. The
workflow does, in order: assert required Worker secrets, apply
pending migrations via a `_migrations` tracker table (idempotent, safe
to re-run), typecheck (R37-M2), build + deploy via
`@opennextjs/cloudflare`, and run a Playwright smoke test against
prod.

## Ordering invariant

**Migrations MUST land before code.** Several R30-R34 migrations rename
columns or add NOT NULL constraints that the new application code
expects. Deploying code first produces an auth outage window; deploying
migrations first is safe (old code still works against the new column
because `RENAME` is atomic + column aliases preserve behavior). The
GH Actions workflow enforces this ordering; manual deploys must
respect it too.

## Out-of-band deploy (manual, emergencies only)

```bash
# 1. Connect to prod Postgres
#    (Supabase: `supabase link --project-ref <ref>` or psql with DATABASE_URL)

# 2. Apply pending migrations using the same tracker the workflow uses.
#    Do NOT run `supabase db push` — we don't use the Supabase migration
#    tracker. This tracker lives in the `_migrations` table.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS _migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );"
for f in $(ls code/supabase/migrations/*.sql | sort); do
  base=$(basename "$f")
  applied=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM _migrations WHERE filename = '$base'")
  if [ "$applied" = "0" ]; then
    echo "→ Applying $base"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
      -c "INSERT INTO _migrations (filename) VALUES ('$base')" >/dev/null
  fi
done

# 3. Verify schema state (sanity spot-checks)
psql "$DATABASE_URL" -c "\d pending_signups" | grep verification_token_hash
psql "$DATABASE_URL" -c "\d inventory_adjustments" | grep organization_id
psql "$DATABASE_URL" -c "\d transactions" | grep idx_transactions_org_loc_created_completed

# 4. Deploy the Worker (uses @opennextjs/cloudflare under the hood)
cd code && npm run deploy
```

## Expected client-error 400s after a R35-R36 deploy

Three endpoints now require step-up (re-entry of the actor's password):
- `POST /api/gift-cards {action:'disable'}` — `gift-card-disable-stepup`
- `POST /api/email-receipt?override=true` — `email-receipt-override-stepup`
- `PUT /api/customers` when `is_active` OR `notes` is CHANGED (R37-H1
  now compares old↔new; mere presence of the field no longer gates)

Until admin client UIs wire in a password prompt for each, the
endpoints will return 400 "Your password is required to perform this
action." Telegram alerting (see `runbook-alerting.md`) should treat a
flood of these specific 400s as a deploy-caused UI regression, not a
novel outage. The `api_route_client_error` event (R37-M1) emits a
`stepUpBucket` field to make this correlation trivial.

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
