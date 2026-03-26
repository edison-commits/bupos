# SwiftPOS QA Test Matrix — Cart / Checkout / Tender

Date: 2026-03-22  
Audience: Forge + Edison  
Purpose: concrete QA coverage for the next register build slices.

---

## Scope Anchors
Use these current business rules while testing:
- Supported V1 tenders: cash, card, store credit, split tender
- No receipt must be an explicit checkout option
- Returns over **$40** require manager approval
- Exchanges do **not** require approval if fully tracked/scanned
- Manager approval thresholds:
  - discounts over **$5**
  - full transaction voids over **$20**
  - item voids over **$15**
  - store credit issuance over **$10**
  - manual price overrides over **$10**
- Expected cash should derive from opening cash + cash tender lines + refunds + pay-ins/pay-outs + drawer adjustments

---

## Test Data Baseline
Before executing the matrix, keep at least these fixtures available:
- low-price item under $5
- item around $15
- item around $20
- item around $40
- item over $40
- taxable item
- non-taxable item if supported later
- item with modifier group
- item with barcode
- item with product image / touch favorite
- customer with purchase history
- customer without loyalty/store credit
- customer with usable store credit balance
- active cashier session
- active manager session / manager PIN
- open shift with known opening float

---

## Execution Priorities
- **P0** = must pass before real pilot use
- **P1** = should pass in same milestone
- **P2** = good hardening coverage

---

## 1. Cart Build + Edit Flows

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| CART-01 | P0 | Add item from touch grid | Item appears once in cart with correct name, price, qty 1 |
| CART-02 | P0 | Add same item repeatedly | Quantity increments predictably; no duplicate math drift |
| CART-03 | P0 | Add item from search results | Search selection and cart state match same product/variant |
| CART-04 | P0 | Add variant item | Correct variant/SKU/price captured |
| CART-05 | P1 | Add item with modifiers | Required modifiers enforced; selected modifiers persist in cart |
| CART-06 | P0 | Increase/decrease quantity | Totals update immediately and correctly |
| CART-07 | P0 | Remove line before payment starts | Cart updates cleanly; event trail remains explainable |
| CART-08 | P0 | Clear entire cart below high-risk threshold | Cart clears without stale totals or ghost lines |
| CART-09 | P1 | Clear high-value cart | Requires reason/event logging; approval if configured later |
| CART-10 | P1 | Rapid tap same product 5–10 times | No dropped taps, duplicate race conditions, or incorrect quantities |
| CART-11 | P1 | Switch customer on active cart | Customer assignment updates without resetting lines/totals |
| CART-12 | P1 | Idle cart then resume | Cart state is preserved or clearly reset by policy, not ambiguous |

---

## 2. Totals / Pricing / Tax

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| PRICE-01 | P0 | Single taxable item | Subtotal, tax, total are correct |
| PRICE-02 | P0 | Multiple quantities | Extended total is exact; no rounding drift |
| PRICE-03 | P0 | Mixed items in cart | Totals remain deterministic after each edit |
| PRICE-04 | P0 | Discount at exactly $5 | No manager approval if rule is strictly over $5 |
| PRICE-05 | P0 | Discount at $5.01 | Approval required |
| PRICE-06 | P0 | Manual price override at exactly $10 | No approval if rule is strictly over $10 |
| PRICE-07 | P0 | Manual price override at $10.01 | Approval required |
| PRICE-08 | P1 | Discount then quantity change | Discount/tax recompute correctly |
| PRICE-09 | P1 | Remove discounted item | Totals and discount allocation normalize correctly |
| PRICE-10 | P1 | Cash rounding rule foundation | If rounding enabled later, display and stored totals stay aligned |

---

## 3. Checkout Core

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| CHK-01 | P0 | Complete sale with cash only | Sale completes, drawer math updates, receipt/no-receipt prompt shown |
| CHK-02 | P0 | Complete sale with card only | Sale completes, non-cash tender stored accurately |
| CHK-03 | P0 | Complete sale with store credit only | Balance validation works; tender stored explicitly |
| CHK-04 | P0 | Choose no receipt | Transaction completes with explicit no-receipt selection logged if supported |
| CHK-05 | P0 | Print/browser receipt | Receipt renders readable totals and tender lines |
| CHK-06 | P0 | Tap pay/complete twice quickly | Exactly one completed transaction is created |
| CHK-07 | P0 | Network/storage delay during completion | UI prevents duplicate completion and preserves clear status |
| CHK-08 | P1 | Cancel payment before completion | Cart remains recoverable; partial tender not silently committed |
| CHK-09 | P1 | Payment started then line item edited | System either blocks edit or recomputes safely; no stale tender mismatch |

---

## 4. Split Tender

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| SPLIT-01 | P0 | Cash + card split | Remaining balance updates after first tender; final sale stores two tender lines |
| SPLIT-02 | P0 | Cash + store credit split | Store credit applies first or by entered amount; remaining due stays accurate |
| SPLIT-03 | P0 | Two card-style entries | Multiple tenders can coexist if product allows it |
| SPLIT-04 | P0 | First tender equals full amount | Checkout completes without forcing extra split UX |
| SPLIT-05 | P0 | Tender amount exceeds remaining balance (non-cash) | Block or constrain overpayment |
| SPLIT-06 | P0 | Cash tender exceeds remaining balance | Change due derived only from cash overage |
| SPLIT-07 | P0 | Mixed split then receipt | Receipt shows each tender line separately |
| SPLIT-08 | P1 | Remove last tender line before completion | Remaining balance recalculates correctly |
| SPLIT-09 | P1 | Edit first split amount after second tender entered | All balances update correctly; no negative remainder |
| SPLIT-10 | P1 | $0.01 final remainder | Final tender handling is exact; no stuck checkout |
| SPLIT-11 | P1 | Split payment across approval-triggering discounted sale | Approval state persists through tender flow |
| SPLIT-12 | P0 | Stored transaction record matches UI breakdown | DB/state and receipt exactly match tender mix |

