# Known Issues — Central Tracker

Every item flagged by an audit round but NOT fixed in the same round lives
here. Each has an **acceptance criterion** so it's clear when the item can
be struck. Close items by deleting the section.

The point of this file: stop losing track of "documented but deferred" issues.
Five audit rounds in a row flagged inactive-customer-filter; it kept being
forgotten because there was no single place to see it. Same for layaway
refund flow, display device auth, etc.

Open an issue OR leave the entry here with a target milestone. Prune as
each one ships.

---

## Open

_(All formerly-open items closed — see the CLOSED section below.)_

### `R21 closures`

- **R21-C-1 + R21-H-4**: `migration 051` adds case-insensitive unique
  indexes on `auth_credentials(lower(email))` +
  `pending_signups(lower(email))`, plus per-org unique indexes on
  `product_variants(organization_id, sku)` and
  `product_variants(organization_id, barcode)` (partial: `is_active AND
  barcode IS NOT NULL AND barcode <> ''`). Raise-on-duplicates DO blocks
  block the migration if pre-existing dupes are present so the
  operator can reconcile manually before re-running.
- **R21-H-3**: `migration 052` pins `search_path = public` on every
  SECURITY DEFINER function in public.* (12 functions across migrations
  040/048/049/050). Includes a DO-block verification that enumerates
  any SECURITY DEFINER function lacking `SET search_path` and fails the
  migration — future drift will be caught here.
- **R21-H-1 + R21-M-5**: `cross-tenant.test.ts` rewritten — the cross-
  tenant INSERT tests now supply every NOT-NULL column and assert
  `err.code === '42501'` (insufficient_privilege, RLS rejection). Each
  cross-tenant case is paired with a same-tenant control. FORCE RLS
  check asserts the expected table count first so a rename wouldn't
  silently pass. New suite verifies every SECURITY DEFINER function in
  `public.*` has `search_path` pinned.
- **R21-H-6**: `signupAction` equalizes timing between taken and
  untaken email paths. Both branches now do one DB roundtrip and a
  MIN_DURATION_MS (500ms) floor pads the wall-clock latency. Concurrent
  signup for the same email catches `23505` from the new unique index
  and returns the generic response.
- **R21-H-2**: `safeErr` codemod widened to cover `src/lib/**`,
  `src/app/actions`, `src/app/signup`. Fixed in-place: `with-auth.ts`
  (wrapAdminAuth + wrapDualAuth catch-alls), `postgres-store.ts`
  (audit-failure path), `register-config.ts`, `use-online-status.ts`,
  `offline-sync/route.ts`, `actions/auth.ts` audit catch, `signup/error.tsx`.
  New CI guardrail `scripts/check-no-raw-err-log.mjs` fails the build on
  any `console.(error|warn)(label, err)` site that slips in without
  `safeErr(err)`. Wired into `npm run check:all` as `check:logs`.
- **R21-H-5**: `verifyDisplayToken` reorders to always compute HMAC
  before the expiry comparison — closes the expired-vs-invalid timing
  oracle.
- **R21-M-1**: Layaway store-credit refund now aborts with a clear
  error when the customer row is missing at refund time (previously
  silently wrote a ledger entry against a dangling customer_id).
- **R21-M-2**: Barcode-save rate limit scoped to `orgId:employeeId`
  with a bulk-workable quota (60/min) so one onboarding employee can't
  lock out the whole org.
- **R21-M-3**: KV rate-limit binding exposes `getKvBindingDiagnostics()`
  and emits a one-shot `console.warn` at prod cold-start if the
  `RATE_LIMIT_KV` binding is absent. `/api/health` surfaces the
  `rateLimitKv` status so ops dashboards can alert on silent fail-open.
- **R21-M-4**: `/api/auth/verify` cleans up orphan `sessions` rows
  when the cookie-set path throws after the session INSERT committed.
- **R21-L-1**: `simulate-month.mjs` header documents explicitly that
  the simulator runs as BYPASSRLS superuser and does NOT test RLS —
  see `cross-tenant.test.ts` for that coverage.
- **R21-L-2**: `seed.sql` adds TRUNCATEs for `pending_signups`,
  `rate_limit_buckets`, and (conditionally) `time_clock_entries`.
- **R21-L-3**: `/api/auth/verify` scrubs `password_hash` from the
  closure object immediately after INSERT so it can't travel into outer
  catch scopes.
