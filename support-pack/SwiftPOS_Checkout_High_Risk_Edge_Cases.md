# SwiftPOS Checkout High-Risk Edge Cases

Date: 2026-03-22  
Audience: Forge + Edison  
Purpose: warn about the failure modes most likely to create bugs, bad cash math, or operator distrust.

---

## Biggest Architectural Risks Before Building Checkout

### 1. Treating split tender as UI sugar instead of a core money model
If checkout is built around a single payment field and split tender is layered on later, rework is almost guaranteed.

What must be true:
- tender lines are first-class records
- remaining balance is derived from tender lines, not ad hoc UI state
- receipts and reporting both read the same tender truth

### 2. Deriving expected cash from transaction totals instead of cash tender lines
This will break shift close accuracy the moment card/store credit/split tenders/refunds appear.

What must be true:
- only cash portions affect expected drawer cash
- expected cash also includes pay-ins/pay-outs/refunds/drawer adjustments
- close shift math does not guess from gross sales totals

### 3. Letting approval logic mutate transaction ownership
A manager approval should not make the transaction look like the manager performed the whole sale.

What must be true:
- cashier remains actor
- manager is stored as approver
- both identities remain queryable

### 4. Making checkout completion non-idempotent
Double taps, retries, refreshes, and latency will happen in-store.

What must be true:
- submit/complete is idempotent
- one cart cannot create two completed sales accidentally
- partial writes cannot leave orphan tender lines or ghost transactions

---

## High-Risk Product / Logic Edge Cases

### A. Threshold semantics are easy to get subtly wrong
The current rules are worded as **over**, not **greater than or equal to**.

Bug pattern:
- approval incorrectly triggers at exactly $5 / $10 / $15 / $20 / $40

Why it matters:
- operators lose trust fast when the system blocks valid actions unexpectedly

### B. Payment started, then cart changes
If item quantity, discount, or price changes after tender entry begins, stale remaining-balance math is a real risk.

Safe behavior:
- invalidate or recompute affected tender state
- force totals re-confirmation before completion

### C. Cash overpayment in split tender
Example:
- total due $18
- cashier records card $10
- customer gives $20 cash

Common bug:
- system treats all tendered amount as collected without correct change logic

Correct behavior:
- remaining due before cash is $8
- cash tender line should represent the payment basis clearly
- change due should come only from cash overage

### D. Split-tender refund path is harder than sale path
Original sale may be:
- cash + card
- cash + store credit
- two cards

Bug pattern:
- refund flow ignores original mix and corrupts tender reporting or customer balances

Safe behavior:
- preserve original tender breakdown
- if exact reversal is impossible, require explicit fallback with manager involvement or configured rule

### E. Exchange vs return branching can get muddy
Business rule says exchanges do not need approval if fully tracked/scanned.

Risk:
- implementation lumps exchanges into returns and forces unnecessary approvals
- or skips approval even when exchange is poorly tracked

Need:
- a clean decision tree distinguishing scanned/tracked exchange from ambiguous manual correction

### F. Store credit is both a tender and a liability instrument
If store credit is modeled too loosely, reporting and fraud controls will drift.

Risk areas:
- manual issuance over threshold
- partial redemption in split tender
- refund to store credit fallback
- balance restoration on cancelled/failed transaction

### G. Void/cancel timing matters
Removing an item before payment is not the same as voiding after totals or after payment starts.

Risk:
- system logs these as the same thing, destroying audit usefulness

Need:
- separate events/exceptions for pre-total remove, post-total cancel, item void, full void, refund reversal

### H. Session/shift boundaries can corrupt accountability
Checkout may happen with:
- no open shift
- register session ending mid-cart
- stale session cookie after shift close

Risk:
- sales not attributable to the right shift/employee
- tender lines not linked to the right shift

Need:
- clear preconditions for allowing checkout
- explicit handling when session/shift state changes mid-flow

---

## Edge Cases Forge Should Test Very Early

### 1. Exact-threshold tests
- discount = $5.00 vs $5.01
- price override = $10.00 vs $10.01
- item void = $15.00 vs $15.01
- full void = $20.00 vs $20.01
- return = $40.00 vs $40.01

### 2. Completion idempotency tests
- double tap pay
- browser refresh during final submit
- slow storage/network during complete sale
- back button after receipt render

### 3. Split tender state mutation tests
- add tender, edit cart, add second tender
- add two tenders, remove first tender
- tiny remainder like $0.01
- cash + card with change due

### 4. Shift cash truth tests
- card-only shift should not inflate expected cash
- split cash/card shift should add only cash portion to expected cash
- refund cash should reduce expected cash
- pay-in/pay-out should affect close math independently of sales

### 5. Approval attribution tests
- cashier requests, manager approves
- manager denies
- cashier retries with corrected lower amount
- manager self-approves own threshold action

### 6. Returns/exchange tests
- partial return from split-tender sale
- exchange with scanned tracked items only
- duplicate return attempt on already returned line
- return that crosses approval threshold because quantity changed

---

## Recommended Guardrails In Design

### Guardrail 1 — Separate cart, transaction, tender, event, and exception concepts
These should relate tightly but not collapse into one blob.

### Guardrail 2 — Make every risky action explainable later
If a manager asks "why is the drawer short?" the data model should support a believable answer.

### Guardrail 3 — Fail closed on approval-required actions
If approval state is ambiguous, do not continue the risky action silently.

### Guardrail 4 — Fail safe on payment completion
If final commit result is unknown, preserve a recoverable state instead of pretending success.

### Guardrail 5 — Preserve historical truth
Receipts, transaction rows, shift summaries, and exception logs should agree on what happened.

---

## Best Opportunities, Not Just Risks

### Opportunity 1
SwiftPOS can feel much more trustworthy than old POS systems if approval attribution and shift cash math are visibly clean.

### Opportunity 2
A genuinely good split-tender flow is a strong real-world differentiator because many small-store POS systems get it half right.

### Opportunity 3
Touchscreen-first tender + approval UX can make the product feel faster than incumbents even before advanced reporting ships.

### Opportunity 4
Because the current foundation already has thresholds, sessions, and event/exception placeholders, Forge can build checkout on a cleaner seam than most greenfield POS projects get.

---

## Blunt Recommendation
If there is only enough time to get a few things very right, prioritize these in order:
1. idempotent sale completion
2. normalized tender lines
3. exact threshold/approval behavior
4. shift cash math from cash tender truth
5. split-tender-aware refund/return design

Everything else is easier to refine later than those five.
