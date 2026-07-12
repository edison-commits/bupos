# Round 8 — Follow-up Work

These items were flagged during the round 8 audit but required design
decisions or infrastructure changes that exceeded that round's code cleanup.
This file now acts as a historical handoff: resolved items point to the
current implementation evidence, while the one still-open infrastructure
decision remains clearly marked.

## R8-H-4 — Customer-display device auth

**Status:** resolved. Current implementation lives in
`src/lib/auth/display-token.ts` and is exercised through the
customer-display API contract tests.

**Problem:** the display polling path requires the register session cookie,
which is tied to the cashier's POS. Retail deployments that run the
customer-facing display as a physically separate device cannot carry that
cookie.

**Proposed fix:** introduce a short-lived, HMAC-signed `display_token`.
The `POST /api/customer-display` call returns a token derived from
`HMAC(secret, register_session_id || expiry)`; the customer display GETs
`/api/customer-display?registerSessionId=…&token=…` and the handler
validates the signature + expiry instead of demanding the register cookie.
Rotate the secret per org; embed in the display URL QR code.

**Resolution evidence:** `mintDisplayToken()` issues a short-lived
HMAC-signed token and `verifyDisplayToken()` validates it for
`GET /api/customer-display?registerSessionId=…&displayToken=…` without the
cashier cookie. Production/Workers require `CUSTOMER_DISPLAY_SECRET`; dev
fallbacks are explicitly non-production.

## R8-M-11 — Distributed rate limit

**Status:** resolved for the currently deployed auth paths. The historical
in-memory-only note is stale: the app now layers per-isolate memory,
Cloudflare KV, and Postgres-backed rate-limit buckets for high-risk auth
surfaces.

**Problem:** the in-memory `Map<string, Window>` rate limiter lives in
isolate memory. Cloudflare spreads requests across ~32 isolates per colo,
so an attacker spraying PIN guesses effectively gets a 32× multiplier on
the rate budget.

**Resolution evidence:**

- `wrangler.jsonc` binds `RATE_LIMIT_KV` for cross-isolate buckets.
- `src/lib/auth/kv-rate-limit.ts` implements the KV layer and documents its
  fail-open behavior.
- `supabase/migrations/050_rate_limit_buckets.sql` adds the Postgres bucket
  table/RPC used by `src/lib/auth/db-rate-limit.ts`.
- `src/lib/auth/register-pin-rate-limit.ts` runs the shared six-layer PIN
  gate for both the HTTP route and Server Action: in-memory per-PIN,
  in-memory per-location, in-memory per-IP/location, KV per-PIN, DB
  per-PIN, and DB per-IP/location.
- Customer self-signup routes also assert the memory/KV/DB layers in
  contract and route tests.

**Remaining ops note:** KV is eventually consistent and both KV/DB helpers
fail open on binding or database errors, so production monitoring should
keep watching `/api/health` `rateLimitKv.bindingAvailable` and structured
`rate_limited` logs. If a future non-auth high-throughput endpoint needs
strict distributed throttling, revisit Durable Objects separately rather
than treating this R8 auth finding as open.

## R8-M-12 + R8-L-5 — Signup email verification

**Status:** resolved. Implemented with pending signups, verification email,
and a verification route/RPC path.

**Problem:** signup creates `organization + location + employee +
auth_credentials` immediately and signs the user in. No email verification
— any attacker cycling disposable emails can mint orgs, inflating the
pin-collision scan cost during register login. The "email already exists"
error (vs. a generic success) also confirms account registration to
unauthenticated callers (account enumeration).

**Proposed fix:** add a `pending_signups` table. On POST:
1. Write `pending_signups (email, hash(password), verification_token,
   expires_at)` — no org/employee yet.
2. Send a Resend verification email with a signed link.
3. On click, create org + employee inside a transaction and sign them in.
4. On duplicate email, return the generic "If that email isn't already
   registered, we've sent a verification email" response — enumeration-proof.

**Resolution evidence:** `supabase/migrations/049_pending_signups.sql`
adds the pending-signup table/cleanup function; signup paths call
`sendVerificationEmail()`; `/api/auth/verify` is covered by the auth/session
helper path. Later rounds also added case-insensitive uniqueness,
expired-row cleanup before INSERT, generic responses, timing equalization,
and production Resend fail-closed behavior.

## R8-L-11 — Idempotency key TTL cleanup

**Status:** resolved.

**Problem:** `idempotency_key` columns on `returns` and `shifts`
accumulate forever. After a year of daily use that's ~365k rows per
store; each lookup walks an ever-growing unique index.

**Proposed fix:** either a `pg_cron` job (if the DB has the extension
enabled — Neon does) or a scheduled Cloudflare Worker:

```sql
DELETE FROM returns WHERE idempotency_key IS NOT NULL
  AND created_at < now() - interval '90 days';
DELETE FROM shifts WHERE idempotency_key IS NOT NULL
  AND closed_at IS NOT NULL AND closed_at < now() - interval '90 days';
```

**Resolution evidence:** `supabase/migrations/048_idempotency_key_cleanup.sql`
adds `cleanup_stale_idempotency_keys(interval)` and
`supabase/migrations/053_idempotency_cleanup_atomic.sql` hardens per-table
cleanup to fail visibly with per-table context. Deployment runbook examples
include `SELECT public.cleanup_stale_idempotency_keys('90 days'::interval);`.

## R8-L-12 — PG-backed test harness

**Status:** resolved for the first PG-backed integration harness.

**Problem:** `src/__tests__/*` runs under the JSON store (no `USE_POSTGRES`).
Every round of audit findings in rounds 1–8 has concerned the PG path —
none of which is exercised in CI.

**Proposed fix:** add a `vitest.integration.config.ts` + `docker-compose`
with Supabase local, seed with migrations + a fixture set, and run a
parallel `npm run test:integration` target that sets `USE_POSTGRES=1`.
At minimum add integration coverage for the six cross-tenant UPDATE
paths audited in R8.

**Resolution evidence:** `vitest.integration.config.ts` scopes
`src/__tests__/integration/**/*.test.ts`, `package.json` exposes
`npm run test:integration`, and Docker helper scripts (`docker:up`,
`docker:migrate`, `docker:down`) document the required local Postgres setup.
