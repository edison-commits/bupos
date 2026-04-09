# BUPOS Audit V3 — Dual-Agent Consolidated Report

**Date:** 2026-04-09  
**Agents:** Claude Code (Opus 4.6) + Codex (GPT-5.4)  
**Codebase:** Next.js 16.2.1, 206 files, 55K+ lines, post-fix-rounds 1 & 2

---

## How to Read This

Both agents audited independently. I merged their findings, deduplicated, and noted where they agreed (high confidence) vs. where only one caught something (worth investigating).

🟢 = Both agents found it  
🔵 = Claude Code only  
🟡 = Codex only

---

## CRITICAL (Fix Immediately)

### C-01 🟢 Unprotected server actions — no auth checks
**Files:** `src/app/register/event-action.ts`, `src/app/register/time-clock-action.ts`, `src/app/register/approval-action.ts`, `src/app/admin/behavior-actions.ts`
- `logTransactionEvent()`, `clockAction()`, `verifyManagerApproval()`, `runFlagEngineAction()`, `reviewFlagAction()` all accept client-supplied `organizationId`/`employeeId` with ZERO session validation
- **Impact:** Unauthenticated users can forge audit trails, clock in/out any employee, brute-force manager PINs, trigger behavior flag mutations
- **Fix:** Add `requireRegisterPermission('register.open')` or `requireAdminPermission()` to each; derive IDs from session

### C-02 🟢 Admin actions missing authorization
**Files:** `src/app/admin/gift-card-actions.ts`, `src/app/admin/store-credit-actions.ts`
- Both call `getAdminSession()` but skip `requireAdminPermission()` — any authenticated admin can activate gift cards and issue store credit regardless of role
- **Fix:** Use `requireAdminPermission()` with appropriate permission key

### C-03 🟢 Email receipt leaks error details
**File:** `src/app/api/email-receipt/route.ts:171`
- Returns raw Resend API error object (`details: err`) to client — may expose API keys, internal URLs
- **Fix:** Log server-side only, return generic error to client

### C-04 🟡 Email receipt trusts client-supplied data entirely
**File:** `src/app/api/email-receipt/route.ts:39-57`
- Never loads transaction from DB — emails whatever items/totals/tenders the caller sends
- **Impact:** Authenticated staff can send fraudulent receipts or use endpoint as email relay
- **Fix:** Load transaction server-side by ID, derive email from stored data

### C-05 🟡 Offline sync trusts client-supplied prices
**File:** `src/app/api/offline-sync/route.ts:47-159`
- Recomputes totals from client-provided `overridePrice`, `unitPrice`, `modifierTotal` without loading authoritative product pricing
- **Impact:** Compromised terminal can sync underpriced/zero-price transactions
- **Fix:** Reload server-side variant prices, re-run price-override approval logic

---

## HIGH (Fix This Week)

### H-01 🟢 Committed database credentials
**File:** `.env.local:3`
- Real Supabase pooler `DATABASE_URL` with password is in the repo
- **Fix:** Rotate password immediately, add `.env.local` to `.gitignore`, move secrets to Wrangler/Cloudflare secret storage

### H-02 🟢 CORS origin bypass
**File:** `middleware.ts:13-15`
- `origin.startsWith(...)` accepts `https://bupos.basicuniform.com.evil.tld`
- **Fix:** Use exact `===` comparison, don't reflect arbitrary origins

### H-03 🟢 Rate limiting is in-memory only
**File:** `src/lib/auth/rate-limit.ts`
- Per-isolate `Map` — meaningless across Cloudflare Workers isolates
- **Fix:** Use Cloudflare KV, D1, or Upstash for distributed rate limiting

### H-04 🟢 No rate limiting on most write endpoints
- Only gift cards endpoint has per-endpoint rate limiting
- **Fix:** Add rate limiting to all mutation endpoints or Cloudflare WAF rules

### H-05 🟢 Signup missing CSRF/origin validation
**File:** `src/app/actions/auth.ts:81-181`
- `loginAction()` validates origin but `signupAction()` does not
- **Fix:** Add same origin check to signup

