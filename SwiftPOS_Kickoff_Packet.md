# SwiftPOS Kickoff Packet

Date: 2026-03-22
Status: Kickoff inputs captured
Purpose: establish the minimum real-world product and project inputs needed for Edison + Forge to drive SwiftPOS toward MVP.

---

## 1. Project Intent
SwiftPOS is being treated as a **web-first retail POS product** with future desktop/mobile expansion only after the core workflows are proven.

Current strategic intent:
- build a real internal-use product first
- keep scope ruthlessly POS-first
- prioritize operator trust, cashier speed, inventory truth, and cash-handling controls
- avoid early drift into ERP/accounting/payroll/platform sprawl

---

## 2. Working Product Direction
Current planning assumption:
- **Platform:** web-first
- **Frontend:** Next.js
- **Backend:** Supabase / PostgreSQL
- **Initial users:** internal retail store operations
- **Initial goal:** usable Phase 1 MVP for real store workflows

This packet is the point where planning turns into execution.

---

## 3. Confirmed Kickoff Answers

### A. First real deployment target
- **Store:** Casualwear
- **Address:** 16108 Lakewood Blvd, Bellflower, CA 90706
- Initial assumption: one real store first, prove workflows there before broader rollout

### B. Who will use SwiftPOS first
- cashiers
- managers
- owner

### C. Top workflow pain points today
1. Stability — current QuickBooks POS is outdated/discontinued, and the replacement needs to avoid crashing.
2. Product images — product images should ideally appear when items are scanned or selected.
3. Speed/responsiveness — especially on touchscreen hardware.
4. Current basic POS flow mostly works, so SwiftPOS should improve reliability, speed, and modern usability rather than reinvent everything.

### D. Must-have V1 payment methods
- cash
- credit/debit
- store credit
- split tender

### E. Split tender decision
- Split tender is **mandatory in V1**.
- Receipt must clearly show tender breakdown.

### F. Returns / approval rules
- Returns over **$40** require manager approval.
- Threshold should be configurable later.
- Exchanges do **not** require approval as long as everything is tracked and scanned.

### G. Manager approval thresholds for V1
- Discounts over **$5** require manager approval.
- Full transaction voids over **$20** require manager approval.
- Item voids over **$15** require manager approval.
- Store credit issuance over **$10** requires manager approval.
- Manual price overrides over **$10** require manager approval.

### H. Hardware reality for early testing
- all-in-one touchscreen PC
- tablet browser

### I. Receipt behavior for early MVP
- Browser-print receipt output is acceptable for earliest testing.
- SwiftPOS must also support a **no receipt** option.

### J. Repo / build home
- Start in the workspace for now.

---

## 4. MVP Boundary (Current Recommendation)
This is the current recommended MVP boundary unless London overrides it.

### In scope
- web register
- web admin/back office
- products/categories/variants/modifiers
- inventory by location
- customers + basic loyalty
- cash and split tender checkout
- shifts / cash reconciliation
- receipts
- returns (basic)
- reporting (sales/payment/shift/inventory basics)
- transaction integrity / void-cancel controls

### Out of scope for initial MVP
- Electron wrapper
- Flutter mobile apps
- customer-facing display
- accounting engine
- payroll
- e-commerce storefront
- Shopify/WooCommerce sync
- plugin marketplace
- AI features

---

## 5. Proposed Working Model
### London
- product owner
- source of real-world store truth
- final call on business-rule ambiguity
- real workflow validator

### Edison
- project lead
- scope control
- architecture/planning
- documentation
- orchestration
- product framing and prioritization

### Forge
- coding specialist
- implementation execution
- scaffolding
- feature delivery
- bug fixing
- technical iteration

Default assumption:
- Forge uses Codex unless another harness is intentionally chosen.

---

## 6. What Edison + Forge Can Drive Without Much Help
Once the kickoff inputs are confirmed, Edison + Forge can drive:
- repo scaffolding
- schema design refinement
- milestone-by-milestone implementation
- admin/register app structure
- documentation
- QA plans
- bug triage
- scope policing

---

## 7. What Still Requires London During Build
Even with Edison leading, London still needs to provide:
- product rule decisions when new ambiguity appears
- occasional scope calls
- real-world workflow validation
- feedback after internal testing
- signoff on high-impact business logic

This is not micromanagement; it is product-owner input.

---

## 8. Immediate Execution Interpretation
Given the confirmed inputs, SwiftPOS should optimize early for:
- crash resistance / reliability
- fast touchscreen-friendly register flow
- image-friendly product browsing/scanning workflow
- trustworthy cash handling and approval controls
- practical checkout flexibility (including split tender and no-receipt flow)

---

## 9. Definition of Kickoff Complete
Kickoff is complete because:
- deployment target is chosen
- top pain points are written down
- payment methods are confirmed
- split tender is confirmed as mandatory
- key approval thresholds are defined
- hardware assumptions are clarified
- repo starting point is chosen
- Edison is authorized to drive the project with Forge toward MVP

---

## 10. Notes
This packet is intentionally small. The goal is not more planning theater.
The goal is to get just enough real-world clarity that execution can begin without building the wrong product.
