# SwiftPOS — Phase 1 Milestone Tickets

Date: 2026-03-22
Purpose: convert the Phase 1 engineering plan into concrete execution tickets.

---

## Milestone 0 — Foundations

### Ticket 0.1 — App and repo structure
**Goal:** establish codebase layout for register/admin workflows.

Deliver:
- app shell
- route structure for register + admin
- shared UI primitives
- environment config approach

Acceptance:
- app boots cleanly in dev
- routes are organized for future modules

### Ticket 0.2 — Auth and role model
**Goal:** define employee/admin auth modes and role boundaries.

Deliver:
- email/password admin auth
- PIN-based register login approach
- role definitions: cashier / manager / admin

Acceptance:
- roles are represented in schema and app guards

### Ticket 0.3 — Org/location schema + RLS foundation
**Goal:** set up tenancy and location boundaries safely.

Deliver:
- organizations
- locations
- employee/location relationships
- baseline RLS policies
- test coverage for policy boundaries

Acceptance:
- org/location isolation is enforced for core tables

### Ticket 0.4 — Seed/dev data framework
**Goal:** make development realistic.

Deliver:
- seed data generation
- basic product/customer/employee fixtures
- local reset workflow

Acceptance:
- developers can get a realistic sandbox quickly

---

## Milestone 1 — Catalog, Inventory, Employees

### Ticket 1.1 — Product catalog schema
**Goal:** implement products, categories, and variants.

Deliver:
- products table
- categories table
- product_variants table
- basic CRUD APIs

Acceptance:
- products and variants can be created, updated, deactivated

### Ticket 1.2 — Modifiers model
**Goal:** support register-ready modifier groups.

Deliver:
- modifier_groups
- modifiers
- product_modifier_groups
- admin CRUD UI

Acceptance:
- products can attach one or more modifier groups

### Ticket 1.3 — Inventory by location
**Goal:** establish believable stock truth.

Deliver:
- inventory table
- inventory_logs
- inventory adjustment workflow

Acceptance:
- per-location stock can be adjusted and logged with provenance

### Ticket 1.4 — Employee and permissions management
**Goal:** support register accountability.

Deliver:
- employee CRUD
- PIN setup/rotation flow
- role and location assignment

Acceptance:
- employees can be assigned roles and locations cleanly

---

## Milestone 2 — Register Core

### Ticket 2.1 — Product browse/search UI
**Goal:** make item discovery fast.

Deliver:
- category tabs
- product search by name/SKU/barcode
- list/grid display modes if justified

Acceptance:
- cashier can find items quickly without lag

### Ticket 2.2 — Cart model and cart interactions
**Goal:** make basket building reliable.

Deliver:
- add/remove item
- quantity change
- item note support
- modifier selection

Acceptance:
- cart updates are correct and easy to understand

### Ticket 2.3 — Pricing/tax calculation engine
**Goal:** make totals deterministic.

Deliver:
- subtotal calculation
- discount support (basic)
- tax-inclusive/exclusive handling
- cash rounding rules foundation

Acceptance:
- all totals match defined rules across core test cases

### Ticket 2.4 — Customer assignment in register
**Goal:** allow customer-aware checkout.

Deliver:
- attach customer to active cart
- customer search from register
- walk-in default

Acceptance:
- cashier can attach/remove customer quickly

---

## Milestone 3 — Checkout and Tender Core

### Ticket 3.1 — Transaction header + line item persistence
**Goal:** persist completed sales reliably.

Deliver:
- transactions table implementation
- transaction_items implementation
- create completed sale flow

Acceptance:
- completed sales persist with correct totals and line items

### Ticket 3.2 — Split tender schema and logic
**Goal:** support multiple tenders in a single checkout.

Deliver:
- transaction_tenders table
- tender entry UX
- remaining balance calculation
- cash change handling

Acceptance:
- partial cash + partial card works correctly
- receipt and DB reflect exact tender breakdown

### Ticket 3.3 — Receipt generation
**Goal:** provide usable receipts early.

Deliver:
- receipt rendering
- browser print fallback
- receipt summary with tender lines

Acceptance:
- cashier can print/render a readable receipt

### Ticket 3.4 — Basic refund model
**Goal:** define how money reversal works.

Deliver:
- refund data model
- basic refund flow
- split-tender-aware refund logic direction

Acceptance:
- refund records are attributable and do not corrupt original sales data

---

## Milestone 4 — Shifts and Cash Control

