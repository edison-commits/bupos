# BUPOS Retail POS — Complete Security & Quality Audit

**Date:** 2026-04-09
**Auditor:** Claude Code (Opus 4.6)
**Codebase:** Next.js 16.2.1 on Cloudflare Workers + Supabase PostgreSQL
**Branch:** `master` @ `4151fbe`

---

## Executive Summary

The BUPOS codebase demonstrates strong security fundamentals after two rounds of hardening — RLS enforcement, Zod validation, session management, and audit logging are all well-implemented. However, this audit uncovered **5 Critical**, **8 High**, **12 Medium**, and **10 Low** severity findings across authentication, authorization, data integrity, and code quality.

The most critical class of issues is **unprotected server actions** — several `"use server"` functions accept client-supplied `organizationId`/`employeeId` without verifying the caller's session, allowing unauthenticated users to write time clock entries, log audit events, and trigger behavior flag mutations.

---

## Findings Summary

| Severity | Count | Categories |
|----------|-------|-----------|
| Critical | 5 | Missing auth on server actions, error detail leak, no tests |
| High | 8 | Missing authz, signup CSRF, schema mismatch, rate limiting gaps |
| Medium | 12 | Idempotency, N+1, header injection, CSP, type safety |
| Low | 10 | Accessibility, dead feature, console logging, god components |

---

## 1. SECURITY — Authentication & Authorization

### C-01: Server Action `logTransactionEvent` has no auth check (Critical)

**File:** `src/app/register/event-action.ts:42-100`

The `logTransactionEvent()` server action is publicly callable. It accepts `organizationId`, `employeeId`, `locationId` directly from the client and writes to both `transaction_events` and `audit_events` tables without any session validation.

**Impact:** An unauthenticated attacker can forge audit trail entries for any organization, polluting the audit log and potentially masking real malicious activity.

**Fix:** Add `requireRegisterPermission('register.open')` at the top of the function and derive org/employee/location from the validated session context instead of trusting client parameters.

---

### C-02: Server Action `clockAction` has no auth check (Critical)

**File:** `src/app/register/time-clock-action.ts:10-37`

The `clockAction()` function accepts arbitrary `employeeId`, `locationId`, `organizationId` from the caller and inserts time clock entries without any authentication.

**Impact:** Any unauthenticated user can clock in/out any employee at any location, enabling payroll fraud.

**Fix:** Add `requireRegisterPermission('register.open')` and derive IDs from the authenticated session.

---

### C-03: Server Action `verifyManagerApproval` has no caller auth (Critical)

**File:** `src/app/register/approval-action.ts:54-180`

While the function validates the manager's PIN, it does not verify that the **caller** has an active register session. The `request.organizationId` (line 62) comes directly from untrusted client input.

**Impact:** An unauthenticated attacker can brute-force manager PINs across organizations (rate limit is per-location, but `locationId` is also client-supplied). Successful PIN verification returns the approver's employee data.

**Fix:** Add `requireRegisterPermission('register.open')` and validate that `request.organizationId` matches the session's org.

---

### C-04: Admin server actions missing permission checks (Critical)

**Files:**
- `src/app/admin/behavior-actions.ts:7-24` — `runFlagEngineAction()` and `reviewFlagAction()` have **zero** auth checks
- `src/app/admin/gift-card-actions.ts:22-23` — Checks `getAdminSession()` but not `requireAdminPermission()`
- `src/app/admin/store-credit-actions.ts:22-23` — Same pattern: auth without authz

**Impact:** For behavior-actions, any unauthenticated user can trigger the flag engine or mark flags as reviewed. For gift-card and store-credit actions, any authenticated admin (regardless of role) can activate gift cards and issue store credit without the required permissions.

**Fix:**
- `behavior-actions.ts`: Add `requireAdminPermission('audit.view')` to both functions
- `gift-card-actions.ts`: Replace `getAdminSession()` with `requireAdminPermission('approval.discount')` or appropriate permission
- `store-credit-actions.ts`: Same — use `requireAdminPermission()` with the correct permission

---

### C-05: Email receipt route leaks internal error details (Critical)

**File:** `src/app/api/email-receipt/route.ts:171`

```typescript
return NextResponse.json({ error: "Failed to send email", details: err }, { status: 502 });
```