- **R21-L-4**: Unknown-IP signup bucket now gets a per-request random
  UUID suffix instead of the shared `signup-ip:unknown` bucket that
  cross-collided across all non-CF callers.
- **R21-L-5**: `cleanup_stale_idempotency_keys` (migration 053)
  wraps each per-table UPDATE in a BEGIN/EXCEPTION subtransaction with
  per-table error context so a failure mid-function is a single visible
  failure point, not a silent partial cleanup.

### `R22 closures` — regressions introduced by R21 itself

- **R22-H-1**: `signupAction` deletes expired `pending_signups` rows
  for the same email before INSERT. The new `uniq_pending_signups_email_lower`
  unique index from migration 051 covers ALL rows including expired
  ones, but the `alreadyTaken` check only excluded unexpired rows. A
  user who abandoned a prior signup would be silently blocked for up
  to 7 days (cleanup retention) on retry — INSERT fired, 23505 caught
  silently, no verification email sent.
- **R22-H-2**: `signupAction` refuses signups in prod when neither
  `cf-connecting-ip` nor `x-forwarded-for` is present. Prior shape
  (R21-L-4) randomized the bucket with a per-request UUID which
  eliminated DoS but bypassed the rate limit entirely when headers
  were stripped (e.g., direct workers.dev URL). Dev / test still fall
  back to randomized bucket.
- **R22-H-4**: `kv-rate-limit.ts` no longer carries a module-level
  mutable `_kvDiagnostics` object. The prior shape overwrote
  `lastLookupError` on every call, and `/api/health` returned that
  state — leaking per-tenant KV error detail across requests on shared
  Workers isolates. New `probeKvBinding()` returns a per-call probe
  scoped to THIS request. Only `_warnedProdFailOpenOnce` remains as a
  one-shot log-dedup flag (benign race). ESLint allowlist updated.
- **R22-H-3**: `/api/auth/verify` no longer double-releases the pg
  client on the 23505 path. Uses a local `emailAlreadyRegistered`
  flag and returns after the single `finally` release.
- **R22-M-3**: Orphan session DELETE + audit INSERT in
  `/api/auth/verify` now route through `waitUntilOrAwait()` helper
  (`src/lib/runtime/wait-until.ts`). On Workers the promise is
  registered with `ctx.waitUntil`; in dev / tests it's awaited
  synchronously. Prior fire-and-forget `pool.query(...).catch(...)`
  was silently cancelled by the `no_handle_cross_request_promise_resolution`
  compat flag.
- **R22-M-2**: `/api/health` uses new `probeKvBinding()` which does
  zero KV I/O (binding resolution only). Prior shape wrote one KV
  PUT per request with a never-reused `health-probe:${Date.now()}`
  key, burning write quota and polluting the namespace forever.
- **R22-M-1**: `pgCreateVariant` + `pgUpdateVariant` catch 23505 on
  `uniq_product_variants_org_{sku,barcode}_active` and throw a typed
  `VariantUniquenessConflictError`. `createProductAction` +
  `editVariantAction` translate the error into a user-friendly
  redirect. Reactivating or renaming a variant into a SKU/barcode
  now used by another active variant shows "Another active variant
  already uses this SKU" instead of a 500.
- **R22-M-4**: `expectRlsRejection` in `cross-tenant.test.ts` no
  longer conflates "got success" with "got wrong SQLSTATE". Tracks
  the thrown error separately so each branch emits a clear message.
- **R22-L-1**: `check-no-raw-err-log.mjs` rewritten with a balanced-
  paren walker instead of regex. Covers `console.*`, `logger.*`,
  `log.*` call sites. Parses strings + template literals + nested
  calls correctly — templates like `\`foo ${fn(x)}\`, err` are now
  detected. Widened catch-ident list to match repo conventions.
- **R22-L-2**: Migration 051 dedup DELETE uses composite
  `(created_at, id) < (created_at, id)` ordering so tied timestamps
  at ms resolution still pick a deterministic "keep" row and don't
  leave dupes for the subsequent CREATE UNIQUE INDEX to trip on.

### `R23 closures` — regressions from R22's fixes

