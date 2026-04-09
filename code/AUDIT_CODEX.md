# BUPOS Deep Security and Quality Audit

Requested output path `/Users/edison/Projects/bupos/AUDIT_CODEX.md` was not writable from the current sandbox. This report was written to `/Users/edison/Projects/bupos/code/AUDIT_CODEX.md`.

## Scope

- Next.js 16.2.1 app on Cloudflare Workers via OpenNext
- Supabase PostgreSQL / direct Postgres access
- Areas reviewed: auth, RBAC, DB isolation, route handlers, server actions, middleware/proxy, Workers compatibility, type safety, performance, state, API design, accessibility, testing

## Verification Notes

- `npm run lint` did not complete cleanly. ESLint failed while traversing generated OpenNext output under `.open-next-old*`, with `EACCES` on generated files rather than source lint findings.
- `npm run build` could not be fully validated in this sandbox. Next.js emitted a Turbopack panic caused by the sandbox blocking a port bind during CSS processing, so I did not treat that as a source-level app failure.

## Findings

### 1. Critical: live database credentials are committed
- Severity: Critical
- File: `.env.local:3`
- Issue: A real Supabase pooler `DATABASE_URL` with password is committed. This is enough to access production data directly if reused anywhere outside local-only development.
- Impact: Full database compromise, tenant data exposure, destructive writes.
- Fix: Rotate the database password immediately, invalidate any dependent secrets, remove `.env.local` from version control, add it to `.gitignore`, and move secrets to Wrangler/Cloudflare/Supabase secret storage.

### 2. High: CORS origin check is bypassable and credentials are always enabled
- Severity: High
- File: `middleware.ts:13`
- File: `middleware.ts:15`
- File: `middleware.ts:17`
- File: `middleware.ts:21`
- Issue: `origin.startsWith(...)` accepts attacker origins like `https://bupos.basicuniform.com.evil.tld`. The middleware also sets `Access-Control-Allow-Credentials: true` globally.
- Impact: Cross-origin authenticated requests become possible against cookie-backed APIs if the browser accepts the response headers. This materially weakens CSRF protection.
- Fix: Compare exact origins with `===`, do not reflect arbitrary origins, and only emit credentialed CORS headers on endpoints that actually need cross-origin access.