The raw Resend API error object is returned to the client, which may include API keys, internal URLs, rate limit details, or stack traces.

**Fix:** Remove `details: err` from the response. Log it server-side only.

---

### H-01: Signup action missing CSRF/origin validation (High)

**File:** `src/app/actions/auth.ts:81-181`

The `loginAction()` (line 25-46) validates the request origin, but `signupAction()` has no origin check. An attacker could craft a cross-site form that creates organizations in the victim's browser session.

**Fix:** Add the same origin validation from `loginAction` to `signupAction`.

---

### H-02: Rate limiting is in-memory only (High)

**File:** `src/lib/auth/rate-limit.ts:1-58`

The rate limiter uses an in-memory `Map`. On Cloudflare Workers, each request may hit a different isolate, making the rate limit ineffective.

**Impact:** Brute-force attacks on login PINs and passwords are not meaningfully rate-limited in production.

**Fix:** Use Cloudflare KV or D1 for distributed rate limiting, or add Cloudflare WAF rate-limiting rules.

---

### H-03: No rate limiting on most write endpoints (High)

**Files:** All POST/PUT/PATCH API routes except `/api/gift-cards`

Only the gift card endpoint has per-endpoint rate limiting. Other mutation endpoints (products, customers, employees, transactions) have no rate limiting.

**Fix:** Add rate limiting to all mutation endpoints, or add Cloudflare WAF rules for API rate limiting.

---

## 2. DATA LAYER

### H-04: Schema mismatch — `customers.tax_exempt` column missing (High)

**File:** `supabase/migrations/001_initial_schema.sql` (customers table)
**Code:** `src/lib/persistence/postgres-phase2.ts:32`

The code reads `r.tax_exempt` from query results, but the column doesn't exist in any migration. The value will always be `undefined`, causing `taxExempt` to default to `false` regardless of actual customer status.

**Impact:** Tax-exempt customers are charged tax.

**Fix:** Add migration: `ALTER TABLE customers ADD COLUMN tax_exempt BOOLEAN NOT NULL DEFAULT false;`

---

### H-05: `register_sessions.organization_id` is TEXT, not UUID (High)

**File:** `supabase/migrations/007_register_device_lock.sql:3`

```sql
ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS organization_id TEXT;
```

This should be `UUID` with a foreign key to `organizations(id)` and a NOT NULL constraint. TEXT allows arbitrary values and bypasses foreign key integrity.

**Fix:** New migration to alter the column type to UUID, add FK constraint, and set NOT NULL.

---

### M-01: N+1 query in stocktake acceptance (Medium)

**File:** `src/lib/persistence/postgres-phase2.ts:645-658`

Each stocktake line runs 2 queries (UPDATE inventory + INSERT adjustment) in a loop. For a stocktake with 500 lines, that's 1000 queries.

**Fix:** Batch into a single `INSERT ... VALUES` for adjustments and use `UPDATE ... FROM (VALUES ...)` for inventory.

---

### M-02: Return action doesn't validate original transaction exists (Medium)

**File:** `src/app/register/return-action.ts:150-154`

```typescript
const { rows: origRows } = await client.query(
  `SELECT customer_id FROM transactions WHERE id = $1`,
  [input.originalTransactionId],
);
const customerId = origRows[0]?.customer_id;
```

If the original transaction doesn't exist, `customerId` is `undefined` and the store credit update is silently skipped even when `refundMethod === "store_credit"`.

**Fix:** Add explicit existence check: `if (origRows.length === 0) throw new Error("Original transaction not found");`

---

### M-03: Checkout action lacks client-side idempotency key (Medium)

**File:** `src/app/register/checkout-action.ts:22-481`

A new `transactionId` is generated on every call. If the network retries or the user double-clicks, duplicate transactions are created. The `FOR UPDATE` lock on register_sessions prevents concurrent execution but not sequential retries.

**Fix:** Accept an idempotency key from the client, check against the `idempotency_keys` table (migration 008 already exists), and return the cached result for duplicates.

---

### M-04: `pool.query` used for audit events outside transactions (Medium)

**File:** `src/app/register/event-action.ts:70-83`

The audit event INSERT uses `pool.query` (no RLS context) instead of `orgQuery`. While the organization_id is included in the INSERT values, RLS policies on `audit_events` require `app.current_org_id` to be set for SELECT operations, creating inconsistency.