- **R23-C-1**: `check-no-raw-err-log.mjs` `parseCall` loop started at
  `i = start` (pointing AT the `(`), double-counting the outer paren
  → the function returned null for EVERY call site and the
  "balanced-paren" guardrail flagged zero offenders. Fixed: loop
  starts at `i = start + 1`, and a `selfTest()` block at the top of
  the script asserts the parser catches representative good + bad
  patterns BEFORE the real scan runs. Self-test exit code 2
  distinguishes "guardrail broken" from "offenders found" (exit 1).
  Also now tracks `{`, `[` depth — commas inside object literals no
  longer split top-level args. With the parser working, the scan
  found 3 real offenders in `src/app/admin/receiving/page.tsx`
  (all fixed in-place).
- **R23-C-2**: `check:logs` was never wired into `guardrails.yml` or
  `.husky/pre-commit`. Fixed by adding a "No-raw-err-log check"
  step to the CI matrix and invoking the script from pre-commit.
- **R23-H-1**: `waitUntilOrAwait` invoked `wu(promise)` as a
  detached function — Cloudflare's `ExecutionContext.waitUntil` is a
  C++ host binding that requires `this === ctx`, so the call threw
  "Illegal invocation" on every prod request, the catch swallowed it
  silently, and the helper fell through to synchronous await. R22-M-3
  accomplished nothing on Workers. Fixed: invoke as a method
  (`execCtx.waitUntil(promise)`) so the binding is preserved.
- **R23-H-2**: `createProductAction` inserted `products.default_variant_id
  = variantId` before the variant existed. The FK
  `fk_products_default_variant_id` is NOT DEFERRABLE, so every call
  `23503`'d. Pre-existing bug predating R22 — empirically verified
  against test DB. Fixed: pass `defaultVariantId: undefined` to
  `pgCreateProduct`, create the variant + inventory, then
  `pgUpdateProduct` to set `defaultVariantId`. If variant insert
  throws `VariantUniquenessConflictError`, the catch now cleans up
  the orphan product row via `pgDeleteProduct` before redirecting.
- **R23-H-3 + R23-L-3**: `/api/health` (public, unauthenticated) now
  returns only `{status, rateLimitKv.bindingAvailable}` — no error
  strings, no sub-subsystem detail. Detailed diagnostics (latency,
  pg version, raw KV lookup error) moved to new `/api/admin/health`
  behind `audit.view` permission. Both endpoints send
  `Cache-Control: no-store, private, max-age=0` so a misconfigured
  CDN can't cache the response.
- **R23-M-1**: `waitUntilOrAwait` now gates its fallback-logging
  behind one-shot module-level flags (`_warnedNoOpenNext`,
  `_warnedNoWaitUntil`). Dev/tests no longer emit a 400-char warn on
  every call.
- **R23-M-2**: `VariantUniquenessConflictError` detection now
  exact-matches the two known constraint names
  (`uniq_product_variants_org_sku_active`,
  `uniq_product_variants_org_barcode_active`) and re-throws anything
  else — so a PK collision or future new unique index no longer
  surfaces as the misleading "Another active variant already uses
  this SKU or barcode" message. The `field = "both"` case is gone;
  type is strictly `"sku" | "barcode"`.
- **R23-M-3**: `signupAction` DELETE-expired + INSERT now run in a
  single transaction (`BEGIN; DELETE expired; INSERT; COMMIT`). The
  attacker-races-victim 24-hour DoS window is closed — the delete
  and insert are atomic, so a concurrent signup for Alice's
  just-expired email either beats ours via 23505 (generic response
  to attacker) or loses and rolls back. Alice can always retry
  because Alice's request does its own atomic sequence.
- **R23-M-4**: `__resetKvDiagnosticsForTest` removed — was exported
  with zero callers.
- **R23-L-1**: Scanner's `normalizeExprForIdent` strips `as Type`,
  `satisfies Type`, trailing `!`, surrounding parens before running
  the identifier regex. Shorthand-object `{ err }` also detected.
- **R23-L-2**: `@opennextjs/cloudflare` module resolution cached at
  module scope (single Promise) in both `kv-rate-limit.ts` and
  `wait-until.ts`. Cold-start resolves once per isolate.

---

## Prevention infrastructure (post-R23)

After R23 found that R22 shipped two placebo guardrails (parser flagged
zero sites; `check:logs` not wired into CI), we added five
infrastructure pieces so the same shape can't happen again:

