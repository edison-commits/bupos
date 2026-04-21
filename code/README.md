# BasicUniformPOS

Next.js 16 + Cloudflare Workers multi-tenant POS. JSON-backed store for dev
simplicity, Postgres (Supabase/Neon in prod, plain pg in local dev) for real data.

## Quick start

```bash
# Install deps
npm ci

# Start local Postgres (Docker compose — Supabase-compat schema + roles)
npm run docker:up
npm run docker:migrate

# Run the app against Docker Postgres
DATABASE_URL="postgresql://postgres:postgres@localhost:54329/bupos_test" \
USE_POSTGRES=true npm run dev
```

Test credentials for local dev live in `docs/reference_bupos_credentials.md`.

---

## Test suites

| Command | What it runs | Needs Docker? | Needs Chromium? |
|---|---|---|---|
| `npm test` | Unit + adversarial fixture corpus (vitest) | no | no |
| `npm run test:runtime` | Workers-runtime smoke (mocked `@opennextjs/cloudflare`) | no | no |
| `npm run test:adversarial` | Permanent regression fixtures for closed findings | no | no |
| `npm run test:integration` | PG integration (cross-tenant, race-fuzz, admin flows) | **yes** | no |
| `npm run test:e2e` | Playwright end-to-end via `next dev` | **yes** | **yes** |

For the Docker-dependent suites, run `npm run docker:up && npm run docker:migrate`
once per repo clone. For Playwright install Chromium: `npx playwright install chromium`.

---

## Guardrails & CI

All guardrails are scripts in `scripts/check-*.mjs`. Exit codes:

- **0** = clean
- **1** = real offenders found (fix the offenders)
- **2** = the guardrail itself is broken (fix the guardrail before shipping)

Exit code 2 is emitted by the self-test block every guardrail runs BEFORE its
real scan — if the detector regresses to a no-op, you get a loud
"guardrail is broken" failure instead of a silent pass.

```bash
npm run check:all    # lint + typecheck + all guardrails
npm run check:schema # individual guardrails also available
```

Adding a new guardrail — **hard requirements**:

1. Self-test: an inline `selfTest()` block OR a sibling
   `scripts/check-<name>-selftest.mjs` that feeds known-good/bad fixtures
   and asserts the detector behaves. Required by `check:selftest-coverage`.
2. CI wiring: add `npm run check:<name>` as a step in
   `.github/workflows/guardrails.yml`. Required by `check:ci-wiring`.
3. Extension: `.mjs` (CI invokes via `node scripts/*.mjs`).

## Pre-merge adversarial audit

```bash
# Dump the prompt (manual review)
npm run audit:prompt

# Call the Anthropic API (CI — requires ANTHROPIC_API_KEY secret)
npm run audit:pre-merge
```

Runs on every PR via `.github/workflows/pre-merge-audit.yml`. Skips cleanly
if the secret isn't configured.

## Adding a regression test

When an audit round closes a CRITICAL or HIGH finding:

1. Add a permanent fixture to `src/__tests__/adversarial/<round>-<id>-<slug>.test.ts`
   that reproduces the attack/scenario.
2. Assert the fix holds (attack fails, guard fires, or invariant holds).
3. Name the describe block with the finding ID so future debuggers can trace back.

The fixture becomes a permanent CI check — if anyone reverts the fix, this
test fails. See existing files for the convention.

---

## Architecture notes

- **DB driver selection** is dynamic: `src/lib/db/index.ts` detects a
  localhost connection string and imports `pg`; else imports
  `@neondatabase/serverless`. One module per isolate.
- **RLS**: every tenanted table has `ENABLE ROW LEVEL SECURITY` +
  `FORCE ROW LEVEL SECURITY`. `orgTx` / `orgQuery` set
  `app.current_org_id` so policies fire.
- **Workers post-response work** uses `waitUntilOrAwait` (see
  `src/lib/runtime/wait-until.ts`). Fire-and-forget `.catch(...)` is
  cancelled by the `no_handle_cross_request_promise_resolution` compat
  flag.
- **Audit rounds**: findings history + closure notes in
  `docs/KNOWN_ISSUES.md`. Review before a new round.

## Deploy

```bash
npm run deploy  # builds via opennext + deploys with wrangler
```