**Fix:** Use `orgQuery(input.organizationId, ...)` for audit inserts outside transactions.

---

## 3. ERROR HANDLING

### M-05: Missing ROLLBACK in event-action on failure (Medium)

**File:** `src/app/register/event-action.ts:46-66`

```typescript
const client = await orgTx(input.organizationId);
try {
  await client.query(...);
  await client.query("COMMIT");
} finally {
  client.release();
}
```

If the INSERT fails, the transaction is never explicitly rolled back. The `finally` block releases the connection without ROLLBACK. While PostgreSQL auto-rolls-back on connection release, this is not guaranteed behavior with connection pooling.

**Fix:** Add `catch (e) { await client.query("ROLLBACK"); throw e; }` before `finally`.

---

### L-01: Silent failure in return store credit path (Low)

**File:** `src/app/register/return-action.ts:148-159`

When `refundMethod === "store_credit"` but the original transaction has no `customer_id`, the store credit update is silently skipped with no error or warning. The customer doesn't receive their refund and there's no audit trail of the failure.

**Fix:** Throw an error if `customerId` is null when `refundMethod === "store_credit"`.

---

## 4. TYPE SAFETY

### M-06: Widespread `as any` usage (40+ instances) (Medium)

**Key files:**
- `src/app/api/products/route.ts` — 8 instances (lines 136, 185, 366, 424, 522, 536, 542, 548)
- `src/app/api/shift-close/route.ts` — 8 instances
- `src/app/api/eod-report/route.ts` — 6 instances
- `src/app/api/cash-drawer/route.ts` — 5 instances

Most occur in database row transformations where query results are untyped.

**Fix:** Define row types for each query using `interface` declarations or use a typed query builder.

---

### M-07: Unsafe `as string` casts on FormData (Medium)

**File:** `src/app/admin/gift-card-actions.ts:14-16`

```typescript
const code = formData.get("code") as string;
const amount = Number(formData.get("amount"));
```

`FormData.get()` returns `FormDataEntryValue | null`. The `as string` cast silently converts `null` to a type that passes subsequent checks.

**Fix:** Use explicit null checks: `const code = formData.get("code"); if (typeof code !== "string") throw ...`

---

## 5. PERFORMANCE

### M-08: `logTransactionEvents` is sequential, not batched (Medium)

**File:** `src/app/register/event-action.ts:105-109`

```typescript
export async function logTransactionEvents(inputs: TransactionEventInput[]): Promise<void> {
  for (const input of inputs) {
    await logTransactionEvent(input);
  }
}
```

Each event opens a separate transaction. For a checkout that logs 5+ events, this is 5 separate round-trips.

**Fix:** Batch all events into a single transaction with a multi-row INSERT.

---

### L-02: No cache headers on several API endpoints (Low)

Many API routes return sensitive data without explicit `Cache-Control` headers. While the middleware sets security headers, individual responses can be cached by intermediaries.

**Files:** `src/app/api/audit/route.ts`, `src/app/api/employees/route.ts`, `src/app/api/dashboard/route.ts`

**Fix:** Add `Cache-Control: no-store, private` to all authenticated API responses.

---

## 6. STATE MANAGEMENT

### M-09: Approval action organization scope not validated (Medium)

**File:** `src/app/register/approval-action.ts:62`

```typescript
const store = await readStore(request.organizationId);
```

The `organizationId` comes from client input. Even after adding auth (per C-03), the session's org must be cross-checked against the request's org to prevent cross-tenant data access.

**Fix:** After auth check, assert `session.employee.organizationId === request.organizationId`.

---

## 7. API DESIGN

### M-10: Export route vulnerable to Content-Disposition header injection (Medium)

**File:** `src/app/api/export/route.ts:34-35, 53`

```typescript
const from = sp.get("from") || "2020-01-01";
const to = sp.get("to") || new Date().toISOString().slice(0, 10);
filename = `transactions_${from}_to_${to}.csv`;
```

User-controlled `from`/`to` values are interpolated into the `Content-Disposition` header without validation. A crafted value like `2024"; malicious-header: value` could inject headers.

**Fix:** Validate that `from` and `to` match `/^\d{4}-\d{2}-\d{2}$/` before use.

---

### M-11: Inconsistent pagination — some list endpoints unbounded (Medium)