### Self-test for every guardrail
Every `scripts/check-*.mjs` now has either an inline `selfTest()`
block OR a sibling `-selftest.mjs` runner composed into the npm
script. Each self-test feeds the detector a known-good fixture and a
known-bad fixture, asserts correct output, and exits 2 (distinct
from exit 1 = real offenders) if the detector is broken.

Implementations:
- `check-no-raw-err-log.mjs`: inline selfTest() with 15+ MUST_FLAG + 7
  MUST_NOT_FLAG fixtures. Caught an actual regex-detection gap
  (newline-before-.query) during rollout.
- `check-no-raw-pool-query.mjs`: inline selfTest() with 8 cases
  including block comments, arrows, multiline.
- `check-schema-drift-selftest.mjs`: sidecar runner, two tmpdir
  fixtures (clean migrations + source, and drifted migrations +
  source with a column only the code references).
- `check-rls-force-matching-selftest.mjs`: sidecar runner, two
  tmpdir fixtures (ENABLE+FORCE clean vs. ENABLE without FORCE).

### Meta-check #1: CI-wiring
`scripts/check-ci-wiring.mjs` parses `package.json` for every
`check:*` script and asserts each one appears in
`.github/workflows/guardrails.yml` as a `npm run` step. Would have
caught R23-C-2 (the `check:logs` npm script existed but was never
invoked from CI).

### Meta-check #2: self-test coverage
`scripts/check-selftest-coverage.mjs` enforces that every
`scripts/check-*.mjs` HAS a self-test (inline or sidecar). Prevents
adding a new guardrail without the proof-of-function.

### Workers-runtime smoke tests
`src/__tests__/runtime/workers-runtime.test.ts` runs 8 tests against
a mocked `@opennextjs/cloudflare`:
- `waitUntilOrAwait` invokes `ExecutionContext.waitUntil` as a METHOD
  (detached-call regression throws "Illegal invocation" — empirically
  verified by temporarily reverting R23-H-1).
- Fallback path works when no ExecutionContext / no OpenNext module.
- `probeKvBinding` reflects binding presence/absence correctly.
- `checkKvRateLimit` increments + denies correctly; fails open on
  absent binding.

### Concurrent race-fuzz integration tests
`src/__tests__/integration/race-fuzz.test.ts` spawns 5-10 concurrent
INSERT attempts against the same logical resource (email, SKU,
variant) and asserts exactly one succeeds + the rest see 23505.
Covers:
- `pending_signups` same-email race (R21-C-1 / R22-H-1 / R23-M-3).
- `pending_signups` atomic DELETE+INSERT replacement of expired row.
- `product_variants` same-SKU race (R21-H-4).
- `product_variants` partial-index: deactivated row doesn't block new
  active variant (R22-M-1 / R23-M-2 regression gate).
- `auth_credentials` same-email across different employees
  (R22-C-1).

### End-to-end admin flows
- `src/__tests__/integration/admin-product-creation.test.ts`:
  exercises the 3-step product-creation sequence (null default →
  variant → update) at the SQL level, plus a regression test that the
  BROKEN single-INSERT pattern still raises 23503, plus a meta-check
  that `fk_products_default_variant_id` is still present and not
  DEFERRABLE. Catches R23-H-2 at SQL level.
- `e2e/` + `playwright.config.ts` + `e2e/admin-product-creation.spec.ts`:
  Playwright scaffolding in place. Currently blocked on
  `@neondatabase/serverless` being WebSocket-only and unable to talk
  to plain Docker Postgres. Activating this test requires either (a)
  switching `src/lib/db/` to detect localhost and use `pg` instead,
  or (b) pointing at a Neon-compatible dev DB. `npm run test:e2e`
  runs it once unblocked.

### Wiring
All new checks + tests are invoked from:
- `npm run check:all` — lint + typecheck + check:{schema,rls,pool,logs,ci-wiring,selftest-coverage}
- `.github/workflows/guardrails.yml` — every `check:*` + `test:runtime`
  + `test:adversarial` in the `check` job; `test:integration`
  (cross-tenant + race-fuzz + admin-product-creation) in the
  `integration` job with the postgres service container; Playwright
  e2e in its own `playwright` job.
- `.github/workflows/pre-merge-audit.yml` — adversarial agent audit
  on every PR (requires ANTHROPIC_API_KEY secret; skips cleanly if
  absent).
- `.husky/pre-commit` — schema drift + raw-err log + lint on staged
  files.

---

## Infrastructure unblocks (R24)

