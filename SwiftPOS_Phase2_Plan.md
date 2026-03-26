# SwiftPOS — Phase 2 Plan

Date: 2026-03-23
Status: Proposed
Prerequisite: Phase 1 complete (confirmed 2026-03-23)
Target store: Casualwear, Bellflower CA

---

## 1. Phase 2 Objective

Harden SwiftPOS for daily store use by moving off the dev-only persistence layer, adding real authentication, and shipping the operator-protection features that make managers trust the system enough to run real shifts on it.

Phase 2 success means:
- the app runs against a real database, not a JSON file
- employees log in through a real auth system
- managers have a suspicious behavior dashboard they actually check
- gift card and store credit abuse vectors are closed
- layaway works for the customers who need it
- stocktakes and transfers exist for basic multi-location readiness

---

## 2. Phase 2 Blocks (in build order)

### Block 1 — Production Persistence

Move from the JSON file-backed store to PostgreSQL via Supabase.

Build:
- Supabase project setup and connection
- PostgreSQL schema matching all current domain types (organizations, locations, employees, products, variants, categories, modifiers, inventory, customers, shifts, register sessions, transactions, tenders, events, exceptions, pay-in/out, auth credentials, inventory adjustments)
- Row-level security (RLS) policies for org/location isolation
- Migration scripts from seed data
- Replace `mutateStore` / `readStore` calls with Supabase client queries
- Keep `USE_POSTGRES` env flag so JSON store still works for local dev
- Verify all existing flows work identically against Postgres

Why first:
Everything else in Phase 2 depends on having a real database. The JSON store was always a dev seam — it served its purpose, but it can't handle concurrent users, multi-location, or real operational data.

Exit criteria:
- All register and admin flows work against Supabase/Postgres
- RLS policies tested (employee in org A cannot see org B data)
- Seed data loads cleanly via migration
- JSON store still works as fallback for local dev

---

### Block 2 — Real Authentication

Replace the dev-only cookie auth with Supabase Auth.

Build:
- Supabase Auth integration for admin login (email/password)
- Register PIN login backed by Supabase (verify PIN hash server-side, issue session)
- Session management with proper expiry and refresh
- Middleware-level auth guards on all routes
- Logout that actually invalidates sessions
- Password reset flow for admin roles

Why second:
With a real database, we can now have real auth. Everything security-sensitive from here on depends on this.

Exit criteria:
- Admin login works with real Supabase Auth
- Register PIN login issues real sessions
- Expired sessions redirect to login
- No dev-only auth bypasses remain in production paths

---

### Block 3 — Suspicious Employee Behavior Dashboard

Build the full rule-based behavior monitoring dashboard from the v1.5 spec.

Build:
- `employee_behavior_flags` table with severity levels (low/medium/high)
- Flag generation rules running against transaction events:
  - high void/cancel rate vs store average
  - repeated post-total cancellations
  - excessive item removals from carts
  - frequent manual price overrides
  - unusual manual drawer opens
  - elevated shift discrepancies over time
  - unusual gift card/store credit activity
- Dashboard views:
  - by employee (all flags for one person)
  - by location (all flags for one store)
  - by date range
  - by severity level
  - by action type
- Flag review workflow (manager marks flag as reviewed with notes)
- Summary cards showing active flag counts by severity

Why here:
Phase 1 already captures all the raw event data — voids, exceptions, shift variances, discount approvals. This block makes that data actionable for managers. It's the single biggest differentiator in the spec.

Exit criteria:
- Flags generate automatically from transaction event data
- Dashboard shows flags filterable by employee, location, date, severity
- Managers can review/dismiss flags with notes
- At least 6 rule types are active

---

### Block 4 — Gift Card & Store Credit Controls

Strengthen controls around gift cards and store credit to close abuse vectors.

Build:
- Gift card entity (id, balance, status, activation history)
- Gift card activation, reload, and redemption flows
- Store credit ledger with full adjustment history
- Approval thresholds for:
  - gift card activation above configurable amount
  - store credit issuance above configurable amount
  - manual balance adjustments
- Employee-level issuance reporting (who issued how much store credit / activated how many gift cards)
- Outstanding liability view (total unredeemed gift card + store credit balances)
- Suspicious pattern detection:
  - rapid activate/redeem on same card
  - excessive issuance by single employee
  - gift card reload followed by immediate refund
- Integration with behavior dashboard (flags feed into Block 3)

Exit criteria:
- Gift cards can be activated, reloaded, redeemed, and balance-checked
- Store credit has a full audit trail
- Manager approval enforced above thresholds
- Issuance and liability reports available in admin
- Suspicious patterns generate behavior flags