### H-06 🟢 Zero test coverage
- No test framework, no test files, no test scripts
- **Fix:** Set up Vitest; priority targets: checkout-action, session, permissions, postgres-store

### H-07 🟢 `scryptSync` blocks Worker thread
**File:** `src/lib/auth/crypto.ts:1`
- Synchronous crypto on Workers with 30ms CPU limit
- **Fix:** Migrate to Web Crypto API (`crypto.subtle.deriveBits()` with PBKDF2)

### H-08 🟢 Bundle manager is a no-op
**File:** `src/components/admin/bundle-manager.tsx:44`
- UI renders but save action has `// TODO: wire up server action`
- **Fix:** Implement the action or hide the component

### H-09 🟡 Cross-tenant category leak
**File:** `src/lib/persistence/postgres-store.ts:109-116`
- `pgReadCategories()` queries ALL categories with no `organization_id` filter, caches globally
- **Impact:** Cross-tenant catalog metadata exposure
- **Fix:** Make category reads org-scoped, key cache by `organizationId`

### H-10 🟡 Products API response cache not org-keyed
**File:** `src/app/api/products/route.ts:12-26`
- Cache key is `request.nextUrl.toString()` — identical across orgs on same domain
- **Impact:** One tenant receives another's cached catalog for up to 30s
- **Fix:** Include `orgId` in cache key

### H-11 🟡 PIN login scans only first 20 credentials globally
**File:** `src/lib/persistence/postgres-store.ts:508-514`
- `LIMIT 20` with no org filter — employees beyond row 20 can never PIN-login
- **Impact:** Operational lockout for larger orgs
- **Fix:** Look up employee set by org/location first, then verify only those hashes

