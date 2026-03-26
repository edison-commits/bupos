# SwiftPOS — Trimmed Phase 1 Roadmap

Date: 2026-03-22
Goal: define what SwiftPOS should actually build first if the team stays disciplined.

---

## Phase 1 Objective
Replace legacy in-store POS pain with a modern, reliable, operator-first **web-based** retail register system.

Success means:
- staff can ring sales faster
- inventory stays trustworthy
- managers can close shifts confidently
- multi-location retail logic has a believable path
- the system is operationally safer than lightweight competitors

---

## What Phase 1 SHOULD include

### 1. Register / Checkout Core
- product search and browse
- variants and modifiers
- cart management
- open tickets / hold & recall
- tax calculation
- cash checkout
- receipts
- returns/exchanges (basic)
- customer assignment

### 2. Payment Core
- standard checkout
- split tender payments
- basic gift card / store credit redemption if already required
- normalized tender recording for reporting and refunds

### 3. Product / Inventory Core
- product catalog CRUD
- category hierarchy
- variants
- stock by location
- stock adjustments with audit trail
- low-stock alerts

### 4. Customer Core
- customer profiles
- purchase history
- basic loyalty points
- search by name/phone/email/loyalty code

### 5. Employee / Shift Core
- PIN login for register
- role-based permissions
- shift open/close
- pay-in / pay-out
- cash reconciliation
- blind close option

### 6. Reporting Core
- daily sales
- shift reports
- payment-method breakdown
- inventory summary
- employee performance basics

### 7. Transaction Integrity Core
- void/cancel audit trail
- reason codes
- manager approvals above thresholds
- transaction exception logging
- cashier-level exception reporting

---

## What Phase 1 SHOULD NOT include

### Defer
- full accounting engine
- payroll
- AI transfer suggestions
- warehouse support
- full e-commerce storefront
- Shopify / WooCommerce sync
- marketing automation
- plugin marketplace
- deep omnichannel logic
- public API platform ambitions

### Maybe Phase 2, not Phase 1
- inter-store transfer lifecycle
- stocktakes
- barcode label printing
- customer-facing display
- dashboard mobile app
- purchase orders
- layaway / partial-payment orders
- suspicious employee behavior dashboard (full version)
- stronger gift card/store-credit fraud analytics

---

## Phase 1.5 Recommendations
These are the best additions immediately after Phase 1 is stable:

1. split tender refinements (if not fully complete in Phase 1)
2. suspicious employee behavior dashboard
3. stronger gift card/store-credit controls
4. layaway / partial-payment orders
5. stocktakes
6. inter-store transfers

---

## Why this roadmap is better
This version keeps SwiftPOS focused on:
- selling product
- tracking money correctly
- tracking stock correctly
- controlling cashier behavior
- making managers trust the system

That is enough to create real value and internal adoption.

---

## Phase 1 exit criteria
SwiftPOS should not leave Phase 1 until all of these feel solid:
- register speed is clearly better than current tooling
- offline/read-sync behavior is trustworthy
- shift close and cash reconciliation work consistently
- void/cancel activity is fully auditable
- split tenders report correctly
- inventory stays believable through real daily use
- managers can identify suspicious cashier behavior without guesswork

---

## Product Strategy Note
If SwiftPOS nails this trimmed Phase 1, it has a real path to becoming a great product.
If it tries to ship the whole giant vision at once, it becomes fragile and slow.

The right move is:
- POS first
- controls second
- expansion later

- inventory stays believable through real daily use
- managers can identify suspicious cashier behavior without guesswork

---

## Product Strategy Note
If SwiftPOS nails this trimmed Phase 1, it has a real path to becoming a great product.
If it tries to ship the whole giant vision at once, it becomes fragile and slow.

The right move is:
- POS first
- controls second
- expansion later