---

### Block 5 — Layaway / Partial-Payment Orders

Add deposit-now-pay-later workflows for customers who need them.

Build:
- Layaway order creation from current cart
- Initial deposit collection (configurable minimum: amount or percentage)
- Remaining balance tracking
- Payment history per layaway
- Layaway statuses: active, partially_paid, paid_in_full, collected, cancelled, forfeited
- Optional due date with configurable duration
- Inventory reservation while layaway is active
- Auto-release inventory on cancellation/expiry
- Conversion to completed sale when fully paid
- Manager approval for layaway cancellation/refund
- Layaway list view in admin with status filters
- Tax handling: configurable whether tax is collected at deposit or final payment

Exit criteria:
- Customer can start a layaway, make partial payments, and pick up when paid in full
- Inventory is reserved and released correctly
- Layaway activity appears in reporting
- Cancellation requires manager approval above threshold

---

### Block 6 — Stocktakes

Add physical inventory counting workflows.

Build:
- Stocktake creation (full count or cycle count by category/location)
- Count entry UI (scan or manual entry per variant)
- Expected vs counted comparison view
- Variance report with delta by variant
- Stocktake approval workflow (manager reviews and accepts count)
- Inventory adjustment generation from accepted stocktake
- Stocktake history in admin
- Freeze/lock inventory adjustments during active stocktake (optional)

Exit criteria:
- Staff can perform a physical count and record results
- Variance report shows discrepancies clearly
- Accepted stocktake generates inventory adjustments with audit trail
- Stocktake history is reviewable

---

### Block 7 — Inter-Store Transfers

Basic inventory transfer between locations.

Build:
- Transfer request creation (source location → destination location, items + quantities)
- Transfer statuses: requested, in_transit, received, cancelled
- Source location inventory deduction on ship
- Destination location inventory addition on receive
- Transfer history and status tracking
- Transfer audit trail (who shipped, who received, timestamps)
- Admin view of pending and completed transfers

Why last:
Transfers require multi-location to be meaningful. This block is the gateway to real multi-store operations but can be built simply at first.

Exit criteria:
- Transfer can be created, shipped, and received between two locations
- Inventory adjusts correctly at both ends
- Transfer history is visible in admin
- Audit trail captures all state changes

---

## 3. What Phase 2 Should NOT Include

Defer to Phase 3 or later:
- Electron desktop wrapper
- Flutter mobile apps
- Customer-facing display
- Purchase orders / vendor management
- E-commerce / online storefront
- Shopify/WooCommerce sync
- Marketing automation
- Accounting engine
- Payroll
- Public API / webhooks
- AI-driven recommendations
- Barcode label printing (nice-to-have, not blocking)
- Advanced loyalty tiers

---

## 4. Phase 2 Exit Criteria

SwiftPOS should not leave Phase 2 until:
- the system runs on Supabase/Postgres with real auth in production
- managers use the suspicious behavior dashboard to review cashier activity
- gift card and store credit flows are auditable and threshold-enforced
- at least one layaway has been completed end-to-end
- a stocktake has been performed and accepted
- a transfer has been completed between locations
- all Phase 1 features still work correctly on the new persistence layer

---

## 5. Estimated Effort Shape

| Block | Relative size | Risk |
|-------|--------------|------|
| 1. Production persistence | Large | Medium — schema translation is mechanical but RLS needs careful testing |
| 2. Real authentication | Medium | Low — Supabase Auth is well-documented |
| 3. Behavior dashboard | Medium | Low — data already exists, this is aggregation + UI |
| 4. Gift card / store credit | Medium | Medium — new entity lifecycle + fraud detection logic |
| 5. Layaway | Medium | Medium — new workflow with inventory reservation |
| 6. Stocktakes | Medium | Low — count + compare + adjust |
| 7. Inter-store transfers | Small–Medium | Low — simple state machine |

Blocks 1–2 are infrastructure. Blocks 3–7 are features. The infrastructure blocks should be done first and done right — everything else builds on them.

---

## 6. Product Strategy Note

Phase 2 turns SwiftPOS from a working prototype into a system that could run a real store. The JSON file store was fine for proving the register works. Postgres + real auth + operator dashboards is what makes it deployable.

The right sequence remains:
1. make it real (persistence + auth)
2. make it trustworthy (behavior monitoring + gift card controls)
3. make it flexible (layaway + stocktakes + transfers)

If Phase 2 ships well, Phase 3 becomes about scale and reach — multi-store rollout, hardware integrations, and online channels. But none of that matters if the foundation isn't production-grade.
