# SwiftPOS — Proposed Spec Additions (v1.5 Draft)

Date: 2026-03-22
Status: Proposed additions for incorporation into main product spec

---

## 1. Transaction Integrity, Cash Shrinkage Controls, and Suspicious Employee Behavior

### 1.1 Purpose
SwiftPOS should include built-in transaction integrity controls to reduce cash shrinkage, increase cashier accountability, and surface suspicious behavior patterns early.

This is not positioned as hidden surveillance. It is an operational control and auditability feature designed to:
- reduce revenue leakage
- make void/cancel abuse harder
- preserve a complete transaction trail
- correlate employee behavior with drawer discrepancies
- give managers actionable review tools

### 1.2 Core Principles
- No meaningful transaction should disappear without an audit trail.
- Void/cancel behavior should be explainable, attributable, and reportable.
- Manager approvals should be required for higher-risk actions.
- Suspicion should be based on patterns, not a single isolated event.
- Employee monitoring should be operationally useful, not noisy.

### 1.3 Transaction Event Logging
SwiftPOS should record a transaction lifecycle trail for register activity.

Suggested event types:
- cart_created
- item_added
- item_removed
- quantity_changed
- discount_applied
- total_calculated
- payment_started
- payment_method_selected
- tender_added
- transaction_completed
- transaction_cancelled
- transaction_voided
- refund_started
- refund_completed
- drawer_opened_manual

Each event should store:
- org_id
- location_id
- register_id
- employee_id
- transaction_id (or cart/session id if not yet finalized)
- event_type
- payload (JSONB)
- created_at

This enables managers to distinguish:
- a customer changing their mind early
- a cart being abandoned normally
- repeated cancellations after totals are shown
- suspicious cash tender behavior

### 1.4 Void / Cancel Controls
For the following actions, SwiftPOS should require explicit reason codes and log them immutably:
- full transaction cancellation
- transaction void after total is calculated
- item void/removal after payment has started
- clear cart above configurable value threshold
- delete open ticket
- post-completion void or reversal

Reason codes (configurable examples):
- customer changed mind
- duplicate scan
- cashier error
- pricing correction
- payment failure
- manager instruction
- damaged item
- test transaction

### 1.5 Manager Approval Rules
SwiftPOS should allow configurable approval thresholds.

Examples:
- void transaction above $X requires manager PIN
- more than N voids in a shift requires manager review
- post-total cancellation above threshold requires manager PIN
- refund/store-credit issuance above threshold requires manager PIN
- manual price override above threshold requires manager PIN

Approval log should include:
- action requested
- cashier employee_id
- approving manager employee_id
- reason code
- transaction amount
- timestamp

### 1.6 Cash Discrepancy Correlation
SwiftPOS should correlate:
- shift over/short amounts
- void/cancel frequency
- manual drawer opens
- cash sales vs voided cash sales
- high-value cart cancellations

Goal:
produce a manager-facing view showing whether cash discrepancies align with unusual behavior patterns.

### 1.7 Suspicious Employee Behavior Dashboard
Add a management dashboard for behavior exceptions.

Suggested signals:
- high cancel/void rate vs store average
- high voided cash sales vs peers
- repeated post-total cancellations
- excessive item removals from carts
- frequent manual price overrides
- unusual manual drawer opens
- repeated high-value cart clears
- elevated shift discrepancies over time
- unusual gift card/store-credit adjustments

Suggested dashboard views:
- by employee
- by location
- by date range
- by action type
- by severity level

### 1.8 Severity / Flagging Model
Flags should be advisory, not automatic accusations.

Suggested severity:
- Low: slightly elevated behavior vs peers
- Medium: repeated exceptions over multiple shifts
- High: repeated exceptions plus cash discrepancies or approvals abuse

### 1.9 Reporting
Add reports for:
- void/cancel summary by employee
- void/cancel summary by location
- cash discrepancy trend by employee
- price override report
- manual drawer open report
- suspicious activity report with filterable rule hits

### 1.10 Data Model Additions
Suggested tables:

#### transaction_events
- id
- org_id
- location_id
- register_id
- employee_id
- transaction_id
- event_type
- payload JSONB
- created_at

#### transaction_exceptions
- id
- org_id
- location_id
- transaction_id
- employee_id
- action_type
- reason_code
- amount
- requires_approval
- approved_by
- created_at

#### employee_behavior_flags
- id
- org_id
- employee_id
- location_id
- flag_type
- severity
- source_ref_type
- source_ref_id
- details JSONB
- created_at
- reviewed_by
- reviewed_at

### 1.11 MVP Scope
Recommended MVP:
- immutable cancel/void audit trail
- reason codes
- manager PIN approval above thresholds
- employee-level exception reports
- shift discrepancy correlation
- suspicious behavior dashboard (basic rule-based)

### 1.12 Later Enhancements
- anomaly scoring / risk score
- scheduled alert digests to Dashboard app
- camera/event correlation integrations
- per-rule tuning by location
- ML-assisted anomaly detection

---

## 2. Payments Flexibility: Split Tender, Partial Payments, Layaway, Gift Cards, and Store Credit Controls

### 2.1 Purpose
SwiftPOS should support real-world retail payment flexibility without compromising reporting or auditability.

