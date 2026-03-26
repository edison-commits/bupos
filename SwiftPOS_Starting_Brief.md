# SwiftPOS Starting Brief

Date: 2026-03-22
Audience: Edison + Forge
Status: execution-ready starting brief

---

## 1. Mission
Build the first real SwiftPOS slice for **Casualwear** as a **web-first** retail POS MVP.

The first version must beat the current QuickBooks POS primarily on:
- stability
- speed/responsiveness
- touchscreen friendliness
- cleaner modern operator workflow
- better cash-handling controls

Do not try to build the entire SwiftPOS vision at once.

---

## 2. Real-World Target
### Store
Casualwear  
16108 Lakewood Blvd, Bellflower, CA 90706

### First user groups
- cashiers
- managers
- owner

### First hardware assumptions
- all-in-one touchscreen PC
- tablet browser

### Receipt assumption
- browser-print is acceptable for earliest MVP
- include **no receipt** as an explicit checkout option

---

## 3. Product Priorities
### What matters most right now
1. Stability: do not crash.
2. Register speed: fast enough to feel obviously better than current tooling.
3. Touchscreen usability: large, responsive, low-friction interactions.
4. Product images: products should support image-friendly browsing and display.
5. Cash integrity: approvals and auditability should be built in early.

### What is *not* the mission right now
- accounting
- payroll
- e-commerce storefront
- Electron wrapper
- Flutter apps
- customer display
- broad multi-platform scope

---

## 4. Hard MVP Requirements
### Checkout/payment methods required in V1
- cash
- credit/debit
- store credit
- split tender

### Split tender
- mandatory in V1
- must show tender breakdown on receipt

### Return/exchange rules
- returns over **$40** require manager approval
- threshold should be configurable later
- exchanges do not require approval if fully tracked/scanned

### Manager approval thresholds in V1
- discounts over **$5**
- full transaction voids over **$20**
- item voids over **$15**
- store credit issuance over **$10**
- manual price overrides over **$10**

---

## 5. Build Scope for the First Serious Pass
Focus on Milestone 0–1 first.

### Milestone 0
- repo/app structure
- auth/role model direction
- org/location model
- PostgreSQL schema foundation
- RLS policies
- design primitives
- audit/event logging foundation

### Milestone 1
- categories
- products
- variants
- modifiers / modifier groups
- inventory per location
- employee profiles
- role model / permissions
- PIN login for register

### Important lens
Even in Milestone 0–1, build toward a register that will be:
- stable
- image-friendly
- touchscreen-usable
- cashier-accountable

---

## 6. Product Rules for Forge
- Build for web first.
- Optimize for touchscreen friendliness.
- Do not build side quests.
- Do not drift into accounting/payroll/e-commerce.
- Keep cash-handling and exception logging in view early.
- Prefer boring, reliable architecture over clever abstractions.
- Preserve room for split tender and transaction integrity in the schema from the start.

---

## 7. Best Immediate Deliverable
The best immediate engineering outcome is:

### A SwiftPOS web app scaffold with:
- clear register/admin structure
- initial schema + migrations
- org/location/employee foundations
- product/inventory foundations
- role + PIN direction
- room for transaction_tenders, transaction_events, and transaction_exceptions

This is more important than flashy UI or deep feature work right now.

---

## 8. Definition of Success for This Start
This start is successful if, after the first serious build pass, SwiftPOS has:
- a clean project foundation
- the right schema direction
- the right role/location structure
- the right product boundaries
- and a believable path into register implementation without rework

---

## 9. Working Relationship
### London
Product owner, business truth, final decision-maker on store rules.

### Edison
Project lead, planner, scope controller, reviewer, orchestrator.

### Forge
Coding specialist, defaulting to Codex unless intentionally changed.

---

## 10. Rule of Restraint
Every implementation choice should answer:

**Does this help Casualwear replace outdated QuickBooks POS with something faster, more stable, and easier to trust?**

If not, it probably should not be in the current build pass.
