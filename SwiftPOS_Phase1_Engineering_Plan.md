# SwiftPOS — Phase 1 Engineering Plan

Date: 2026-03-22
Scope: implementation plan for the trimmed SwiftPOS Phase 1 roadmap

---

## 1. Goal
Build the first production-worthy SwiftPOS slice that can replace legacy in-store POS workflows for internal store use.

Phase 1 success means:
- a cashier can reliably ring sales
- inventory remains believable
- managers can close shifts confidently
- payment/tender records are trustworthy
- void/cancel behavior is auditable
- the system feels faster and more modern than current tooling

This plan is intentionally narrower than the full SwiftPOS vision.

---

## 2. Core Product Outcome for Phase 1
By the end of Phase 1, SwiftPOS should support:
- product browsing/search
- variants/modifiers
- cart and checkout
- split tender payments
- returns/exchanges (basic)
- customers + basic loyalty
- inventory per location
- shift open/close and cash reconciliation
- employee PIN access + permissions
- sales/payment/shift/inventory reporting
- transaction integrity controls (void/cancel logging, approvals, exceptions)

This is enough to create internal operational value and validate the platform direction.

---

## 3. Recommended Technical Scope for Phase 1

### Build in Phase 1
- **Next.js web app** for register + admin/back office
- **Supabase/PostgreSQL** as primary backend
- **RLS** from day one for org/location isolation
- **PowerSync/Web offline layer** only where needed for the register path
- **Browser-print fallback receipts** first

### Defer from Phase 1 unless absolutely necessary
- Electron hardware-heavy path
- Flutter register app
- dashboard app
- customer-facing display
- complex printer/scanner integrations

Reason:
Phase 1 should prove the product and data model, not explode the platform surface.

---

## 4. Module Build Order

## Milestone 0 — Foundations

### Build
- repo/app structure
- auth model direction
- org/location model
- PostgreSQL schema foundation
- RLS policies
- design system / component primitives
- audit/event logging foundation

### Deliverables
- app shell
- authenticated admin/register routing
- seeded local/dev environment
- database migrations + policy tests

### Why first
Everything else depends on getting tenancy, permissions, and core data boundaries right.

---

## Milestone 1 — Catalog, Inventory, and Employee Foundations

### Build
- categories
- products
- variants
- modifiers / modifier groups
- inventory per location
- employee profiles
- role model / permissions
- PIN login for register

### Deliverables
- admin CRUD for products/variants/modifiers
- inventory records per location
- employee management basics
- cashier/manager/admin role enforcement

### Dependencies
- Milestone 0 complete

### Notes
Do not build bulk import first. Manual CRUD is enough to validate the model.
CSV import can come after the model stabilizes.

---

## Milestone 2 — Register Core

### Build
- product search and category filtering
- cart state
- item add/remove
- quantity adjustments
- modifiers in cart
- discounts (basic)
- customer assignment
- subtotal/tax/total calculation

### Deliverables
- usable register screen
- fast add-to-cart flow
- realistic cart editing behavior

### Dependencies
- product/inventory models
- employee PIN login

### Notes
This is the first user-visible heart of the system. Optimize speed and clarity here.

---

## Milestone 3 — Checkout and Tender Core

### Build
- cash checkout
- change calculation
- split tender payments
- normalized transaction tender storage
- completed transaction creation
- receipt generation (browser print/email placeholder if needed)

### Deliverables
- end-to-end sale completion
- tender breakdown on transaction record
- receipt output

### Dependencies
- register core
- transaction schema

### Notes
Split tender belongs here, not later. It affects the transaction model and reporting model too much to bolt on later.

---

## Milestone 4 — Shifts and Cash Management

### Build
- shift open
- opening cash entry
- pay-in / pay-out
- shift close
- blind close option
- expected vs actual cash
- discrepancy tracking

### Deliverables
- operational cashier shift workflow
- manager-readable shift reports

### Dependencies
- checkout flows
- employee roles
- tender tracking

### Notes
This is where SwiftPOS starts to feel like a real store system instead of just a checkout UI.

---

## Milestone 5 — Customers, Loyalty, and Basic Returns

### Build
- customer profiles
- customer search
- attach customer to sale
- purchase history
- basic loyalty earn/redeem rules
- returns/exchanges basics

### Deliverables
- customer-aware transactions
- loyalty visibility
- basic return flow

### Dependencies
- completed transaction model

### Notes
Keep loyalty simple in Phase 1. Points and redemption are enough. Do not build tier complexity first.

---

## Milestone 6 — Inventory Adjustment and Reporting Core