**Files without pagination:**
- `src/app/api/barcode-lookup/route.ts` — returns all matching products
- `src/app/api/clock-in-data/route.ts` — returns all clock entries for a location
- `src/app/api/reorder-suggestions/route.ts` — returns all suggestions
- `src/app/api/reports/route.ts` — returns unbounded report data

While paginated endpoints correctly enforce max page sizes (50-200), these endpoints return full result sets.

**Fix:** Add `LIMIT` clauses with reasonable defaults (100-500) to prevent large responses.

---

## 8. TESTING

### H-06: Zero automated test coverage (High)

**Finding:** No test files, no test framework, no test dependencies, and no test scripts in `package.json`.

- No `jest.config.*`, `vitest.config.*`, or `playwright.config.*`
- No `@testing-library/*`, `jest`, `vitest`, or `cypress` in dependencies
- No `test` or `e2e` npm scripts

**Impact:** All code changes rely entirely on manual testing. Regressions in checkout, inventory, authentication, and financial calculations go undetected.

**Fix:** Set up Vitest for unit/integration tests. Priority test targets:
1. `checkout-action.ts` — financial calculations, inventory deduction
2. `session.ts` — auth flows, session expiration
3. `permissions.ts` — RBAC enforcement
4. `postgres-store.ts` — data layer transactions

---

## 9. CODE QUALITY

### H-07: Incomplete feature shipped — bundle manager (High)

**File:** `src/components/admin/bundle-manager.tsx:44`

```typescript
// TODO: wire up server action for bundle creation
```

The UI component exists and is rendered, but the save action is a no-op. Users can fill out the form and "save" without anything persisting.

**Fix:** Either implement the server action or remove the component from the UI until ready.

---

### L-03: God components (8 files > 700 lines) (Low)

| File | Lines |
|------|-------|
| `src/components/register/pos-terminal.tsx` | 1193 |
| `src/app/admin/settings/page.tsx` | 1127 |
| `src/components/admin/admin-console.tsx` | 1102 |
| `src/components/admin/daily-manager-report.tsx` | 1082 |
| `src/app/admin/products/page.tsx` | 993 |
| `src/app/admin/purchase-orders/page.tsx` | 934 |
| `src/components/admin/order-calendar.tsx` | 868 |
| `src/components/admin/discount-scheduler.tsx` | 756 |

**Mitigating factor:** `pos-terminal.tsx` uses 20+ `useCallback` and `useMemo` hooks properly — it's large but well-optimized.

**Fix:** Extract logical sections into subcomponents. Priority: `admin-console.tsx` and `settings/page.tsx`.

---

### L-04: Duplicate boilerplate across API routes (Low)

**Pattern:** Auth check → org context → try/catch → orgTx/orgQuery → COMMIT/ROLLBACK → error response. Repeated across all 35 API routes (~49 transaction patterns).

**Fix:** Create a `withAuth(permission, handler)` wrapper that handles session validation, org context, and error formatting.

---

## 10. DEPLOYMENT — Cloudflare Workers

### H-08: `node:crypto` imports rely on `nodejs_compat` flag (High)

**Files:**
- `src/lib/auth/crypto.ts:1` — `import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto"`
- `src/lib/auth/session.ts:3` — `import { randomUUID } from "node:crypto"`
- `src/app/register/event-action.ts:3` — `import { randomUUID } from "node:crypto"`
- 15+ other files using `randomUUID`

The `nodejs_compat` compatibility flag in `wrangler.jsonc` enables these, but:
1. `scryptSync` is synchronous and blocks the Worker thread — Workers have a 30ms CPU limit on the free plan
2. The compat layer adds overhead and may have subtle behavioral differences

**Fix:** Migrate to Web Crypto API:
- `crypto.randomUUID()` (already available)
- `crypto.getRandomValues()` instead of `randomBytes()`
- Use async `crypto.subtle.deriveBits()` with PBKDF2 instead of `scryptSync`

---

### M-12: `process.env` used alongside Cloudflare env bindings (Medium)

**File:** `src/lib/env.ts`, `src/app/api/email-receipt/route.ts:44`

Cloudflare Workers provide env through the request context, not `process.env`. The `nodejs_compat` flag shims `process.env` but only for variables defined in `wrangler.jsonc [vars]`. Secrets like `RESEND_API_KEY` and `DATABASE_URL` must be set via `wrangler secret put`.