### 3. High: tenant isolation still depends on non-forced RLS plus a privileged app role
- Severity: High
- File: `src/lib/db/index.ts:3`
- File: `src/lib/db/index.ts:11`
- File: `supabase/migrations/009_rls_policies.sql:13`
- Issue: The app connects through the `postgres` connection string and relies on `SET LOCAL app.current_org_id` for isolation, but the migrations only `ENABLE ROW LEVEL SECURITY`; they do not `FORCE ROW LEVEL SECURITY`. Direct `pool.query` usage remains widespread.
- Impact: If the runtime role owns tables or has `BYPASSRLS`, policies are not enforced and any missed `organization_id` predicate becomes a cross-tenant read/write bug.
- Fix: Run the app as a dedicated non-owner role without `BYPASSRLS`, add `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for every org-scoped table, and keep `pool.query` out of tenant data paths unless a query is provably scoped.

### 4. High: categories leak across organizations because the cache and query are global
- Severity: High
- File: `src/lib/persistence/postgres-store.ts:19`
- File: `src/lib/persistence/postgres-store.ts:109`
- File: `src/lib/persistence/postgres-store.ts:112`
- File: `src/lib/persistence/postgres-read-store.ts:153`
- Issue: `pgReadCategories()` queries all categories with no `organization_id` filter and caches them in a single global `_categoriesCache`. `readStoreFromPg()` then injects that data into each org’s store snapshot.
- Impact: Cross-tenant catalog metadata exposure.
- Fix: Make category reads org-scoped, key the cache by `organizationId`, and invalidate per-org only.

### 5. High: products API response cache is keyed only by URL, not organization
- Severity: High
- File: `src/app/api/products/route.ts:12`
- File: `src/app/api/products/route.ts:25`
- File: `src/app/api/products/route.ts:26`
- File: `src/app/api/products/route.ts:197`
- Issue: `_productsCache` uses `request.nextUrl.toString()` as the cache key. On a multi-tenant single-domain deployment, `/api/products?...` is identical across orgs.
- Impact: One tenant can receive another tenant’s cached catalog/summary response for up to 30 seconds.
- Fix: Include `orgId` in the cache key or remove the process-global cache and rely on per-org data caches lower in the stack.

### 6. High: offline sync trusts client-supplied prices and discounts
- Severity: High
- File: `src/app/api/offline-sync/route.ts:47`
- File: `src/app/api/offline-sync/route.ts:51`
- File: `src/app/api/offline-sync/route.ts:124`
- File: `src/app/api/offline-sync/route.ts:135`
- File: `src/app/api/offline-sync/route.ts:159`
- Issue: The route validates almost none of the cart shape, then recomputes totals from client-provided `overridePrice`, `unitPrice`, `modifierTotal`, and discounts without loading authoritative product pricing from the database.
- Impact: A compromised terminal or tampered request can sync underpriced transactions, zero-price sales, or manipulated discounts while still decrementing inventory and affecting loyalty/store credit.
- Fix: Treat offline sync as a replay of item identities and quantities only. Reload server-side variant prices/modifier prices, re-run the same price-override approval logic as live checkout, and strongly type/validate the payload.

### 7. High: email-receipt endpoint can be used to forge receipts and spam arbitrary addresses
- Severity: High
- File: `src/app/api/email-receipt/route.ts:39`
- File: `src/app/api/email-receipt/route.ts:42`
- File: `src/app/api/email-receipt/route.ts:57`
- File: `src/app/api/email-receipt/route.ts:152`
- Issue: The handler never loads the transaction by `transactionId`; it emails whatever items, totals, tenders, and store name the caller supplies. There is also no route-specific rate limiting.
- Impact: Authenticated staff can send fraudulent receipts or use the endpoint as an email relay within the Resend quota.
- Fix: Load the transaction server-side by ID, derive the email body from stored data only, ensure the caller can access that transaction, and add per-user/org rate limiting.

### 8. High: PIN login only checks the first 20 active credentials and mutates failure counters globally
- Severity: High
- File: `src/lib/persistence/postgres-store.ts:508`
- File: `src/lib/persistence/postgres-store.ts:514`
- File: `src/lib/persistence/postgres-store.ts:520`
- File: `src/lib/persistence/postgres-store.ts:553`
- Issue: `pgFindCredentialByPin()` scans `auth_credentials` with `LIMIT 20`, no org filter, and increments failed-attempt counters for every checked credential on a bad PIN.
- Impact: Employees outside the first 20 rows can never log in by PIN. Bad attempts can also throttle unrelated employees across orgs, creating an easy operational DoS.
- Fix: Look up the employee set by org/location first, then verify only eligible hashes. Remove the global `LIMIT 20` scan and update failure counters only for the actual attempted identity.

### 9. Medium: signup flow is non-transactional and can leave partial tenants behind
- Severity: Medium
- File: `src/app/actions/auth.ts:124`
- File: `src/app/actions/auth.ts:132`
- File: `src/app/actions/auth.ts:139`
- File: `src/app/actions/auth.ts:147`
- Issue: organization, location, employee, and credentials are inserted as separate statements with no transaction.
- Impact: Any mid-flight failure leaves orphaned orgs/locations/employees and inconsistent auth state.
- Fix: Wrap the entire signup bootstrap in one DB transaction and roll back on any failure.

### 10. Medium: employee creation is also non-transactional
- Severity: Medium
- File: `src/app/api/employees/route.ts:153`
- File: `src/app/api/employees/route.ts:176`
- Issue: The employee row is created through `orgQuery()`, then credentials are inserted separately through `pool.query()`.
- Impact: If the credential insert fails, the system retains an active employee with no usable auth credentials.
- Fix: Use a single `orgTx()` transaction for both inserts.

### 11. Medium: product write handlers return early after `BEGIN` without rolling back
- Severity: Medium
- File: `src/app/api/products/route.ts:225`
- File: `src/app/api/products/route.ts:245`
- File: `src/app/api/products/route.ts:257`
- File: `src/app/api/products/route.ts:273`
- File: `src/app/api/products/route.ts:317`
- File: `src/app/api/products/route.ts:399`
- Issue: `POST` and `PUT` start transactions, then return 4xx responses on validation/dup checks before a `ROLLBACK`. The client is only released in `finally`.
- Impact: Depending on driver behavior, this can leak open transactions/locks back into the pool and cause hard-to-debug contention.
- Fix: Validate before `BEGIN`, or ensure every early return path explicitly rolls back first.

### 12. Medium: CSV exports are vulnerable to spreadsheet formula injection and scale poorly
- Severity: Medium
- File: `src/app/api/export/route.ts:176`
- File: `src/app/api/export/route.ts:190`
- File: `src/app/api/export/route.ts:196`
- Issue: CSV cells are quoted but not neutralized for leading `=`, `+`, `-`, or `@`. `toCsv()` also constructs the entire file in memory.
- Impact: Opening exported CSVs in Excel/Sheets can execute attacker-controlled formulas from customer/product data. Large exports can exhaust Worker memory.
- Fix: Prefix dangerous cells with `'` or a space, and stream CSV rows instead of building one giant string.

### 13. Medium: `audit.view` is too broad for sensitive exports
- Severity: Medium
- File: `src/app/api/export/route.ts:18`
- File: `src/lib/domain/permissions.ts:47`
- File: `src/lib/domain/permissions.ts:53`
- Issue: support and inventory-clerk roles both have `audit.view`, and that single permission unlocks customer exports with `include_pii=true`, gift card exports, and financial datasets.
- Impact: Least-privilege failure and unnecessary PII/financial access.
- Fix: Split `audit.view` into narrower permissions such as `reports.view`, `customers.export_pii`, and `finance.export`.

