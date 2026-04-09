# BUPOS Deep Code Audit Report

**Date:** 2026-04-08
**Codebase:** BasicUniformPOS (BUPOS) — Retail POS System
**Stack:** Next.js 16.2.1, React 19, Cloudflare Workers (OpenNext), Neon/Supabase PostgreSQL
**Scope:** Full codebase at `/Users/edison/Projects/bupos/code`

---

## Table of Contents

1. [Architecture & Structure](#1-architecture--structure)
2. [Security](#2-security)
3. [Data Layer](#3-data-layer)
4. [Error Handling](#4-error-handling)
5. [Type Safety](#5-type-safety)
6. [Performance](#6-performance)
7. [State Management](#7-state-management)
8. [API Design](#8-api-design)
9. [Testing](#9-testing)
10. [DX / Maintainability](#10-dx--maintainability)
11. [Deployment](#11-deployment)
12. [Accessibility](#12-accessibility)
13. [Prioritized Action List](#prioritized-action-list-top-10)

---

## 1. Architecture & Structure

### Overview

The codebase is a monolithic Next.js app with a clear domain-oriented structure:

```
src/
├── app/              # Next.js App Router (pages, layouts, API routes, server actions)
│   ├── admin/        # Admin console (protected)
│   ├── register/     # POS terminal (PIN-authenticated)
│   ├── api/          # 33+ REST API routes
│   └── actions/      # Server actions (auth)
├── components/
│   ├── admin/        # 40+ admin components
│   ├── register/     # 25+ register/POS components
│   ├── auth/         # Login/signup forms
│   ├── layout/       # Navigation, shells
│   └── ui/           # Shared UI primitives
└── lib/
    ├── auth/         # Session management, crypto, rate limiting
    ├── authz.ts      # RBAC permission matrix
    ├── persistence/  # Dual-mode data layer (JSON file / PostgreSQL)
    ├── domain/       # Type definitions, permissions
    ├── cart/          # Shopping cart logic
    ├── offline/      # IndexedDB + sync service
    ├── behavior/     # Employee behavior flagging engine
    ├── receipt/       # Receipt formatting + ESC/POS
    ├── db/           # Neon pool + RLS context helpers
    └── config/       # Timing, thresholds
```

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 1.1 | **God files exceeding 500 lines** — Multiple files are too large and mix concerns | 🟡 Medium | See list below |
| 1.2 | **Dual persistence layer adds complexity** — JSON file store and PostgreSQL coexist, switched via `USE_POSTGRES` env var. All production code must maintain both paths. | 🟡 Medium | `src/lib/persistence/store.ts` |
| 1.3 | **Admin settings page is monolithic** — 1127-line single component with all settings UI inline | 🟠 High | `src/app/admin/settings/page.tsx` |
| 1.4 | **Product API route handles 6 HTTP methods + CSV import** — 759 lines in one file | 🟠 High | `src/app/api/products/route.ts` |
| 1.5 | **Clear domain separation** — Good separation between admin, register, and API concerns | 🟢 Strength | `src/app/` |
| 1.6 | **Well-organized component library** — Components grouped by domain (admin, register, auth, ui) | 🟢 Strength | `src/components/` |

**God files (500+ lines):**

| File | Lines | Concern |
|------|-------|---------|
| `src/app/admin/settings/page.tsx` | 1127 | All settings UI |
| `src/app/admin/products/page.tsx` | 993 | Product catalog management |
| `src/app/admin/purchase-orders/page.tsx` | 934 | PO workflow |
| `src/lib/persistence/postgres-phase2.ts` | 883 | Gift cards, store credit, layaway, stocktakes, transfers |
| `src/lib/persistence/postgres-store.ts` | 880 | Core CRUD, audit logging, caching |
| `src/app/api/products/route.ts` | 759 | Product API (6 methods + CSV import) |
| `src/app/admin/receiving/page.tsx` | 727 | Receiving workflow |
| `src/app/admin/actions.ts` | 695 | Admin server actions |
| `src/lib/auth/session.ts` | 666 | Session management (admin + register) |
| `src/lib/domain/types.ts` | 581 | Domain model types |

---

## 2. Security

### Strengths
- Scrypt password hashing with salt and timing-safe comparison (`src/lib/auth/crypto.ts`)
- Cookie flags properly set: `httpOnly: true`, `sameSite: "lax"`, `secure` in production
- Strong Content Security Policy in middleware
- Multi-layer RBAC with permission matrix and role hierarchy (`src/lib/authz.ts`)
- Tenant isolation via `SET LOCAL app.current_org_id` RLS context
- UUID validation on org IDs before SQL interpolation
- Audit logging on sensitive operations
- Session expiry: 7-day admin, 1-day register, 8-hour stale detection

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 2.1 | **SQL injection risk via string interpolation in SET LOCAL** — orgId is validated with UUID regex, but multiple API routes bypass the validated helpers and interpolate directly | 🔴 Critical | `src/lib/db/index.ts:46,61`; `src/app/api/products/route.ts:225,315,484,529`; `src/app/api/purchase-orders/route.ts:111,127`; `src/app/api/receiving/route.ts` |
| 2.2 | **Rate limiting is in-memory only** — Each Cloudflare Workers isolate has its own rate limit state. Distributed brute force bypasses all limits. | 🔴 Critical | `src/lib/auth/rate-limit.ts` (entire file) |
| 2.3 | **No RLS policies defined in database** — Zero `CREATE POLICY` or `ENABLE ROW LEVEL SECURITY` statements. Tenant isolation is entirely app-layer. | 🔴 Critical | `supabase/migrations/` |
| 2.4 | **Sessions table missing `organization_id`** — Cross-org session confusion possible if session ID is guessed/leaked | 🟠 High | `supabase/migrations/001_initial_schema.sql:370-382` |
| 2.5 | **XSS via innerHTML in barcode label printer** — Direct innerHTML assignment from DOM content | 🟠 High | `src/components/admin/barcode-label-printer.tsx:151` |
| 2.6 | **SVG text injection in barcode generation** — User-controlled text embedded in SVG without escaping | 🟡 Medium | `src/components/admin/barcode-label-printer.tsx:79` |
| 2.7 | **`dangerouslySetInnerHTML` for service worker registration** — Could be a standard `<script>` tag | 🟡 Medium | `src/app/layout.tsx:34-36` |
| 2.8 | **Email receipt authorization logic is incorrect** — Allows register sessions without proper role check; `hasPermission` check uses wrong permission key | 🟠 High | `src/app/api/email-receipt/route.ts:31-32` |
| 2.9 | **No input validation library (Zod/etc.)** — All API inputs parsed with raw `await req.json()` and manual checks | 🟠 High | All 33 API routes |
| 2.10 | **PIN collision detection is O(n)** — Loads all PIN hashes and verifies each one sequentially. Timing attack vector + DoS amplification. | 🟡 Medium | `src/app/api/employees/route.ts:163-177,420-438` |
| 2.11 | **Sensitive data in console.error logs** — Customer emails, transaction IDs logged in production | 🟡 Medium | `src/app/api/email-receipt/route.ts:44`; `src/app/api/barcode-lookup/route.ts:74` |
| 2.12 | **No email verification on signup** — Accounts created with unverified email addresses | 🟡 Medium | `src/app/actions/auth.ts:81-181` |
| 2.13 | **Rate limiting only applied to gift card endpoint** — Login, cash drawer, and inventory mutations unprotected | 🟠 High | `src/app/api/gift-cards/route.ts:123` (only instance) |

---

## 3. Data Layer

### Architecture
- Direct Postgres via `@neondatabase/serverless` (NOT Supabase SDK)
- Connection pool: max 10 remote, 5 local; 30s statement timeout
- RLS context via `SET LOCAL app.current_org_id` in transactions
- In-memory caching with 30s TTL per org
- Dual-mode: JSON file store for local dev, PostgreSQL for production

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 3.1 | **No database-level RLS policies** — All tenant isolation relies on application code correctly filtering by `organization_id`. A single missed WHERE clause leaks cross-tenant data. | 🔴 Critical | `supabase/migrations/` |
| 3.2 | **N+1 query: tender INSERT loop** — Loop over tenders array inserting one row per iteration during checkout | 🟠 High | `src/app/register/checkout-action.ts:176-186` |
| 3.3 | **N+1 query: modifier group INSERT loop** — One INSERT per modifier group when creating products | 🟡 Medium | `src/lib/persistence/postgres-store.ts:195-196` |
| 3.4 | **Barcode lookup uses 2 separate queries** — Product lookup + inventory lookup should be a single JOIN | 🟡 Medium | `src/app/api/barcode-lookup/route.ts` |
| 3.5 | **SELECT * overfetching** — Many queries fetch all columns when only a few are needed | 🟡 Medium | `src/lib/auth/session.ts:56`; `src/lib/persistence/postgres-phase2.ts:213,259`; `src/app/api/customers/route.ts`; `src/app/api/suppliers/route.ts:22`; ~10 more files |
| 3.6 | **Gift card operations not in explicit transaction** — FOR UPDATE lock used but audit event is fire-and-forget | 🟠 High | `src/app/api/gift-cards/route.ts` |
| 3.7 | **Supplier mutations not transaction-wrapped** — INSERT + audit event not atomic | 🟡 Medium | `src/app/api/suppliers/route.ts:45-64` |
| 3.8 | **Store credit issuance has no validation** — No check that amount is positive, no check customer exists, no protection against negative balances | 🟠 High | `src/lib/persistence/postgres-phase2.ts:385-408` |
| 3.9 | **Products API has no pagination on main query** — Could return thousands of rows for large catalogs | 🟡 Medium | `src/app/api/products/route.ts:62-101` |
| 3.10 | **No real-time subscriptions** — HTTP polling + cache invalidation only; no Supabase Realtime | 🟢 Low | N/A |
| 3.11 | **Types are hand-written, not generated from schema** — Schema drift risk between SQL and TypeScript | 🟡 Medium | `src/lib/domain/types.ts` |
| 3.12 | **Missing domain constraints in schema** — No CHECK constraint for `price > 0`, amount validation is app-only | 🟡 Medium | `supabase/migrations/001_initial_schema.sql` |
| 3.13 | **In-memory caches are process-local** — Break on multi-instance deployment (Cloudflare Workers) | 🟠 High | `src/lib/persistence/postgres-store.ts:6-20`; `src/app/api/products/route.ts:13` |

### Schema Strengths
- 60+ indexes covering foreign keys and business keys
- UNIQUE constraints on gift card codes, promo codes, customer emails
- Idempotency keys for returns/transfers/shifts (migration 008)
- Optimistic locking on products (migration 006)
- Advisory locks for checkout atomicity

---

## 4. Error Handling

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 4.1 | **17 instances of `.catch(() => {})` silently swallowing errors** — Audit events, cache invalidations, and notifications fail without any logging or alerting | 🔴 Critical | `src/app/api/employees/route.ts:229,351`; `src/app/api/store-credit/route.ts:158`; `src/app/api/suppliers/route.ts:57`; `src/app/api/purchase-orders/route.ts:153`; `src/app/api/products/route.ts:284,389,447`; `src/app/api/gift-cards/route.ts:168`; `src/app/api/customers/route.ts:221`; `src/app/api/receiving/route.ts:243`; `src/app/api/loyalty/route.ts:216`; `src/app/admin/actions.ts:69`; `src/components/register/offline-status-bar.tsx:19`; `src/app/actions/auth.ts:68,168` |
| 4.2 | **Only 2 error boundaries in 100+ client components** — A single component crash takes down the entire page region | 🟠 High | Only `src/app/signup/error.tsx` and `src/app/admin/error.tsx` exist |
| 4.3 | **Generic error responses without context** — Most API routes return vague messages like `"Failed to fetch cash drawer data"` with no error codes or correlation IDs | 🟡 Medium | `src/app/api/cash-drawer/route.ts:34-36`; `src/app/api/reports/route.ts:85-86`; `src/app/api/employees/route.ts:97-98` |
| 4.4 | **No structured logging** — Mix of `console.error()` and silent failures; no log levels, no request tracing, no correlation IDs | 🟡 Medium | All API routes |
| 4.5 | **No loading.tsx files** — Route-level loading states are missing across the app router | 🟡 Medium | `src/app/` |
| 4.6 | **Unhandled edge cases in checkout flow** — `redirect()` calls after async operations could fail silently | 🟡 Medium | `src/app/register/checkout-action.ts` |

---

## 5. Type Safety

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 5.1 | **60+ uses of `any` type across 20+ files** — Defeats TypeScript's compile-time safety | 🟠 High | `src/app/api/reports/route.ts` (11 instances); `src/app/api/cash-drawer/route.ts` (5 instances); `src/app/api/eod-report/route.ts` (8 instances); `src/app/api/shift-close/route.ts` (7 instances); `src/app/api/products/route.ts` (7 instances); `src/app/admin/reports/page.tsx` (28 instances); `src/app/register/page.tsx:48-49`; `src/lib/persistence/postgres-store.ts:20` |
| 5.2 | **35+ non-null assertions (`!`) without guards** — Will crash at runtime if assumptions are wrong | 🟠 High | `src/app/register/layaway-action.ts:62,109,132,186` (`cart.customerId!` x4); `src/app/register/shift-actions.ts` (8 instances of `context.activeShift!`); `src/app/admin/actions.ts:364,367,372,378,381-383` (7 assertions on `target!`/`employee!`); `src/components/register/register-console.tsx:29` |
| 5.3 | **No runtime validation library (Zod/etc.) at API boundaries** — All `await req.json()` results used without schema validation | 🟠 High | All 33 API routes |
| 5.4 | **Unsafe `as any` casts for Web Serial API** — Suppresses type errors for browser APIs | 🟡 Medium | `src/components/register/receipt-view.tsx:453`; `src/components/register/printer-connect.tsx:15,17,27`; `src/components/register/register-console-client.tsx:143` |
| 5.5 | **`useRef<any>(null)` pattern** — Loses type safety on ref access | 🟡 Medium | `src/components/register/printer-connect.tsx:15` |
| 5.6 | **Unsafe type cast on event target** — `e.target.value as any` instead of type-safe union | 🟢 Low | `src/app/admin/products/page.tsx:353` |

---

## 6. Performance

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 6.1 | **100+ files with `"use client"` — many unnecessarily** — Pages that could fetch data server-side are marked as client components, adding bundle size and round-trips | 🟠 High | `src/app/admin/products/page.tsx`; `src/app/admin/reports/page.tsx`; `src/app/admin/employees/page.tsx`; `src/app/admin/inventory/page.tsx` (all could be hybrid) |
| 6.2 | **Missing React.memo on list item components** — Product grids, cart items, calendar cells re-render on every parent update | 🟡 Medium | `src/app/admin/products/page.tsx:489` (ProductRow); `src/components/register/product-grid.tsx`; `src/components/register/cart-sidebar.tsx`; `src/components/admin/order-calendar.tsx` |
| 6.3 | **Only 4 Suspense boundaries in entire app** — No route-level `loading.tsx` files; no streaming for async data | 🟡 Medium | Only `src/components/register/register-console-client.tsx:23-27`; `src/app/admin/clock-in/page.tsx`; `src/components/admin/role-gate.tsx`; `src/components/admin/bulk-product-import.tsx` |
| 6.4 | **Only 2 files use `next/image`** — Product images, avatars, and other assets likely use raw `<img>` tags without optimization | 🟡 Medium | `src/components/admin/admin-console.tsx`; `src/components/admin/barcode-lookup.tsx` |
| 6.5 | **Expensive computations in render paths** — Set/Map creation and array operations on every render without memoization | 🟡 Medium | `src/components/register/register-console.tsx:44-73`; `src/app/register/page.tsx:48-49`; `src/components/admin/daily-manager-report.tsx:186` |
| 6.6 | **In-memory caches have no eviction strategy** — Grow unbounded per org; no LRU or size limits | 🟡 Medium | `src/lib/persistence/postgres-store.ts:6-20` |
| 6.7 | **Manual response caching instead of Next.js ISR** — Hand-rolled TTL caches could use `revalidateTag()` | 🟢 Low | `src/app/api/products/route.ts:13-15` |

---

## 7. State Management

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 7.1 | **No centralized state management** — Three different patterns coexist: server-side store, scattered useState (13 hooks in one component), and minimal Context API | 🟡 Medium | `src/components/register/register-console-client.tsx:120-134` (13 state vars); `src/app/admin/products/page.tsx:67-77` (8 state vars); `src/components/register/cart-sidebar.tsx:35-44` (10 state vars) |
| 7.2 | **Potential stale closures in useEffect** — Effect captures `totals.itemCount` and `cart.items` but ref may be stale | 🟡 Medium | `src/components/register/cart-sidebar.tsx:47-56` |
| 7.3 | **Race condition risk in checkout advisory locks** — If server dies while holding lock, no automatic cleanup (PostgreSQL session-level locks persist until disconnect) | 🟡 Medium | `src/app/register/checkout-action.ts:98-150` |
| 7.4 | **Context providers not memoized** — Context value changes trigger re-renders of all consumers even if specific consumed values haven't changed | 🟡 Medium | `src/components/ui/virtual-input-context.tsx` |
| 7.5 | **Prop drilling instead of context** — Deep prop passing visible in register components | 🟢 Low | `src/components/register/` |
| 7.6 | **No optimistic updates on admin mutations** — Employee role toggle, product edits wait for server round-trip | 🟢 Low | `src/app/admin/actions.ts:364-383` |

---

## 8. API Design

### Endpoint Inventory

33+ REST API routes covering: products, customers, employees, inventory, transactions, shifts, cash-drawer, gift-cards, store-credit, loyalty, audit, dashboard, reports, email-receipt, barcode-lookup, returns (3 sub-routes), promo-codes, transfers, receiving, purchase-orders, suppliers, expenses, offline-sync, customer-display, tax-config, clock-in-data, reorder-suggestions, export, health, settings, shift-report, shift-close, eod-report.

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 8.1 | **Rate limiting only on 1 of 33 endpoints** — Only gift card endpoint is rate-limited; login, PIN auth, cash drawer, and all mutations are unprotected | 🟠 High | `src/app/api/gift-cards/route.ts:123` |
| 8.2 | **Duplicate/redundant auth checks** — Some routes have identical authorization checks repeated on consecutive lines | 🟡 Medium | `src/app/api/clock-in-data/route.ts:9-12`; `src/app/api/expenses/route.ts:14` |
| 8.3 | **Suppliers GET bypasses RLS context** — Uses `pool.query()` directly instead of `orgQuery()` | 🟠 High | `src/app/api/suppliers/route.ts:21-22` |
| 8.4 | **Inconsistent pagination strategies** — Cursor-based (customers, audit, transactions) vs. offset-based (employees, shifts, returns) | 🟡 Medium | Various API routes |
| 8.5 | **DELETE returns 200 instead of 204** — Non-standard REST response codes | 🟢 Low | `src/app/api/products/route.ts` (DELETE handler) |
| 8.6 | **Mixed response key casing** — Some endpoints return camelCase, others snake_case | 🟡 Medium | `src/app/api/customers/route.ts` (camelCase); `src/app/api/transactions/route.ts` (snake_case) |
| 8.7 | **No OpenAPI/Swagger documentation** — 33 endpoints with no API contract documentation | 🟡 Medium | N/A |
| 8.8 | **Dynamic imports in route handlers add latency** — `await import()` in hot path instead of top-level imports | 🟢 Low | `src/app/api/customers/route.ts:11` |

---

## 9. Testing

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 9.1 | **ZERO test files in entire codebase** — No unit, integration, or e2e tests. No test runner configured. No test dependencies in `package.json`. | 🔴 Critical | Entire codebase |

**Untested critical paths:**

| Critical Path | Risk Level | Impact of Bug |
|---------------|-----------|---------------|
| Checkout/payment flow | 🔴 Critical | Financial loss, incorrect charges |
| PIN authentication | 🔴 Critical | Unauthorized POS access |
| Session management | 🔴 Critical | Auth bypass, session hijacking |
| Inventory adjustments | 🟠 High | Stock discrepancies |
| Cash drawer reconciliation | 🟠 High | Cash shortages undetected |
| Gift card activate/redeem | 🟠 High | Double-spending, balance errors |
| Offline sync reconstruction | 🟠 High | Lost transactions |
| RBAC permission checks | 🟠 High | Privilege escalation |
| Store credit issuance | 🟠 High | Unbounded credit creation |
| Multi-tenant data isolation | 🔴 Critical | Cross-tenant data leakage |

---

## 10. DX / Maintainability

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 10.1 | **No TODO/FIXME/HACK comments found** — Unusual; suggests tech debt is undocumented | 🟢 Low | N/A |
| 10.2 | **Audit event failures silently swallowed** — 17 `.catch(() => {})` calls make audit trail unreliable and debugging impossible | 🟠 High | See §4.1 for full list |
| 10.3 | **Inconsistent parameter naming** — `req` vs `request` used interchangeably across API routes | 🟢 Low | Various API routes |
| 10.4 | **Repeated auth check boilerplate** — Same ~5 lines of auth + orgId extraction duplicated in ~30 routes | 🟡 Medium | All API routes |
| 10.5 | **Cache invalidation scattered across files** — No centralized cache management; invalidation calls mixed into business logic | 🟡 Medium | `src/lib/persistence/postgres-store.ts`; various API routes |
| 10.6 | **Large route files mix HTTP concerns with business logic** — Product route handles routing, validation, queries, caching, and CSV parsing | 🟡 Medium | `src/app/api/products/route.ts` (759 lines) |
| 10.7 | **Dual persistence mode adds maintenance burden** — Every data operation must work with both JSON files and PostgreSQL | 🟡 Medium | `src/lib/persistence/store.ts` |

---

## 11. Deployment

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 11.1 | **In-memory state doesn't survive isolate recycling** — Rate limits, caches, and Maps reset when Cloudflare recycles the Worker isolate | 🟠 High | `src/lib/auth/rate-limit.ts`; `src/lib/persistence/postgres-store.ts:6-20`; `src/app/api/products/route.ts:13` |
| 11.2 | **`nodejs_compat` flag required** — Code uses Node.js APIs (crypto, etc.) that require the compatibility flag | 🟡 Medium | `wrangler.jsonc` |
| 11.3 | **Hardcoded default org/location UUIDs** — Fallback UUIDs embedded in source code | 🟡 Medium | `src/lib/env.ts:7-8` |
| 11.4 | **No startup validation of required env vars** — Missing `DATABASE_URL` or `RESEND_API_KEY` fails at runtime, not at boot | 🟡 Medium | `src/lib/env.ts` |
| 11.5 | **No `runtime = 'edge'` declarations** — Routes don't explicitly opt into edge runtime; rely on OpenNext adapter | 🟢 Low | All route files |
| 11.6 | **`process.env` used instead of Cloudflare env bindings** — Works via `nodejs_compat` but isn't idiomatic for Workers | 🟢 Low | `src/lib/env.ts` |
| 11.7 | **CORS allows localhost:3000 in production** — Middleware CORS whitelist includes development origin | 🟡 Medium | `src/middleware.ts` |

---

## 12. Accessibility

### Findings

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 12.1 | **Only 12 ARIA attributes across 119 React components** — Vast majority of interactive elements lack accessibility labels | 🟠 High | Entire `src/components/` |
| 12.2 | **No alt text on images** — Zero `alt=` attributes found in component grep | 🟠 High | Product images, avatars across admin and register UIs |
| 12.3 | **No `role="dialog"` or `aria-modal` on modals** — 15+ modal components (checkout, return, approval, discount, void, etc.) lack dialog semantics | 🟠 High | `src/components/register/*.tsx` (all modals) |
| 12.4 | **No `aria-live` regions for dynamic content** — Error messages, cart updates, and status changes not announced to screen readers | 🟡 Medium | Register and admin UIs |
| 12.5 | **No `tabindex` management** — Focus not trapped in modals, no skip-to-content links | 🟡 Medium | All modal components |
| 12.6 | **No `loading.tsx` skeleton UIs** — Screen readers get no indication of loading state | 🟡 Medium | All routes |
| 12.7 | **PIN input may lack proper input type** — PIN entry forms may not use `type="password"` or `inputmode="numeric"` | 🟡 Medium | `src/components/register/pin-login-form.tsx` |

---

## Prioritized Action List (Top 10)

| Priority | Action | Category | Severity | Effort |
|----------|--------|----------|----------|--------|
| **1** | **Add test infrastructure and write tests for checkout, auth, and inventory** — Zero test coverage on financial and security-critical paths is the single biggest risk | Testing | 🔴 Critical | Large |
| **2** | **Enable database-level RLS policies** — App-layer tenant isolation alone is insufficient; a single missed WHERE clause leaks all tenant data. Add `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` for all tables using `app.current_org_id`. | Security / Data | 🔴 Critical | Medium |
| **3** | **Implement distributed rate limiting** — Replace in-memory rate limiter with Cloudflare KV or D1-backed solution. Apply to login, PIN auth, cash drawer, and all financial mutation endpoints. | Security | 🔴 Critical | Medium |
| **4** | **Eliminate silent error swallowing** — Replace all 17 `.catch(() => {})` patterns with proper error logging. Audit event failures should at minimum be logged; consider making them part of the transaction. | Error Handling | 🔴 Critical | Small |
| **5** | **Add runtime input validation (Zod) to all API routes** — Parse and validate all `req.json()` inputs with schemas. This prevents type coercion errors, missing fields, and injection attacks in one sweep. | Security / Types | 🟠 High | Medium |
| **6** | **Fix SQL interpolation consistency** — Ensure ALL `SET LOCAL app.current_org_id` calls go through the validated `orgTx()`/`orgQuery()` helpers. Remove direct string interpolation from API routes. | Security | 🟠 High | Small |
| **7** | **Add error boundaries to all page routes** — Create a shared `ErrorBoundary` wrapper and add `error.tsx` files to all route segments (especially `/register/` and `/admin/` sub-routes). | Error Handling | 🟠 High | Small |
| **8** | **Fix suppliers GET RLS bypass and email-receipt auth** — `suppliers` GET uses `pool.query()` directly (bypasses tenant isolation). `email-receipt` POST has incorrect permission check logic. | Security | 🟠 High | Small |
| **9** | **Reduce `any` types and non-null assertions** — Replace 60+ `any` types with proper interfaces. Add null guards before 35+ `!` assertions. Focus on API routes and checkout flow first. | Type Safety | 🟠 High | Medium |
| **10** | **Add ARIA labels, alt text, and dialog semantics** — Focus on register UI (primary user-facing surface): add `role="dialog"`, `aria-label` to all buttons, `alt` to all images, and `aria-live` regions for cart/error updates. | Accessibility | 🟠 High | Medium |

### Additional High-Value Improvements (Next 10)

| Priority | Action | Category |
|----------|--------|----------|
| 11 | Convert unnecessary client components to server components | Performance |
| 12 | Add Suspense boundaries and `loading.tsx` files to all routes | Performance |
| 13 | Batch N+1 tender INSERTs in checkout to single VALUES clause | Data Layer |
| 14 | Add `organization_id` to sessions table | Security |
| 15 | Wrap gift card and supplier operations in explicit transactions | Data Layer |
| 16 | Add store credit amount validation (positive amounts, balance checks) | Data Layer |
| 17 | Split god files (settings page, product API, persistence stores) | Architecture |
| 18 | Add products pagination and consolidate pagination strategy | API Design |
| 19 | Remove localhost from production CORS whitelist | Deployment |
| 20 | Add structured logging with request correlation IDs | DX |

---

## Summary Statistics

| Category | 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low |
|----------|------------|---------|-----------|--------|
| Architecture | 0 | 2 | 1 | 2 |
| Security | 3 | 4 | 4 | 0 |
| Data Layer | 1 | 3 | 5 | 1 |
| Error Handling | 1 | 1 | 4 | 0 |
| Type Safety | 0 | 3 | 2 | 1 |
| Performance | 0 | 1 | 5 | 1 |
| State Management | 0 | 0 | 4 | 2 |
| API Design | 0 | 2 | 3 | 2 |
| Testing | 1 | 0 | 0 | 0 |
| DX | 0 | 1 | 3 | 2 |
| Deployment | 0 | 1 | 3 | 2 |
| Accessibility | 0 | 3 | 3 | 0 |
| **Total** | **6** | **21** | **37** | **13** |

---

*Report generated by deep code audit on 2026-04-08. All file paths are relative to `/Users/edison/Projects/bupos/code/` unless otherwise noted.*
