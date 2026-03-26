# SwiftPOS — Master Product Specification (v1.5 Draft)

Date: 2026-03-22  
Status: Working markdown master spec  
Scope: Consolidated product direction including v1.4 base plus v1.5 additions

---

## 1. Product Summary
SwiftPOS is a modern, cloud-native, offline-capable point-of-sale system for small to mid-size retail businesses operating 1–50 locations.

Core promise:
- fast modern register UX
- real multi-location inventory visibility
- hardware-agnostic deployment
- mobile + desktop support
- deeper operator controls than lightweight POS competitors

SwiftPOS should be built and positioned first as a **retail operations product**, not as an all-purpose ERP.

---

## 2. Core Product Thesis
SwiftPOS wins if it becomes the best operator-first retail POS for businesses that need:
- fast register workflows
- multi-location inventory truth
- offline reliability
- flexible checkout/payment behavior
- strong reporting and auditability
- better control over employee actions and cash handling

SwiftPOS should remain **POS-first**. Accounting, payroll, large-scale e-commerce, and platform ambitions should not distort early execution.

---

## 3. Core Product Modules

### 3.1 Register / Checkout
- product search and category navigation
- variants and modifiers
- cart management
- open tickets / hold & recall
- tax calculation
- receipt delivery
- customer assignment
- cash management
- returns / exchanges

### 3.2 Inventory Management
- catalog + variants
- stock by location
- adjustments with audit trail
- purchase orders
- stocktakes
- barcode labels
- transfers between locations

### 3.3 Customer / Loyalty
- customer profiles
- loyalty points
- purchase history
- customer search
- feedback collection
- optional marketing later

### 3.4 Reporting & Analytics
- sales reports
- tax reports
- employee performance
- inventory reports
- customer reports
- scheduled report exports

### 3.5 Employee & Access Control
- PIN login for register
- role-based access
- shift controls
- manager approvals
- employee-level operational metrics

### 3.6 Multi-Location Operations
- inventory visibility across locations
- transfers
- warehouse support later
- customer reserve and inter-store logistics later

---

## 4. Strategic Additions for v1.5 Direction

### 4.1 Transaction Integrity & Cash Shrinkage Controls
This is now a core differentiator.

Include:
- immutable void/cancel audit trail
- transaction lifecycle event logging
- reason codes for exceptions
- manager PIN approvals above thresholds
- shift discrepancy correlation
- suspicious behavior flags
- employee behavior dashboard
- operational exception reporting

Positioning:
- operator protection
- shrinkage reduction
- cashier accountability
- loss-prevention controls

### 4.2 Split Tender Payments
Treat split tender as core checkout functionality.

Support:
- cash + card
- cash + gift card
- cash + store credit
- multiple cards
- mixed tenders with live remaining balance

Store each tender as a normalized payment line.

### 4.3 Layaway / Partial-Payment Orders
Treat layaway as a separate workflow from split tender.

Support:
- deposit now, balance later
- reserved/held inventory
- payment history
- optional due dates and cancellation rules
- conversion to completed sale when fully paid

### 4.4 Gift Card / Store Credit Controls
Existing feature area should gain stronger controls:
- manual adjustment audit trail
- approval thresholds
- suspicious activation/redeem patterns
- employee-level issuance reporting
- liability visibility

### 4.5 Suspicious Employee Behavior Dashboard
Use exception data to surface operational concerns:
- abnormal void/cancel rates
- repeated post-total cancellations
- unusual cash discrepancies
- manual price override abuse
- suspicious store-credit / gift-card activity
- high-risk shift patterns

---

## 5. Product Boundaries
SwiftPOS should prioritize features that stay close to the POS core.

### Strong fit
- checkout
- payment flexibility
- inventory control
- employee accountability
- multi-location operations
- reporting
- loyalty
- operator dashboards

### Medium fit (later)
- customer marketing
- e-commerce integrations
- native storefront
- AI transfer suggestions

### Dangerous early-scope areas
- built-in accounting expansion
- payroll complexity
- plugin marketplace
- broad social commerce
- full ERP behavior

---

## 6. Recommended Build Priorities

### Priority 1 — Prove the POS core
- register
- products/variants/modifiers
- inventory by location
- customers/basic loyalty
- shifts/cash close
- receipts
- sales/inventory/shift reports
- PIN auth / permissions

### Priority 2 — Harden operations
- transaction integrity controls
- split tender payments
- suspicious employee behavior reporting
- stronger gift card/store-credit controls

### Priority 3 — Expand store workflows
- layaway / partial payment
- inter-store transfers
- stocktakes
- purchase orders
- customer-facing display
- dashboard app

### Priority 4 — Broader platform expansion
- online storefront
- Shopify / WooCommerce integration
- public API / webhooks
- advanced marketing

### Priority 5 — High-risk long-tail features
- accounting engine maturity
- payroll
- AI-driven ops recommendations
- self-host commercial packaging

---

## 7. Architecture Direction
The long-term architecture direction from v1.4 remains broadly sound, but execution should now be explicitly **web-first**.

### Phase 1 platform decision
Build SwiftPOS first as:
- Next.js web register
- Next.js web admin/back office
- browser-based reporting and management tools
- Supabase/PostgreSQL as system of record
- web-first offline/read-sync support only where it materially helps the register path

### Explicitly defer for early phases
Do not treat these as first-class build targets in Phase 1:
- Electron desktop wrapper
- Flutter mobile register app
- Flutter dashboard app
- Flutter customer display app

### Why this decision
Web-first:
- reduces platform complexity
- speeds up iteration
- makes internal rollout easier
- delays hardware/platform edge cases until the core product is proven
- prevents SwiftPOS from becoming several client projects before the register itself is solid

### Future expansion path
If the web product proves itself, expand in this order:
1. Electron desktop register wrapper for stronger hardware and kiosk control
2. targeted mobile/dashboard apps only after core workflows are stable

The architecture should serve the product, not drag the roadmap outward too early.

---

## 8. Product Positioning
SwiftPOS should be positioned as:
- modern
- hardware-agnostic
- operator-first
- multi-location ready
- more controllable than Square/Loyverse/Clover-style tools

The strongest moat is not “we do everything.”
The strongest moat is:
- great retail UX
- reliable offline sync
- deep inventory truth
- better operational control and shrinkage visibility

---

## 9. Key Product Rule
Do not let SwiftPOS become an overbuilt ERP before it becomes a great retail POS.

The correct sequence is:
1. make the register indispensable
2. make store operations trustworthy
3. expand outward carefully

---

## 10. Recommended Next Documents
Use this master spec as direction, then derive:
- a trimmed Phase 1 roadmap
- module-by-module engineering briefs
- data model revisions for transaction integrity and tender flexibility
- operator-facing reporting requirements