### Build
- inventory adjustment UI
- stock logs / audit trail
- low-stock view
- daily sales reports
- payment method breakdown
- inventory summary reports
- employee sales/shift summary

### Deliverables
- managers can trust inventory changes
- basic reports are useful day to day

### Dependencies
- transactions
- inventory records
- employee attribution

### Notes
Reporting should answer operator questions, not try to be BI theater.

---

## Milestone 7 — Transaction Integrity & Exception Controls

### Build
- transaction lifecycle events
- transaction exception log
- reason codes
- manager approval thresholds
- void/cancel controls
- cashier-level exception reports
- discrepancy correlation view

### Deliverables
- full auditability of risky actions
- manager-facing integrity reporting
- early suspicious behavior visibility

### Dependencies
- checkout
- shifts/cash management
- permissions model

### Notes
This is one of SwiftPOS’s best differentiators. Treat it as core operational product, not a side panel.

---

## 5. Dependencies Map

### Data foundations that must exist early
- organizations
- locations
- employees + roles
- products + variants + modifiers
- inventory
- transactions
- transaction_tenders
- shifts
- inventory_logs
- transaction_events
- transaction_exceptions

### Data models that can wait
- transfers
- purchase_orders
- online_orders
- gift_cards full advanced lifecycle
- layaways
- warehouse entities
- accounting/payroll entities

---

## 6. Suggested Team Execution Sequence

If one small team is building this, divide effort into 3 streams:

### Stream A — Backend / Data Integrity
Own:
- schema
- RLS
- transactions
- tenders
- shifts
- audit/event models
- reporting queries

### Stream B — Register / Admin UI
Own:
- register UX
- product/cart/checkout flows
- shift screens
- customer flows
- reporting screens

### Stream C — Ops / Quality
Own:
- seed data
- test data realism
- cashier workflow validation
- permission testing
- discrepancy/void edge-case testing

If team size is tiny, still think in these streams even if one person covers multiple.

---

## 7. Suggested Milestone Acceptance Criteria

### Milestone 1 accepted when
- products/variants/modifiers can be managed
- location inventory exists
- employee PIN auth works

### Milestone 2 accepted when
- cashier can build/edit cart quickly
- products search reliably
- taxes/totals are correct before payment

### Milestone 3 accepted when
- checkout completes reliably
- split tenders work correctly
- receipts and transaction records reflect exact tender mix

### Milestone 4 accepted when
- shifts open/close reliably
- cash discrepancies are visible
- managers can review shift data

### Milestone 5 accepted when
- customers attach to transactions
- basic loyalty works
- basic returns do not corrupt inventory or tender reporting

### Milestone 6 accepted when
- inventory adjustments are auditable
- core management reports are useful without SQL

### Milestone 7 accepted when
- void/cancel behavior cannot disappear silently
- approvals are enforceable
- suspicious behavior is visible in reporting

---

## 8. Technical Risks to Address Early

### 1. RLS / multi-tenant safety
Mitigation:
- write policy tests from day one
- ensure every Phase 1 table has clear org/location boundaries

### 2. Split tender model complexity
Mitigation:
- normalize tender lines immediately
- do not fake this with JSON blobs only
- test refunds early

### 3. Inventory truth drift
Mitigation:
- keep movement sources explicit
- record adjustments and sales effects clearly
- avoid hidden write paths

### 4. Transaction integrity becoming an afterthought
Mitigation:
- create event/exception tables early
- log lifecycle actions from the register core onward

### 5. Scope creep from adjacent modules
Mitigation:
- no accounting/payroll/e-commerce in Phase 1 implementation planning
- maintain a strict deferred list

---

## 9. Recommended Deferred List
Do not let these leak into Phase 1:
- Electron hardware-specific integrations beyond minimal need
- Flutter apps
- customer display
- inter-store transfers
- stocktakes
- purchase orders
- layaway
- advanced gift-card behavior
- marketing campaigns
- accounting
- payroll
- omnichannel storefront
- Shopify/WooCommerce

---

## 10. Suggested Delivery Framing
Frame Phase 1 internally as:

**"Replace the register, protect cash handling, and make inventory/reporting trustworthy — in a web-first product."**

That is the real mission.

Not:
- build the final SaaS platform
- build ERP for retail
- build accounting software

---

## 11. Best Next Documents After This
After approving this engineering plan, create:
1. schema revision brief for transaction integrity + tenders
2. register UX brief
3. shift/cash management brief
4. reporting brief
5. milestone-by-milestone build tickets

## 11. Best Next Documents After This
After approving this engineering plan, create:
1. schema revision brief for transaction integrity + tenders
2. register UX brief
3. shift/cash management brief
4. reporting brief
5. milestone-by-milestone build tickets
