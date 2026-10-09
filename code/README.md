# BasicUniformPOS application

This directory contains the active BUPOS web application: a Next.js 16 App Router project deployed to Cloudflare Workers through OpenNext. PostgreSQL is the production persistence layer; local Docker Postgres is the supported full-data development path. A JSON store remains as a limited compatibility/development fallback when `USE_POSTGRES` is not enabled.

- [Architecture](docs/architecture.md)
- [Environment and configuration ownership](docs/configuration.md)
- [Repository documentation index](../docs/README.md)
- [Deploy runbook](docs/runbook-deploy.md)
- [Rollback runbook](docs/runbook-rollback.md)

## Prerequisites

- Node.js 22 and npm (matches GitHub Actions)
- Docker with Compose
- `psql` available to `scripts/docker-migrate.sh`

## Local development

```bash
npm ci
npm run docker:up
npm run docker:migrate

# Set DATABASE_URL to the local database described by docker-compose.yml.
USE_POSTGRES=true npm run dev
```

Run those commands from `code/`. Next.js listens on port 3000 by default. To avoid an occupied port, choose a free one explicitly, for example `PORT=3101 USE_POSTGRES=true npm run dev`; do not start a second process on an existing port.

The local Docker database binds host port 54329. Check that the port is free before `npm run docker:up`, or stop the conflicting service; do not silently point migration or test commands at a different or production database.

## Application surfaces

- `/register` — cashier/register workflow
- `/register/customer-display` and `/customer-display` — customer-facing displays
- `/admin/dashboard` — canonical admin dashboard
- `/admin/*` — canonical dedicated admin tools
- `/admin` — retained legacy all-in-one console; do not extend it when a dedicated route exists
- `/api/*` — authenticated application and operational endpoints

Top-level aliases/placeholders such as `/dashboard`, `/pos`, `/products`, `/sales`, and `/settings` are compatibility or incomplete surfaces, not the canonical admin implementation.

## Test and verification commands

| Command | Scope | External prerequisite |
|---|---|---|
| `npm test` | Unit and adversarial Vitest suites | none |
| `npm run test:runtime` | Workers-runtime smoke tests | none |
| `npm run test:adversarial` | Permanent closed-finding regressions | none |
| `npm run lint` | ESLint and local Worker-safety rules | none |
| `npm run typecheck` | TypeScript | none |
| `npm run check:all` | Lint, typecheck, and every repository guardrail | none; production drift runs its self-test without DB URLs |
| `npm run test:integration` | PostgreSQL integration tests | migrated local Docker DB |
| `npm run test:e2e` | Playwright against Next.js and PostgreSQL | migrated local Docker DB and Chromium |
| `npm run build` | Next.js production build | application build configuration |

For Docker-backed suites:

```bash
npm run docker:up
npm run docker:migrate
npm run test:integration

npx playwright install chromium
npm run test:e2e
```

Guardrails live in `scripts/check-*.mjs`. Exit code `1` means an offender was found; exit code `2` means the guardrail's own self-test or wiring failed. New guardrails need a self-test and must be wired into [the root Guardrails workflow](../.github/workflows/guardrails.yml).

## Where changes belong

```text
src/app/                  Routes, pages, API handlers, and thin server-action adapters
src/components/           Register/admin UI components
src/lib/auth/             Sessions, display tokens, device cookies, and rate limiting
src/lib/domain/           Shared domain types and permissions
src/lib/db/               PostgreSQL driver and org-scoped query/transaction helpers
src/lib/persistence/      JSON compatibility store and PostgreSQL repositories
src/lib/offline/          Browser queue and replay support
src/lib/channels/         Commerce-channel adapters and reconciliation
src/lib/reports/          Shared report generation
src/lib/validation/       Request and message schemas
supabase/migrations/      Ordered database schema changes
scripts/                  Guardrails, local DB operations, audit and simulation tools
e2e/                      Playwright tests
```

Tenant and location isolation, payment/tender behavior, audit events, offline replay, session/auth behavior, and migrations are security-sensitive. Keep mutations explicit and auditable, use org-scoped DB helpers, and run the focused suites plus `check:all` after changes.

## Deployment

`npm run deploy` builds through OpenNext and publishes with Wrangler. It is not a local verification command. Production deployment is owned by [the root deployment workflow](../.github/workflows/deploy.yml); authorized manual operations must follow the [deploy runbook](docs/runbook-deploy.md). Secret names and owners are documented without values in [`docs/configuration.md`](docs/configuration.md).
