# Runbook — Alerting + Observability

Closes **R25-ops-M-1**. Every critical error class in prod should
land in an ops channel within minutes, not be discovered on the next
quarterly audit. This doc captures the wired pieces + the one-time
dashboard setup still required.

## What's automatic (already wired)

### 1. Synthetic health probe (5 min)
- **File**: `.github/workflows/synthetic-health.yml`
- **What it does**: hits `https://basicuniformpos.com/api/health`
  every 5 minutes via GitHub Actions cron. Alerts via Telegram on:
  - Non-200 response (DB down, Worker crashed, TLS, DNS)
  - 200 with `rateLimitKv.bindingAvailable = false` (3-layer rate
    limiter silently degraded to 2-layer)
  - Connection failures (origin unreachable)
- **State**: alerts on every failure — during an incident Telegram
  pings every 5 min until resolved. Loud but correct.
- **Override URL**: set repo variable `HEALTH_URL` to point at a
  staging host if desired.
- **Alert channel**: same Telegram bot that sends deploy notifs
  (secret: `TELEGRAM_BOT_TOKEN`, chat: `7547010501`).

### 2. Structured error events
Workers emits single-line JSON for the two classes ops cares about:

| Event | Source | Payload |
|---|---|---|
| `api_route_error` | `src/lib/api/with-auth.ts` catch-all for every `/api/*` 500 | `{reqId, method, path, orgId, employeeId, roleKey, error}` |
| `server_action_error` | `src/app/register/checkout-action.ts` (extend to siblings as needed) | `{reqId, action, orgId, employeeId, registerSessionId, cartId, ...}` |
| `audit_insert_failed` | `src/lib/persistence/postgres-store.ts` `pgInsertAuditEvent` catch | `{orgId, entityType, entityId, eventKind, error}` |

Every log line is JSON → queryable from **Workers → Logs** in the
Cloudflare dashboard (`observability.enabled=true` in wrangler.jsonc).

### 3. `/api/health` + `/api/admin/health` split
- Public minimal (`/api/health`) — liveness + KV binding availability.
  Safe to poll from anywhere; no secrets leaked.
- Admin-gated detailed (`/api/admin/health`) — adds DB latency,
  Postgres version, per-subsystem state. Gated by `audit.view`.

## What's NOT automatic — one-time dashboard setup

### A. Logpush to a queryable sink
Workers Logs UI (above) retains ~7 days. For longer retention +
programmatic querying, set up Logpush.

Options, from cheapest to richest:
1. **Cloudflare R2** — pennies/month, query later via Workers + SQL
   over the object store.
2. **Axiom / Honeycomb** — purpose-built log sinks with alerting.
3. **BigQuery via GCP** — if already using GCP ops stack.

Dashboard steps (Cloudflare → Workers → basicuniformpos → Logs →
Logpush Jobs):
```
1. Create Logpush job
   → Destination: <R2 bucket OR third-party HTTP endpoint>
   → Data set: Workers Trace Events
   → Filter: outcome == "exception" OR $.event IN ("api_route_error","audit_insert_failed","server_action_error")
   → Sampling: 100%
2. Test with a deliberate 500 (e.g., hit a non-existent route with bad auth)
3. Verify events arrive in the sink within 60s
```

### B. Log-based alert on audit_insert_failed
Audit-trail drops are a compliance event. Rule of thumb: if we lose
even ONE audit insert in a 5-minute window, someone pages.

Axiom / Honeycomb setup (one-time, after Logpush is flowing):
```
Query: $.event == "audit_insert_failed"
Trigger: count > 0 over 5m window
Alert: page the on-call
Runbook: check RLS state on audit_events + recent orgId pattern
  (one org repeatedly failing = isolate-specific issue;
   all orgs failing = DB-level issue)
```

### C. Log-based alert on api_route_error rate
For customer-impact signal:
```
Query: $.event == "api_route_error" AND $.path LIKE "/api/auth/%"
Trigger: count > 10 over 15m window
Alert: page on-call
Runbook: auth layer broken — check Supabase + Neon health, rate
  limit KV binding status (GET /api/admin/health), recent
  deploy diff.
```

## Testing the wiring

### Synthetic probe
```bash
# Trigger a manual run
gh workflow run "Synthetic health probe"

# Verify Telegram ping by temporarily pointing HEALTH_URL at a broken URL
# (e.g., via repo variable override)
gh variable set HEALTH_URL --body "https://basicuniformpos.com/api/doesnotexist"
gh workflow run "Synthetic health probe"
# Should ping Telegram + fail the workflow
gh variable delete HEALTH_URL
```

### Structured logs (dev/local)
```bash
cd code
USE_POSTGRES=true DATABASE_URL="postgresql://postgres:postgres@localhost:54329/bupos_test" npm run dev
# In another terminal: trigger a 500 by hitting a bad route
curl -i http://localhost:3000/api/audit  # 401 with x-request-id
# Verify the server log line is JSON
```

## Severity table — what pages vs. what emails

| Event | Pager | Email | Silent |
|---|---|---|---|
| `/api/health` non-200 | ✅ Telegram | | |
| `rateLimitKv.bindingAvailable = false` | ✅ Telegram | | |
| `audit_insert_failed` count > 0 / 5m | ✅ (when Logpush set up) | | |
| `api_route_error` on `/api/auth/*` > 10 / 15m | ✅ (when Logpush set up) | | |
| `api_route_error` on any other route | | ✅ (daily digest) | |
| `server_action_error` | | ✅ (daily digest) | |
| Deploy success | | | ✅ Telegram notif (already wired) |
| Deploy failure | ✅ Telegram | | |

## Known gaps

- No external uptime service (StatusPage, Pingdom) — GitHub Actions
  cron is subject to GHA-availability, so a GHA incident can silence
  our alerts. Low-risk since GHA outages are rare + we still get the
  5-min granularity.
- No per-customer impact signal (e.g., "checkout failures > 5% of
  attempts"). Would require emit of success events not just failures.
  Track as follow-up if compliance / SLA pressure demands it.
- No direct alert on `CUSTOMER_DISPLAY_SECRET` expiry / rotation —
  the display-token code throws in prod if the secret is absent, but
  there's no scheduled "is it going to expire?" probe. If we rotate
  the secret, deploy asserts presence (R25-ops-M-2); no scheduled
  validity check beyond that.