### db/index.ts: dynamic driver selection
The app previously used `@neondatabase/serverless` exclusively.
That driver is WebSocket-only and cannot talk to plain Docker
Postgres over TCP, which blocked:
- local `next dev` against Docker (developers resorted to pointing
  at a live Supabase dev DB)
- the Playwright e2e suite (scaffolded in R23 but couldn't actually
  run)
- any future integration tests that want to exercise the app code
  instead of raw SQL

R24 refactored `src/lib/db/index.ts` to detect `localhost` /
`127.0.0.1` connection strings and dynamically import `pg` instead
of `@neondatabase/serverless`. Both drivers expose `.query`,
`.connect`, `.end` with compatible signatures. The refactor:
- Kept `export const pool` as a backward-compat proxy so existing
  consumers (postgres-store.ts, postgres-phase3.ts) didn't change.
- Cached the driver resolution at module scope so cold-start pays
  the import cost once per isolate.
- Preserved the remote-per-call pool shape from the Neon driver
  for prod Workers.

### Playwright e2e suite running
With the db refactor in place, `npm run test:e2e` now runs against
Docker Postgres. The one E2E spec covers R23-H-2 (admin product
creation end-to-end: login → navigate → fill form → submit →
assert product in DB). Full flow completes in ~3-5s per run. CI
job added in a separate `playwright` job in `guardrails.yml`.

### Adversarial fixture corpus
New directory `src/__tests__/adversarial/` with one test file per
closed CRITICAL/HIGH finding. Initial corpus covers:
- **R21-H-5** display-token HMAC-before-expiry ordering (5 tests)
- **R22-H-2** signup refuses no-CF-headers in prod (2 tests)
- **R22-H-3** verify-route single-release invariant on 23505 path (1 test)
- **R22-M-1** orphan product cleanup on variant uniqueness conflict (1 test)
- **R23-L-3** /api/health public response scrubbing + Cache-Control (3 tests)

12 tests total. Each reproduces the exact attack/scenario from the
finding and asserts the fix holds. Goal: add a test for every new
CRITICAL+HIGH finding going forward, so "this class of bug shipped
before" becomes "this class of bug stays permanently gated".

### Pre-merge adversarial audit
`scripts/pre-merge-audit.mjs` assembles a Claude-ready prompt from:
- the diff against `origin/main`
- the changed-files list
- the last 3 rounds of closure notes from KNOWN_ISSUES.md

Two modes: `--print` dumps the prompt to stdout (zero cost), or
default mode calls the Anthropic Messages API and exits 1 on any
CRITICAL/HIGH findings. `.github/workflows/pre-merge-audit.yml`
runs it on every PR, posts findings as a PR comment, fails the
check on gating severity. Skips cleanly if `ANTHROPIC_API_KEY` not
configured.

### CI matrix (post-R24)
| Job | What it runs | Trigger |
|---|---|---|
| `check` | lint + typecheck + 6 check:* + test:runtime + test:adversarial | PR + push to main |
| `integration` | cross-tenant + race-fuzz + admin-product-creation (Docker postgres) | PR + push to main |
| `playwright` | 1 spec: admin product creation (Docker postgres + next dev) | PR + push to main |
| `pre-merge-audit` | Adversarial agent on the diff | PR (if key configured) |

### `R24 closures` — regressions in the prevention infra itself

- **R24-H-1**: Playwright webServer timeout bumped 120s → 180s;
  `initOpenNextCloudflareForDev()` called in `next.config.ts` so the
  Cloudflare context is primed at dev-server load instead of during
  the first route handler.