### Ticket 4.1 — Shift open/close workflow
**Goal:** support real cashier sessions.

Deliver:
- open shift
- starting cash
- close shift
- actual cash entry
- blind close option

Acceptance:
- cashier can open and close shift reliably

### Ticket 4.2 — Cash movements
**Goal:** track non-sale cash events.

Deliver:
- pay-in
- pay-out
- reason codes
- linkage to shift

Acceptance:
- cash movements appear in shift reporting and expected cash logic

### Ticket 4.3 — Cash discrepancy reporting
**Goal:** surface over/short clearly.

Deliver:
- expected vs actual calculation
- discrepancy amount display
- manager report view

Acceptance:
- managers can see discrepancy history by shift/employee

---

## Milestone 5 — Customers, Loyalty, Returns

### Ticket 5.1 — Customer profiles and search
**Goal:** make customer data useful operationally.

Deliver:
- customer CRUD
- search by name/email/phone
- customer purchase history summary

Acceptance:
- customer assignment and lookup work consistently

### Ticket 5.2 — Basic loyalty earn/redeem
**Goal:** support simple loyalty value.

Deliver:
- points accrual rules
- points balance storage
- basic redemption path

Acceptance:
- loyalty points update correctly on completed sales

### Ticket 5.3 — Basic returns/exchanges
**Goal:** support practical post-sale corrections.

Deliver:
- transaction lookup
- item-level return support
- inventory update on return
- tender-aware refund path foundation

Acceptance:
- basic returns are usable and auditable

---

## Milestone 6 — Inventory Adjustments and Reporting

### Ticket 6.1 — Inventory adjustment UI
**Goal:** let managers correct stock with traceability.

Deliver:
- adjustment form
- reason codes
- before/after quantities
- employee attribution

Acceptance:
- all adjustments create inventory logs with provenance

### Ticket 6.2 — Core sales reports
**Goal:** answer operator questions daily.

Deliver:
- daily sales summary
- payment method breakdown
- hourly summary if cheap

Acceptance:
- managers can review daily performance without raw SQL

### Ticket 6.3 — Shift and employee reports
**Goal:** connect behavior to outcomes.

Deliver:
- shift summaries
- employee sales summary
- discrepancy summary

Acceptance:
- managers can evaluate cashier performance and cash handling basics

### Ticket 6.4 — Inventory summary reports
**Goal:** provide stock visibility.

Deliver:
- inventory by location
- low stock report
- top adjustment reasons

Acceptance:
- managers can identify stock issues quickly

---

## Milestone 7 — Transaction Integrity & Exceptions

### Ticket 7.1 — Transaction lifecycle events
**Goal:** preserve meaningful register behavior history.

Deliver:
- transaction_events table
- event logging hooks in register workflow
- event types for checkout lifecycle

Acceptance:
- key lifecycle actions are queryable and attributable

### Ticket 7.2 — Exception logging
**Goal:** track risky actions distinctly.

Deliver:
- transaction_exceptions table
- reason code support
- amount capture where relevant

Acceptance:
- void/cancel/override actions are logged immutably

### Ticket 7.3 — Manager approval controls
**Goal:** enforce approvals for risky actions.

Deliver:
- threshold configuration
- manager PIN approval flow
- approval attribution

Acceptance:
- high-risk actions cannot proceed without approval when configured

### Ticket 7.4 — Exception reports and suspicious behavior views
**Goal:** make integrity data operationally useful.

Deliver:
- employee exception summary
- cancel/void reports
- discrepancy correlation report
- suspicious behavior rule hits (basic)

Acceptance:
- managers can review high-risk employee behavior without manual log hunting

---

## Deferred Tickets (Not Phase 1)
Track but do not pull in yet:
- layaway / partial-payment orders
- advanced gift card fraud analytics
- inter-store transfers
- stocktakes
- purchase orders
- Electron-specific hardware flows
- Flutter apps
- dashboard app
- accounting/payroll
- e-commerce

---

## Best First Execution Bundle
If starting immediately, begin with these tickets in order:
1. 0.2 Auth and role model
2. 0.3 Org/location schema + RLS foundation
3. 1.1 Product catalog schema
4. 1.3 Inventory by location
5. 1.4 Employee and permissions management
6. 2.1 Product browse/search UI
7. 2.2 Cart model and cart interactions
8. 2.3 Pricing/tax calculation engine
9. 3.1 Transaction header + line item persistence
10. 3.2 Split tender schema and logic

That sequence gets the real heart of SwiftPOS moving fastest.
