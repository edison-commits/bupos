# BasicUniformPOS architecture

This document describes the current repository shape. Historical product specs and audits are indexed separately in the [repository documentation index](../../docs/README.md).

## Runtime overview

BasicUniformPOS is a Next.js 16 App Router application written in TypeScript and deployed to Cloudflare Workers through `@opennextjs/cloudflare`. PostgreSQL is the production data store. The application uses a local `pg` pool for localhost database URLs and a request-scoped serverless driver for remote database URLs.

The repository also contains:

- an offline browser queue that replays register work when connectivity returns;
- commerce-channel adapters and an HMAC-gated inventory reconciliation endpoint;
- a separate Cloudflare Worker under `landing/` for the public landing site;
- a hardened Electron shell under `../desktop/` that loads the deployed web application rather than maintaining a second backend.

## Main surfaces

- `src/app/register/` — cashier register, checkout actions, shifts, returns, approvals, layaway, time clock, and customer display
- `src/app/admin/*` — canonical dedicated manager/admin routes
- `src/app/admin/page.tsx` — retained legacy all-in-one console
- `src/app/api/` — application, reporting, integration, and internal operational endpoints
- `src/components/` — worker/admin presentation and client-side orchestration

Dedicated `/admin/*` routes are canonical. Top-level `/dashboard` and `/pos` are aliases; `/products`, `/sales`, and `/settings` are placeholder/compatibility surfaces. Route consolidation is a separate behavior-changing cleanup and is not implied by this document.

## Representative request and data flow

1. A browser request enters the Next.js App Router or an API route under `src/app/`.
2. Auth/session helpers establish the actor, organization, location, and role context.
3. Zod schemas under `src/lib/validation/` validate external payloads.
4. Application routes/actions call persistence modules. Org-scoped PostgreSQL work should use `src/lib/db/` helpers such as `orgQuery` and `orgTx` so the tenant context is set for RLS-aware queries.
5. Mutating workflows write their business records and corresponding audit events, then invalidate affected caches.
6. Responses return through the App Router. Work that must survive a Cloudflare response uses the runtime `waitUntilOrAwait` boundary.

The JSON repository under `src/lib/persistence/` remains a limited local compatibility fallback when `USE_POSTGRES` is unset. PostgreSQL plus the ordered migrations in `supabase/migrations/` is the authoritative full-data path.

## Register and offline sync

The register UI is under `src/app/register/` and `src/components/register/`. Online checkout and offline replay have separate adapters because their trust and idempotency boundaries differ. Browser-side queueing lives under `src/lib/offline/`; queued transactions are replayed through the offline-sync API. Payment, refund, discount, inventory, drawer, and shift mutations remain explicit server-authorized actions.

Customer-display messages are validated and customer-facing totals are recomputed from cart data. Display/device secrets are server-owned configuration; see [configuration ownership](configuration.md).

## Admin architecture

The canonical manager experience is the collection of dedicated routes under `src/app/admin/*`, sharing the admin shell. The root `/admin` console and its broad action collection are legacy compatibility surfaces still reachable for tools not yet migrated. New work should target the dedicated route for its feature and keep route/action entry points thin where possible.

## Data and tenancy

- Ordered schema source: `supabase/migrations/*.sql`
- Local database harness: `docker-compose.yml` and `scripts/docker-migrate.sh`
- Canonical DB helper direction: `src/lib/db/`
- Compatibility persistence modules: `src/lib/persistence/` and `src/lib/supabase-rest.ts`
- Tenant context: organization-scoped helpers set `app.current_org_id`
- Authorization: session and permission modules under `src/lib/auth/` and `src/lib/domain/`
- Auditability: sensitive mutations write append-only audit evidence

`src/lib/supabase-rest.ts` is a compatibility name; the application does not use Supabase's REST client for normal persistence.

## Integrations and scheduled work

Commerce-channel code lives in `src/lib/channels/`. Channel inventory reconciliation is invoked by [the root GitHub Actions workflow](../../.github/workflows/reconcile-channels.yml), which calls an HMAC-protected internal endpoint. Sales-digest scheduling follows the same external-scheduler pattern. Nightly database cleanup is installed by migration and runs in PostgreSQL; the internal cleanup endpoint is a manual operational fallback.

## Deployment topology

- Web application: OpenNext bundle deployed by Wrangler using `wrangler.jsonc`
- Static assets: emitted under `.open-next/assets` and bound by Wrangler
- Database: remote PostgreSQL with migrations applied before application deployment
- Rate limiting: in-isolate protection plus the `RATE_LIMIT_KV` Cloudflare binding
- Public landing site: standalone Worker under `landing/`
- Desktop: Electron package under `../desktop/`, loading the same deployed application and using the web app's offline queue

The authoritative production sequence is [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml): wait for guardrails, apply pending migrations, typecheck, build/deploy, smoke, then check production schema drift. Manual deployment and rollback require the [deploy](runbook-deploy.md) and [rollback](runbook-rollback.md) runbooks.

## Verification boundaries

- `npm run check:all` — lint, typecheck, and static guardrails
- `npm test` — unit/adversarial behavior
- `npm run test:integration` — PostgreSQL behavior and tenancy
- `npm run test:e2e` — browser flow against local PostgreSQL
- `npm run build` — Next.js build
- `npm run deploy` — production side effect, not a local check

See the [application README](../README.md) for prerequisites and exact local commands.