---

## 5. Approvals During Sale Flow

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| APP-01 | P0 | Discount over threshold by cashier | Approval modal/flow blocks completion until manager approves |
| APP-02 | P0 | Manual override over threshold by cashier | Same as above |
| APP-03 | P0 | Item void over $15 by cashier | Approval required |
| APP-04 | P0 | Full transaction void over $20 by cashier | Approval required |
| APP-05 | P0 | Store credit issuance over $10 | Approval required |
| APP-06 | P0 | Manager denies approval | Risky action does not proceed; cart remains explainable |
| APP-07 | P0 | Wrong manager PIN entered | Approval denied, attempt not treated as success |
| APP-08 | P1 | Manager approves on same terminal while cashier remains actor | Cashier remains transaction actor; approving manager is stored separately |
| APP-09 | P1 | Approval request abandoned mid-flow | Pending state is recoverable or cancelled cleanly |
| APP-10 | P1 | Threshold edge values exactly equal to config | Strictly-over semantics honored consistently |

---

## 6. Returns / Exchange Foundation

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| RET-01 | P0 | Lookup prior transaction | Correct sale is found without ambiguity |
| RET-02 | P0 | Return one item under $40 | No manager approval required |
| RET-03 | P0 | Return value exactly $40 | No approval if rule is strictly over $40 |
| RET-04 | P0 | Return value $40.01 | Manager approval required |
| RET-05 | P0 | Exchange with all items tracked/scanned | No manager approval required |
| RET-06 | P0 | Return on split-tender original sale | Refund path retains original tender context |
| RET-07 | P1 | Partial return from multi-line original sale | Inventory and refund amount affect only returned lines |
| RET-08 | P1 | Return item already previously returned | System blocks duplicate return or flags it clearly |
| RET-09 | P1 | Return with store credit fallback | Manager choice/config required when original mix cannot be recreated |
| RET-10 | P1 | Return updates inventory | On-hand changes are attributable and auditable |

---

## 7. Shift / Register Session Effects

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| SHIFT-01 | P0 | Open shift with opening float | Shift record created with employee/session attribution |
| SHIFT-02 | P0 | Complete cash sale during open shift | Expected cash basis increases correctly |
| SHIFT-03 | P0 | Complete card-only sale during open shift | Expected cash does not increase from non-cash tender |
| SHIFT-04 | P0 | Complete split cash+card sale | Expected cash increases only by cash tender portion |
| SHIFT-05 | P0 | Close shift blind | User can declare cash without seeing expected amount if blind close mode enabled |
| SHIFT-06 | P0 | Close shift with variance | Variance calculated and stored clearly |
| SHIFT-07 | P1 | Auto-close/register session end with open shift | System behavior is explicit and auditable, not silent |
| SHIFT-08 | P1 | Pay-in/pay-out affects expected cash | Shift cash math reflects movement reason and amount |
| SHIFT-09 | P1 | Refund reduces expected cash correctly | Shift cash expectation adjusts from refund cash amount |

---

## 8. Audit / Idempotency / Data Integrity

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| DATA-01 | P0 | Completed sale writes transaction + items + tender lines | No partial write state |
| DATA-02 | P0 | Approval-triggering action writes exception/approval attribution | Cashier and manager identities both preserved |
| DATA-03 | P0 | Cancel/void action captures reason code | No silent destructive action |
| DATA-04 | P0 | Refresh terminal immediately after completion | Completed sale remains persisted; cart not duplicated |
| DATA-05 | P1 | Browser back/forward during tender flow | No accidental double sale or orphan tender record |
| DATA-06 | P1 | Two rapid approvals or two rapid pay taps | Idempotent final result |
| DATA-07 | P1 | Close shift after many mixed tenders | Expected cash still traceable from tender lines, not guessed from headers |

---

## 9. Touchscreen Regression Checks
These should be run for every register milestone, not only final UX polish.

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| TOUCH-01 | P0 | Primary actions reachable without precision mouse work | Touch targets are large and spaced |
| TOUCH-02 | P0 | Numeric amount entry on touchscreen | Fast, no tiny input traps |
| TOUCH-03 | P0 | Approval PIN entry on touchscreen | Can complete without keyboard dependency |
| TOUCH-04 | P1 | Scrollable product grid and cart on tablet | No accidental page zoom or drag conflict |
| TOUCH-05 | P1 | Sunlight/glare/high-brightness quick check | Contrast still workable |
| TOUCH-06 | P1 | Error state after mistap | Recovery is one obvious tap, not a hunt |

---

## Highest-Risk Cases To Run First
1. Cash + card split tender with change due from cash portion only  
2. Discount at $5 vs $5.01  
3. Manual override at $10 vs $10.01  
4. Return at $40 vs $40.01  
5. Split-tender sale followed by partial return  
6. Double-tap complete payment  
7. Close shift after mixed cash/card/store-credit sales  
8. Manager approval denial + retry  
9. Exchange without approval when fully scanned  
10. Ending register session with active shift/cart/payment in progress

---

## QA Exit Gate for Checkout Milestone
Do not call checkout "ready" until all of these are true:
- all P0 tests pass
- tender lines persist exactly once per completed transaction
- threshold edge cases match configured business rules
- split tender receipt output matches stored breakdown
- shift expected cash uses cash tender math, not gross sales totals
- approval attribution stores cashier actor and manager approver separately
- no-receipt path is explicit and usable
- touchscreen path works without a keyboard for normal cashier flow
