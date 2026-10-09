# BasicUniformPOS (BUPOS)

BasicUniformPOS is a multi-tenant retail point-of-sale system. The active application is the Next.js project in [`code/`](code/); the repository also contains a public landing Worker and a Windows Electron shell.

## Start here

- [Application setup, checks, and contribution notes](code/README.md)
- [Current architecture](code/docs/architecture.md)
- [Environment and configuration ownership](code/docs/configuration.md)
- [Documentation index](docs/README.md)

Historical plans, product specifications, and audits remain in the repository as evidence. They do not override the current guidance linked above.

## Local setup

Prerequisites:

- Node.js 22 (the CI version) and npm
- Docker with Compose
- a local `psql` client for the migration script

```bash
cd code
npm ci
npm run docker:up
npm run docker:migrate

# Set DATABASE_URL to the local Docker database described in docker-compose.yml.
USE_POSTGRES=true npm run dev
```

The app defaults to `http://localhost:3000`. The main entry points are:

- `/register` — worker register
- `/admin/dashboard` — canonical admin dashboard
- `/admin/*` — canonical dedicated admin tools
- `/api/health` — health endpoint

The all-in-one `/admin` page is a retained legacy surface. Do not add new admin features there when a dedicated `/admin/*` route exists.

For environment-variable ownership and secret handling, see [`code/docs/configuration.md`](code/docs/configuration.md). No production credentials are required for the local Docker path.

## Verification

Run from the repository root:

```bash
npm --prefix code test
npm --prefix code run check:all
npm --prefix code run build
```

Docker-backed integration and browser checks require the local database first:

```bash
npm --prefix code run docker:up
npm --prefix code run docker:migrate
npm --prefix code run test:integration
npm --prefix code run test:e2e
```

See [`code/README.md`](code/README.md) for the test-suite boundaries and [`code/docs/runbook-deploy.md`](code/docs/runbook-deploy.md) for the production deployment boundary. Do not run deployment commands as part of local setup.

## Repository map

```text
.
├── .github/workflows/        # CI, deployment, scheduled operations, desktop build
├── code/                     # Active Next.js application and Cloudflare Worker config
│   ├── src/app/              # App Router pages, API routes, and server actions
│   ├── src/components/       # Register and admin UI
│   ├── src/lib/              # Auth, domain, persistence, integrations, reports
│   ├── supabase/migrations/  # Canonical ordered PostgreSQL migrations
│   ├── scripts/              # Guardrails, local DB tooling, audits, and operations
│   ├── landing/              # Separate public landing Cloudflare Worker
│   └── docs/                 # Current architecture and operational runbooks
├── desktop/                  # Electron shell around the deployed web application
├── docs/                     # Repository-level documentation index
├── support-pack/             # Historical/reference QA and workflow material
└── SwiftPOS_*, AUDIT_*       # Historical plans, specs, progress, and audit evidence
```

## Deployment boundary

Pushes to `master` are handled by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). That workflow waits for guardrails, applies migrations, builds and deploys through OpenNext/Wrangler, and runs a production smoke test. Manual deployment, migration, secret, and rollback actions require an authorized operator; follow the [deploy](code/docs/runbook-deploy.md) and [rollback](code/docs/runbook-rollback.md) runbooks.

## Escalation boundaries

Routine local implementation, tests, cleanup, and PR preparation are pre-approved. Escalate before credentials/env changes, database migrations/backfills, production deploys, payment/refund behavior changes, deleting/replacing live data, customer messaging, paid services, or high-uncertainty live-store impact.

## Safe backlog buckets

1. Production authenticated feature-click QA, once a production admin session/cookie is available.
2. Help/Audit lifecycle label polish: make states like `Detected`, `Evidence shown`, and manager review outcomes more explicit without implying repairs ran.
3. Retail workflow polish: visible cashier feedback, quantity controls, low-stock warnings, and simpler shift/register copy.
4. Back-office slices: inventory adjustments review, supplier/PO reporting, Shopify reconciliation, customer preferences/recommendations.
5. Ops hygiene: keep generated artifacts untracked, prune stale local build outputs, and refresh docs only when they reduce ambiguity.

## Escalation boundaries

Routine local implementation, tests, cleanup, and PR preparation are pre-approved. Escalate before credentials/env changes, database migrations/backfills, production deploys, payment/refund behavior changes, deleting/replacing live data, customer messaging, paid services, or high-uncertainty live-store impact.