- **R24-H-2 + R24-M-4**: `src/lib/db/index.ts` rewritten so that on
  remote the `pool` proxy's `.query` / `.connect` ALSO go through
  per-call pools (matching the long-documented "no connection crosses
  requests" contract). Env detection (`readConnectionInfo`) runs
  inside `loadPoolCtor` so tests that set `DATABASE_URL` after module
  load get the correct driver.
- **R24-H-3**: `scripts/pre-merge-audit.mjs` hardened against four
  silent-pass shapes:
  - `BASE_REF` validated via `git rev-parse --verify`; invalid ref
    exits 2 ("audit inputs broken").
  - Empty diff with `>0` changed files exits 2; empty diff with 0
    changed files exits 0 ("nothing to audit").
  - Diff content runs through `escapeFenceBreakers` so backticks in
    the diff can't collapse the outer ```` ```diff ```` fence.
  - JSON extraction tries fenced-block, start-anchored, key-anchored,
    and greedy strategies in order; any failure exits 2 with the
    full response for debugging.
  - Truncation at 150kB is now a `console.warn`, not silent.
- **R24-M-1**: `check-ci-wiring.mjs` uses `.matchAll()` instead of
  `.match()` on composed `check:*` scripts, and treats `npm run
  check:all` as covering every component it composes.
- **R24-M-2**: `check-selftest-coverage.mjs` duplicate sidecar entry
  removed; `.ts` / `.js` extensions now surface a "wrongExt" error
  ("CI invokes via `node scripts/*.mjs`") instead of silently
  skipping.
- **R24-M-3**: single `shouldUseSecureCookie()` helper in
  `src/lib/auth/session.ts` replaces 6 inconsistent
  `secure: ...` cookie settings (4 hardcoded `true`, 2 conditional
  NODE_ENV). Verify route mirrors the same logic. Server-action
  login paths now work on HTTP dev without weakening prod.
- **R24-M-5**: `check-no-raw-pool-query.mjs` widened to cover
  `src/lib/persistence/**` with allowlist entries for the three
  existing files. New advisory tool
  `scripts/audit-persistence-org-filter.mjs` (`npm run
  audit:persistence`) reports persistence queries lacking an
  inline `organization_id` filter — exits 0 since many legitimate
  shapes are FK- or context-scoped; intended for periodic spot-audit.
- **R24-M-6**: all 34 fire-and-forget `pgInsertAuditEvent(...).catch(...)`
  sites across 19 files wrapped in `waitUntilOrAwait(...)` via
  `scripts/codemod-waituntil-audits.mjs`. Prior shape was silently
  cancelled by the `no_handle_cross_request_promise_resolution`
  compat flag on Workers, meaning failed-login / admin-action /
  cart-layaway audit writes never landed in prod.
- **R24-L-1**: `src/__tests__/runtime/workers-runtime.test.ts`
  `beforeEach` now calls `vi.resetModules()` so `wait-until.ts`'s
  one-shot warn flags don't leak across tests.
- **R24-L-2**: `CATCH_IDENT_NAMES` extracted to a single array in
  `check-no-raw-err-log.mjs`; both the ident-regex and the shorthand-
  property regex derive from it. Generic `xxxErr` / `xxxError`
  trailing-name fallback added so future binding names don't require
  an edit.
- **R24-L-3**: `FakeKvNamespace.get` honors the `type` parameter
  (`"text"` returns raw string, `"json"` parses, default matches
  KV's put-via-JSON-stringify round-trip).
- **R24-L-4**: README.md expanded with onboarding — test-suite map,
  Docker setup, Playwright install, guardrail exit-code semantics,
  and "adding a regression test" convention.
- **R24-L-5**: dead "flattened context" fallback in
  `wait-until.ts:execCtx` removed — no released `@opennextjs/cloudflare`
  version flattens the shape; the branch was pure dead code.

### `distributed rate limit — KV/DO migration` — resolved via Cloudflare KV
**CLOSED R8-M-11.** Three-layer limiter in place:
1. In-memory (`@/lib/auth/rate-limit`) — catches per-isolate bursts, 0ms.
2. **Cloudflare KV** (`@/lib/auth/kv-rate-limit`) — cross-isolate
   coherence, ~10ms per check. Namespace `bupos-rate-limit`
   (id `76763261c53b421591bb6e281bb42c48`) bound in `wrangler.jsonc` as
   `RATE_LIMIT_KV`. Fails open when the binding is absent (dev / tests).
3. DB-backed (`@/lib/auth/db-rate-limit` + migration 050) — strongly
   consistent, ~30-100ms. Wired as the last-resort gate on the highest-
   value endpoint (`/api/auth/register-login`).
Admin login + signup + register-login all three layers; other auth-
adjacent endpoints can adopt the KV layer as-needed by importing
`checkKvRateLimit`.

### `PG-backed test harness` — resolved via docker-compose + vitest integration suite
**CLOSED R8-L-12.**
- `docker-compose.yml` — plain Postgres 17 (matches prod Supabase engine).
- `scripts/docker-migrate.sh` — creates the Supabase compatibility roles
  (`anon`, `authenticated`, `service_role`) + an `app_user` test role
  (non-superuser so RLS + FORCE RLS actually evaluate) and applies every
  migration in `supabase/migrations/*.sql` via a tracker table (same
  pattern as the prod deploy.yml).
- `src/__tests__/integration/seed.sql` — 2 orgs × owner+manager+cashier
  + location + customer + product + variant + inventory.
- `src/__tests__/integration/cross-tenant.test.ts` — 11 baseline tests
  covering the R8 cross-tenant UPDATE grid + INSERT-with-WITH-CHECK
  regressions + FORCE-RLS invariants.
- `npm run docker:up / docker:migrate / test:integration` — the three-
  command local workflow.
- `.github/workflows/guardrails.yml` — new `integration` job that spins
  up a Postgres 17 service container, applies migrations, and runs the
  suite on every PR. Locally verified: all 11 tests pass (6 cross-tenant
  UPDATEs blocked, 2 cross-tenant INSERTs rejected by WITH CHECK, 2
  same-tenant controls, 1 FORCE-RLS regression).

Fresh-DB bootstrap bugs surfaced + fixed along the way:
- Migration 001 had `product_modifier_groups` FK-referencing `products`
  BEFORE `products` was declared; reordered.
- Migration 008 + 022 tried to index `shifts.organization_id` before it
  existed (column added in 024); guarded with `information_schema` checks.

### `layaway refund on cancel` — resolved via disposition arg
**CLOSED R10-M-1 / R11-M-1.** `cancelLayawayAction` takes a required
`LayawayCancelDisposition` — `"refund_cash" | "refund_store_credit" |
"forfeit_with_approval"`. Each routes to the matching ledger atomically
in the same transaction as the status flip. Admin UI wires a disposition
dropdown before the Confirm cancel button. Forfeit requires owner role.

### `customer-display device auth` — resolved via HMAC token
**CLOSED R8-H-4.** `/api/customer-display` POST now mints a short-lived
HMAC-signed `displayToken` (15-min TTL) via
`src/lib/auth/display-token.ts`. GET accepts either the cookie (same-
browser iframe path) OR `?displayToken=...` (physically separate device
path). Secret lives in `CUSTOMER_DISPLAY_SECRET` env var; dev falls back
to a deterministic derivation of `DATABASE_URL`. Token rotates on every
POST.

### `signup email verification` — resolved via pending_signups + Resend
**CLOSED R8-M-12 / R8-L-5.** Migration 049 adds the `pending_signups`
table. `signupAction` now writes only to `pending_signups` + sends a
Resend email (with dev-fallback console logging). `/api/auth/verify?
token=...` consumes the row, atomically creates org + location +
employee + credential, and mints an admin session. `signupAction` always
returns the same generic "check your inbox" response whether or not the
email is taken — closes the enumeration oracle. Scheduled cleanup
function `cleanup_stale_pending_signups` prunes expired rows.

### `idempotency key TTL cleanup` — resolved via migration 048
**CLOSED R8-L-11.** Migration 048 adds
`cleanup_stale_idempotency_keys(interval)` RPC — NULL-clears stale
`idempotency_key` across transactions / returns / transfers / shifts.
Invoke weekly via Cloudflare Cron Trigger or Supabase Scheduled Job:
`SELECT * FROM cleanup_stale_idempotency_keys('90 days'::interval);`
Returns per-table row counts for telemetry.

### `admin barcode-lookup POST save path` — resolved
**CLOSED R11-L-1.** `/api/barcode-lookup` POST added — atomically
creates product + variant + inventory_level in one `orgTx`. Verifies
`category_id` belongs to caller's org; catches `23505` on product slug
or variant SKU/barcode collisions with 409. Client component at
`src/components/admin/barcode-lookup.tsx` unchanged — it was already
POSTing to this endpoint expecting the handler.

### `console.error(err) raw-err leaks` — resolved via safeErr codemod
**CLOSED R19-INFO-2.** `scripts/codemod-safe-err.mjs` swept 121 sites
across 49 files. Every `console.error("label", err)` in
`src/app/{api,admin,register}/**` is now `console.error("label",
safeErr(err))`, importing from `@/lib/logging/safe-err`.

### `reports use UTC day boundaries` — resolved via buildOrgDayRange
**CLOSED R16-L-2.** New helper `src/lib/reports/day-range.ts` computes
timestamptz boundaries via `$1::date AT TIME ZONE org_timezone`.
Applied to `/api/reports` (7 helpers) and `/api/shift-report`. Predicates
switched from `created_at <= $N` (inclusive upper) to `< $N` (exclusive
upper, matching `[from, to+1day)` semantics).

### `auth + register RPCs missing CREATE FUNCTION migrations` — resolved via migration 040
**CLOSED R12-M-4.** Migration 040 codifies the 9 RPCs that previously
existed only in production Supabase: `find_session`, `get_full_store`,
`register_pin_candidates`, `register_login_create_session`,
`register_sign_out`, `register_open_shift`, `register_close_shift`,
`register_insert_audit`, `register_quick_switch`. Source was pulled via
`pg_get_functiondef()` on prod, so signatures + bodies match identically.
Migrations 027 + 028 wrapped their REVOKE/GRANT stanzas in `IF EXISTS`
guards so fresh-DB bootstrap no longer fails when those migrations run
before 040 creates the functions. `RPC_KNOWN_GAPS` in the drift detector
is now empty — any future undefined-RPC drift fails CI immediately.
Verified by dry-running migration 040 against prod: all 9 function OIDs
identical before/after (no-op confirmed).

### `offline-sync customer is_active filter` — high (fixed R11)
**CLOSED R11-H-3.** `SELECT ... FROM customers ... WHERE is_active = true` now
filters deactivated customers from both checkout and offline-sync paths.

### `R9-C-3 TZ AsyncLocalStorage race` — critical (fixed in R9 regression tests)
**CLOSED.** Lazy init now memoizes the promise, not the resolved instance,
so concurrent first-use doesn't create two competing stores.

### `customers.address missing from migrations` — resolved via migration 038
**CLOSED.** Migration 038 adds `customers.address` and `customers.last_visit_at`
via idempotent `ADD COLUMN IF NOT EXISTS`. Schema drift detector now passes.

### `sessions.organization_id missing from migrations` — resolved via migration 037
**CLOSED.** Migration 037 adds `sessions.organization_id` with backfill.

### `pay_in_outs.organization_id missing from migrations` — resolved via migration 038
**CLOSED.** Same migration covers it; FK + index added.

---

## Guardrails in place (see `eslint-rules/index.mjs` + `scripts/check-schema-drift-ci.mjs`)

- **Schema drift** — `npm run check:schema` walks migrations, flags `INSERT`/`UPDATE`
  referencing columns no migration declares, AND flags RPC callsites whose
  `CREATE FUNCTION` isn't in any migration. Catches R9-C-2 / R11-C-1/C-2
  (column drift) and R12-M-4 (RPC drift) shape.
- **Hand-rolled currency** — custom ESLint rule `local/no-hand-rolled-currency`
  forbids `\$\${x.toFixed(N)}` and `>\${x.toFixed(N)}` in UI files,
  including inside `||` / `??` / ternary fallbacks (R12-M-5 fix).
  Exempts `src/lib/receipt/`, email-receipt.
- **Workers hazards** — `local/no-workers-hazards` forbids module-scope
  `let`/`var` AND `const cache = new Map()` / `new Set()` / etc. in
  `src/lib/**` (allowlist for known per-org caches), and
  `void import(...).then(...)` (cancelled by
  `no_handle_cross_request_promise_resolution`). R12-L-2 widened `const`
  mutable-container coverage.
- **pg-helpers-require-org** — `local/pg-helpers-require-org` requires
  every `pg*` helper that does UPDATE/INSERT/DELETE to take an
  `organizationId` / `orgId` parameter (or `data: { organizationId }`).
- **allowedLocations** — `AdminContext.allowedLocations: string[] | null`
  exposes location-scope filter to every handler. Non-null = filter
  required; null = owner/manager bypass. R12 tightened adoption on
  `/api/audit`, `/api/returns`, `/api/gift-cards` (list), `/api/transactions`
  + `/api/transactions/by-id` (now uses this field instead of the less-strict
  `employee.locationIds`). New admin routes: use `ctx.allowedLocations`, not
  `ctx.employee.locationIds` — the former is register-aware.

Run all of them at once:

```bash
npm run check:all     # lint + typecheck + schema drift
```

Pre-commit hook runs schema drift + lint on staged files (`.husky/pre-commit`).
CI runs the full `check:all` matrix on every PR (`.github/workflows/guardrails.yml`).