### H-12 🟡 RLS not forced — depends on app role discipline
**File:** `supabase/migrations/009_rls_policies.sql`
- `ENABLE ROW LEVEL SECURITY` but not `FORCE ROW LEVEL SECURITY` — table owner bypasses policies
- **Fix:** Add `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for all org-scoped tables; use dedicated non-owner DB role

---

## MEDIUM (Fix This Sprint)

### M-01 🟢 Schema mismatch — `customers.tax_exempt` missing
**Code:** `src/lib/persistence/postgres-phase2.ts:32` reads `r.tax_exempt` but column doesn't exist
- **Fix:** Add `ALTER TABLE customers ADD COLUMN tax_exempt BOOLEAN NOT NULL DEFAULT false;`

### M-02 🟢 `register_sessions.organization_id` is TEXT not UUID
**File:** `supabase/migrations/007_register_device_lock.sql:3`
- **Fix:** New migration to alter column type to UUID with FK constraint

### M-03 🟢 N+1 query in stocktake acceptance
**File:** `src/lib/persistence/postgres-phase2.ts:645-658`
- 500-line stocktake = 1000 individual queries
- **Fix:** Batch into multi-row INSERT/UPDATE

### M-04 🟢 Checkout lacks idempotency key
**File:** `src/app/register/checkout-action.ts:22-481`
- Double-click or network retry creates duplicate transactions
- **Fix:** Accept idempotency key, check against existing table

### M-05 🟢 Content-Disposition header injection
**File:** `src/app/api/export/route.ts:34-35`
- User-controlled `from`/`to` values interpolated without validation
- **Fix:** Validate with `/^\d{4}-\d{2}-\d{2}$/`

### M-06 🟢 40+ `as any` usages across codebase
- Products route (8), shift-close (8), eod-report (6), cash-drawer (5)
- **Fix:** Define row types for each query

### M-07 🟡 Signup is non-transactional
**File:** `src/app/actions/auth.ts:124-147`
- Org, location, employee, credentials inserted as separate statements
- **Fix:** Wrap in single transaction with rollback

### M-08 🟡 Product writes return early after BEGIN without ROLLBACK
**File:** `src/app/api/products/route.ts:225-317`
- Multiple 4xx returns after `BEGIN` but before `ROLLBACK`
- **Fix:** Validate before BEGIN or add ROLLBACK on every early return

### M-09 🟡 CSV export vulnerable to formula injection
**File:** `src/app/api/export/route.ts:176-196`
- Cells not neutralized for leading `=`, `+`, `-`, `@`
- **Fix:** Prefix dangerous cells, stream instead of buffer

### M-10 🟡 `audit.view` too broad for sensitive exports
- support and inventory-clerk roles can export customer PII, gift cards, financials
- **Fix:** Split into narrower permissions

### M-11 🟡 EOD report hardcoded to personal email
**File:** `src/app/api/eod-report/route.ts:210-212`
- **Fix:** Store recipients in org/location settings

### M-12 🟢 Missing ROLLBACK in event-action on failure
**File:** `src/app/register/event-action.ts:46-66`
- Transaction released without explicit ROLLBACK on error
- **Fix:** Add catch with ROLLBACK

---

## LOW (Backlog)

- L-01: Minimal ARIA labeling (only 2 `aria-label` across entire codebase)
- L-02: God components (8 files >700 lines)
- L-03: Duplicate boilerplate across 35 API routes → create `withAuth()` wrapper
- L-04: CSP allows `unsafe-inline` for styles
- L-05: Silent fallback to hardcoded tax rate in offline-sync
- L-06: Empty alt attributes on images
- L-07: No focus management in modals
- L-08: No visible focus indicators on custom buttons
- L-09: Dead `pgReadOrganization()` + `_orgCache` code
- L-10: Next 16 proxy migration incomplete (`middleware.ts` deprecated, `proxy.ts` disabled)

---

## Agent Agreement Matrix

| Finding | Claude Code | Codex | Confidence |
|---------|:-----------:|:-----:|:----------:|
| Unprotected server actions | ✅ | ✅ | 🔴 Highest |
| Missing admin authz | ✅ | ✅ | 🔴 Highest |
| Error detail leak | ✅ | ✅ | 🔴 Highest |
| Email receipt trusts client data | ❌ | ✅ | 🟡 Verify |
| Offline sync trusts client prices | ❌ | ✅ | 🟡 Verify |
| Committed DB credentials | ❌ | ✅ | 🔴 Clear |
| CORS bypass | ❌ | ✅ | 🔴 Clear |
| Rate limiting in-memory | ✅ | ✅ | 🔴 Highest |
| Zero test coverage | ✅ | ✅ | 🔴 Highest |
| scryptSync blocks Worker | ✅ | ❌ | 🔵 Likely |
| Cross-tenant category leak | ❌ | ✅ | 🟡 Verify |
| Products cache not org-keyed | ❌ | ✅ | 🟡 Verify |
| PIN login LIMIT 20 | ❌ | ✅ | 🟡 Verify |
| RLS not forced | ❌ | ✅ | 🔴 Clear |
| Schema mismatch (tax_exempt) | ✅ | ❌ | 🔵 Likely |
| N+1 stocktake | ✅ | ❌ | 🔵 Likely |
| Content-Disposition injection | ✅ | ❌ | 🔵 Likely |
| CSV formula injection | ❌ | ✅ | 🟡 Verify |

**Key insight:** Codex caught more infrastructure/deployment issues (committed secrets, CORS bypass, cross-tenant caching, RLS forcing). Claude Code caught more application-level issues (server action auth, schema mismatches, N+1 queries, header injection). Both are valuable.

---

## Recommended Priority

1. **Immediate:** C-01 through C-05 (unprotected actions, error leak, email receipt forgery, offline sync pricing)
2. **Today:** H-01 (rotate DB password), H-02 (CORS), H-09/H-10 (cross-tenant leaks)
3. **This week:** H-03/H-04 (rate limiting), H-05 (signup CSRF), H-11 (PIN login), H-12 (force RLS)
4. **This sprint:** All Medium findings
5. **Backlog:** All Low findings