This module covers two related but distinct flows:
1. split tender during a normal checkout
2. partial-payment / layaway orders paid over time

It also strengthens gift card and store-credit controls because those instruments are frequent fraud and shrinkage vectors.

### 2.2 Split Tender Payments
Split tender should be supported as a core checkout feature.

Examples:
- partial cash + partial credit card
- cash + gift card
- cash + store credit
- card + gift card
- multiple cards

#### Required behavior
- cashier can add multiple tenders to a single sale
- remaining balance updates live after each tender
- change due is calculated only from the cash portion when appropriate
- receipt shows each tender line separately
- transaction record stores each tender component explicitly
- reports break down tender usage accurately

#### Suggested UI flow
At checkout:
- show total due
- cashier selects payment method
- enters amount for that tender
- remaining balance updates
- cashier adds another tender if balance remains
- checkout completes when remaining balance reaches zero

#### Suggested data shape
Instead of a flat payment field, store normalized tender lines.

Suggested structure:
- transaction_tenders
  - id
  - transaction_id
  - tender_type (cash/card/gift_card/store_credit/loyalty/other)
  - amount
  - reference_id (optional: gift card id, processor ref, etc.)
  - metadata JSONB

### 2.3 Refunds for Split Tender
Refund logic must be explicit.

Rules:
- refund to original payment mix where possible
- if exact return mix is not possible, require manager choice or configured fallback
- gift card/store-credit redemptions should restore balances correctly
- refund receipt must clearly show tender breakdown

### 2.4 Partial Payment / Layaway Orders
Layaway should be treated as a distinct workflow, not confused with split tender.

Use cases:
- customer pays deposit now, balance later
- item is held for pickup upon full payment
- customer makes multiple payments over time

#### Core behavior
- create layaway order from current cart
- take initial deposit
- store remaining balance
- track payment history
- optionally assign due date
- reserve/hold inventory while unpaid
- convert to completed sale when balance reaches zero

#### Suggested statuses
- draft
- active_layaway
- partially_paid
- paid_in_full
- collected
- cancelled
- forfeited
- refunded

#### Suggested fields
layaways:
- id
- org_id
- location_id
- customer_id
- created_by
- status
- subtotal
- discount
- tax
- total
- deposit_paid
- balance_due
- due_date
- cancellation_policy_snapshot
- created_at
- updated_at

layaway_payments:
- id
- layaway_id
- tender_type
- amount
- employee_id
- created_at
- metadata JSONB

### 2.5 Inventory Behavior for Layaway
Configurable options:
- reserve inventory immediately on layaway creation
- reserve at specific pickup location
- auto-release inventory if layaway expires or is cancelled

### 2.6 Policy Controls
Configurable per location/org:
- minimum deposit amount or percentage
- layaway duration
- cancellation/forfeit rules
- whether tax is collected at deposit time or final payment
- whether manager approval is required for cancellation/refund

### 2.7 Gift Cards & Store Credit — Strengthened Controls
Gift cards and store credit already exist in the SwiftPOS spec, but should gain tighter operational controls.

#### Add controls for:
- manual balance adjustments
- high-value activations
- rapid activate/redeem patterns
- excessive store-credit issuance by employee
- gift card reload/refund abuse

#### Add reporting for:
- issued vs redeemed by employee
- outstanding liability trend
- suspicious redemption/activation patterns
- manual adjustment report

#### Add approval rules for:
- manual gift card activation above threshold
- store credit issuance above threshold
- balance adjustments
- card replacement / transfer actions

### 2.8 Suspicious Tender Behavior
This module should integrate with the suspicious employee behavior system.

Examples of tender-related flags:
- frequent gift card/store-credit issuance
- frequent store-credit refunds
- unusual tender mix compared with peers
- repeated cash cancellations after total shown
- excessive split tenders with unusual manual overrides

### 2.9 MVP Scope
Recommended MVP:
- split tender payments in normal checkout
- normalized tender-line storage
- receipt support for split tenders
- refund rules for split tenders
- layaway/deposit order flow (simple)
- inventory hold/release for layaway
- strengthened store credit/gift card audit trail

### 2.10 Later Enhancements
- custom payment plans
- automated layaway reminders
- online layaway support
- customer self-service layaway status
- partial online + in-store hybrid payments
- more advanced tender-risk scoring

---

## 3. Roadmap Recommendation

### Add to near-term roadmap
High value / strong fit:
1. Transaction Integrity & Cash Shrinkage Controls
2. Split Tender Payments
3. Suspicious Employee Behavior Dashboard
4. Strengthened Gift Card / Store Credit Controls

### Add after that
5. Layaway / Partial-Payment Orders

### Why this order
- transaction integrity directly protects revenue
- split tender is core POS behavior, not a niche add-on
- suspicious employee reporting compounds the value of audit logging
- gift card/store-credit controls close common abuse vectors
- layaway is valuable, but operationally more complex than split tender

---

## 4. Product Strategy Note
These additions fit SwiftPOS best when positioned as:
- operator-first retail controls
- revenue protection
- practical checkout flexibility
- real-world store workflows

They are much more aligned with SwiftPOS’s core than broad accounting/payroll expansion in the early product phases.