**Risk:** Developers may add env vars to `.env.local` and assume they work in production.

**Fix:** Document which vars must be set via `wrangler secret put` vs `[vars]` in wrangler.jsonc.

---

## 11. ACCESSIBILITY

### L-05: Minimal ARIA labeling (Low)

Only 2 `aria-label` attributes found in the entire codebase:
- `src/components/register/keyboard-shortcuts.tsx:234` — "Close shortcuts"
- `src/components/register/theme-toggle.tsx:41` — "Switch to dark/light mode"

**Missing:**
- No `aria-label` on icon-only buttons (the POS terminal has many)
- No `role="dialog"` on modal components
- No `aria-live` regions for dynamic content (cart updates, toasts)
- No skip-navigation links

**Fix:** Audit all interactive elements and add appropriate ARIA attributes. Priority: POS terminal buttons used by cashiers all day.

---

### L-06: Empty alt attributes on images (Low)

**File:** `src/components/admin/barcode-lookup.tsx` — `alt=""`

Empty alt text makes images invisible to screen readers. If decorative, use `role="presentation"`. If meaningful, add descriptive text.

---

### L-07: No focus management in modals (Low)

Modal components (`approval-modal.tsx`, various admin modals) don't trap focus or return focus to trigger element on close. This breaks keyboard navigation for users who rely on Tab.

**Fix:** Add focus trap (e.g., `@headlessui/react` Dialog) or implement manual focus management.

---

### L-08: No visible focus indicators on custom buttons (Low)

Many buttons use Tailwind classes without explicit `focus-visible:ring-*` styles, relying on browser defaults which may be invisible on colored backgrounds.

**Fix:** Add consistent `focus-visible:ring-2 focus-visible:ring-offset-2` to button components.

---

## Additional Findings

### L-09: CSP allows `unsafe-inline` for styles (Low)

**File:** `middleware.ts:36`

```
style-src 'self' 'unsafe-inline'
```

This weakens CSS injection protection. It's common in Next.js apps due to inline style usage, but could be tightened with nonce-based CSP.

---

### L-10: Console warnings in production API routes (Low)

**File:** `src/app/api/offline-sync/route.ts:121`

```typescript
console.warn("[offline-sync] tax rate lookup failed, using default 0.1025");
```

Falling back to a hardcoded tax rate silently is dangerous for a financial application. This should be a proper error or at minimum an audit log entry.

**Fix:** Log to audit_events with severity "warning" and surface in the admin dashboard.

---

## Positive Security Findings

The following are done well and should be preserved:

- **RLS enforcement** — 27+ tables with comprehensive policies, org isolation via `app.current_org_id`
- **Parameterized queries** — No SQL injection found; all user input goes through `$1, $2` placeholders
- **UUID validation** — `orgTx`/`orgQuery` validate UUID format before string interpolation in `SET LOCAL`
- **Password hashing** — scrypt with random salt + timing-safe comparison
- **Session management** — HTTP-only cookies, SameSite=lax, 8-hour abandoned session guard, device ID verification
- **XSS protection** — Proper escaping in email HTML (`esc()`) and SVG generation (`escXml()`)
- **CORS** — Allowlist-based origin validation, no wildcard
- **Security headers** — CSP, X-Frame-Options DENY, HSTS-ready, Permissions-Policy
- **Checkout safety** — Advisory locks, FOR UPDATE on inventory, price tampering detection
- **Audit logging** — Present on auth, CRUD, and financial operations
- **Privilege escalation prevention** — `canManageEmployeeRole()` blocks managers from assigning owner/manager roles
- **Session invalidation on role change** — `invalidateEmployeeSessions()` called on role update/deactivation
- **Service worker** — Correctly excludes all `/api/` routes from caching
- **Deadlock prevention** — Inventory rows locked in deterministic order

---

## Priority Fix Order

1. **Immediate (Critical):** C-01 through C-05 — Unprotected server actions and error detail leak
2. **This week (High):** H-01 through H-08 — Auth gaps, schema fixes, rate limiting, Workers compat
3. **This sprint (Medium):** M-01 through M-12 — Idempotency, N+1, type safety, pagination
4. **Backlog (Low):** L-01 through L-10 — Accessibility, code quality, CSP tightening