### 14. Medium: rate limiting is not durable on Cloudflare Workers
- Severity: Medium
- File: `src/lib/auth/rate-limit.ts:4`
- File: `src/lib/auth/rate-limit.ts:13`
- Issue: The limiter is in-process memory only. The file already notes each Worker isolate has its own map.
- Impact: Attackers can bypass throttling by hitting different isolates or after cold starts. Sensitive flows still look protected in code while remaining weak in production.
- Fix: Move rate limiting to a shared store such as Cloudflare KV, Durable Objects, or Upstash/Redis, and key by user plus source signal.

### 15. Medium: EOD reports are hardwired to a personal email address
- Severity: Medium
- File: `src/app/api/eod-report/route.ts:210`
- File: `src/app/api/eod-report/route.ts:212`
- Issue: The recipient is hardcoded to `londonpark@gmail.com`.
- Impact: Report delivery is not tenant-configurable and risks leaking operational data to the wrong mailbox.
- Fix: Store recipients in org/location settings, validate them, and require explicit configuration per tenant.

### 16. Low: accessibility gaps in barcode label printer
- Severity: Low
- File: `src/components/admin/barcode-label-printer.tsx:167`
- File: `src/components/admin/barcode-label-printer.tsx:255`
- File: `src/components/admin/barcode-label-printer.tsx:263`
- Issue: The search input has only a placeholder and no accessible label. Quantity buttons use bare glyphs without `aria-label`.
- Impact: Poor screen-reader usability and weaker keyboard/switch accessibility.
- Fix: Add a visible or sr-only label for the search field and explicit `aria-label` values like “Decrease label quantity” / “Increase label quantity”.

### 17. Low: test coverage is effectively absent
- Severity: Low
- File: `package.json:5`
- Issue: There is no `test` script and no project test suite surfaced in the repository.
- Impact: Regressions in auth, pricing, RLS boundaries, and offline sync are likely to escape into production.
- Fix: Add targeted tests first for auth/session handling, tenant isolation, checkout/offline-sync pricing invariants, and export/email endpoints.

### 18. Low: Next 16 proxy migration is incomplete
- Severity: Low
- File: `middleware.ts:4`
- File: `src/proxy.ts.disabled:1`
- Issue: The active file uses deprecated `middleware.ts` while a `proxy.ts` implementation is present but disabled.
- Impact: Upgrade risk and confusion for Workers/Edge behavior under newer Next.js conventions.
- Fix: Migrate the active logic to `proxy.ts`, delete the disabled duplicate, and keep one authoritative request interception layer.

### 19. Low: dead cache state remains in the Postgres store layer
- Severity: Low
- File: `src/lib/persistence/postgres-store.ts:20`
- File: `src/lib/persistence/postgres-store.ts:614`
- Issue: `_orgCache` is declared but unused, and `pgReadOrganization()` is unused and returns `LIMIT 1` without tenant context.
- Impact: Increases maintenance cost and leaves misleading code around org scoping.
- Fix: Remove dead cache state and either delete `pgReadOrganization()` or make it explicit and tenant-scoped before use.

## Summary by Area

- Security: remaining issues are dominated by CORS/origin handling, committed secrets, over-broad permissions, and endpoints that trust client-supplied business data.
- Data layer: tenant isolation is still brittle because it depends on app discipline instead of forced RLS; two confirmed cross-tenant leaks exist in category loading and product response caching.
- Error handling: several non-critical audit writes intentionally fail open; the more serious problem is transactional inconsistency on multi-step writes.
- Type safety: important routes still cast `unknown` payloads into rich objects (`offline-sync`, `email-receipt`) instead of validating full schemas.
- Performance/state: global process caches are not tenant-safe in all cases, CSV export is fully buffered, and PIN verification does O(N) hash work against the wrong candidate set.
- API design: sensitive endpoints lack dedicated rate limiting and some authorization boundaries are too coarse.
- Testing: no meaningful automated safety net is present for the highest-risk flows.
- Deployment/Workers: the codebase still carries deprecated middleware/proxy structure and shared-memory assumptions that do not hold well on Workers.
- Accessibility: there are still basic labeling issues in interactive admin UI.

## Recommended Remediation Order

1. Rotate the leaked database credential and remove committed secrets.
2. Fix tenant leaks immediately: `pgReadCategories()` and `/api/products` cache keying.
3. Fix CORS/origin handling and add dedicated rate limits to outbound email/export paths.
4. Rework offline sync and email receipt to derive business data server-side.
5. Replace the global PIN scan with org/location-scoped credential resolution.
6. Add transactions around signup and employee creation.
7. Add regression tests for the items above before further feature work.
