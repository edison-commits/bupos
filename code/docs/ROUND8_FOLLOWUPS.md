# Round 8 — Follow-up Work

These items were flagged during the round 8 audit but require design
decisions or infrastructure changes that exceeded the scope of the code
cleanup. Each is tracked with the originating finding id so the audit trail
stays linked.

## R8-H-4 — Customer-display device auth

**Status:** noted in-code (`src/app/api/customer-display/route.ts`).

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

**Why deferred:** needs a UX decision on how the display device is
provisioned (pair with POS vs. admin-provisioned), plus a KV-backed
signing-secret store.

## R8-M-11 — Distributed rate limit

**Status:** noted in `src/lib/auth/rate-limit.ts` (existing TODO comment).

**Problem:** the in-memory `Map<string, Window>` rate limiter lives in
isolate memory. Cloudflare spreads requests across ~32 isolates per colo,
so an attacker spraying PIN guesses effectively gets a 32× multiplier on
the rate budget.

**Proposed fix:** back the limiter with Cloudflare Durable Objects (one DO
per org) or KV (increment-with-TTL). For PIN brute-force specifically,
keep a DB-backed `pin_failed_attempts` table keyed on
`(location_id, pin_fingerprint)` with `DELETE ... WHERE attempted_at <
now() - interval '1 hour'` on a scheduled Worker.

**Why deferred:** needs a wrangler.toml change to bind a KV namespace or
DO, plus a pricing/latency decision. The in-memory limiter is a first
gate; PIN and signup paths also have DB-enforced brute-force protections
(PIN: `auth_credentials.failed_attempts` lockout; signup: per-email + per-IP).

## R8-M-12 + R8-L-5 — Signup email verification

**Status:** noted in `src/app/actions/auth.ts`.

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

**Why deferred:** requires Resend template work, a new route
`/api/auth/verify`, and UI on the signup page for the "check your email"
state. The existing IP + email rate-limits (3/hour, 5/5min) slow the
exploit meaningfully in the interim.

## R8-L-11 — Idempotency key TTL cleanup

**Status:** not fixed in code.

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

**Why deferred:** needs a deploy decision (cron vs. Worker + wrangler
trigger). Index sizes are still fine for the current user base.

## R8-L-12 — PG-backed test harness

**Status:** tracked here.

**Problem:** `src/__tests__/*` runs under the JSON store (no `USE_POSTGRES`).
Every round of audit findings in rounds 1–8 has concerned the PG path —
none of which is exercised in CI.

**Proposed fix:** add a `vitest.integration.config.ts` + `docker-compose`
with Supabase local, seed with migrations + a fixture set, and run a
parallel `npm run test:integration` target that sets `USE_POSTGRES=1`.
At minimum add integration coverage for the six cross-tenant UPDATE
paths audited in R8.

**Why deferred:** non-trivial CI infrastructure; outside the scope of a
code-only audit round. Priority if/when the codebase gains contributors
beyond the current owner.
