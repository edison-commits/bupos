# BUPOS / BasicUniformPOS

Retail POS for uniform/apparel stores. The active app lives in `code/` and is a Next.js 16 + Cloudflare Workers project backed by Postgres-compatible databases.

## Current status

- Active branch: `autonomy/bupos-current-readiness-20260711`
- Upstream: `https://github.com/edison-commits/bupos.git`
- Latest known production fix on this branch: `1903657 fix: keep inventory API compatible with current schema`
- Deployment target: Cloudflare/OpenNext from `code/`
- Local generated artifacts should stay untracked: `.DS_Store`, `*.zip`, `.next/`, `.open-next/`, `.wrangler/`, `node_modules/`, `test-results/`

## Work in the right directory

Most commands should run from:

```bash
cd code
```

Read `code/AGENTS.md` before editing app code. This repo uses Next.js 16; do not assume older Next.js APIs or file conventions.

## Quick local setup

```bash
cd code
npm ci
npm run docker:up
npm run docker:migrate
DATABASE_URL="postgresql://postgres:***@localhost:54329/bupos_test" USE_POSTGRES=true npm run dev
```

Local app surfaces:

- Register: `http://localhost:3000/register`
- Admin: `http://localhost:3000/admin`
- API: `http://localhost:3000/api`

## Verification gates

Use a proportional gate for the change size. For release/readiness claims, prefer the full guardrail path.

```bash
cd code
npm run typecheck
npm run lint
npm run build
```

Broader BUPOS gate:

```bash
cd code
npm run check:all
npm test -- --run
npx opennextjs-cloudflare build
```

Docker/Postgres suites:

```bash
cd code
npm run docker:up
npm run docker:migrate
npm run test:integration
npm run test:e2e
```

## Repository organization

Primary app:

- `code/src/app/` — Next.js app routes and API routes
- `code/src/lib/` — auth, database, runtime, domain helpers
- `code/src/__tests__/` — unit, route, adversarial, integration fixtures
- `code/supabase/migrations/` — canonical DB migrations
- `code/scripts/check-*.mjs` — CI guardrails
- `code/docs/` — operational runbooks, architecture, known issues, historical follow-ups

Support/reference material:

- `support-pack/` — QA matrices and retail workflow checklists
- `desktop/` — desktop packaging experiment; keep secondary to the web/Cloudflare path
- top-level `SwiftPOS_*.md` and `AUDIT_*.md` — historical planning/audit inputs, not the current source of truth for runtime behavior

Current source-of-truth docs:

- `code/README.md` — app-specific setup, guardrails, testing, architecture notes
- `code/docs/KNOWN_ISSUES.md` — central issue/audit tracker
- `code/docs/ROUND8_FOLLOWUPS.md` — historical Round 8 follow-up closure evidence
- `code/docs/runbook-deploy.md` / `runbook-rollback.md` / `runbook-alerting.md` — ops runbooks
- `code/docs/bupos-help-cheat-sheet.md` and `code/public/docs/bupos-help-cheat-sheet.md` — operator-facing Help cheat sheet; keep copies byte-identical

## Safe backlog buckets

1. Production authenticated feature-click QA, once a production admin session/cookie is available.
2. Help/Audit lifecycle label polish: make states like `Detected`, `Evidence shown`, and manager review outcomes more explicit without implying repairs ran.
3. Retail workflow polish: visible cashier feedback, quantity controls, low-stock warnings, and simpler shift/register copy.
4. Back-office slices: inventory adjustments review, supplier/PO reporting, Shopify reconciliation, customer preferences/recommendations.
5. Ops hygiene: keep generated artifacts untracked, prune stale local build outputs, and refresh docs only when they reduce ambiguity.

## Escalation boundaries

Routine local implementation, tests, cleanup, and PR preparation are pre-approved. Escalate before credentials/env changes, database migrations/backfills, production deploys, payment/refund behavior changes, deleting/replacing live data, customer messaging, paid services, or high-uncertainty live-store impact.
