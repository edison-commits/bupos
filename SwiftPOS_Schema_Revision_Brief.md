# SwiftPOS — Schema Revision Brief

Date: 2026-03-22
Purpose: define the key schema changes needed to support the trimmed Phase 1 plan and v1.5 additions without drifting into unnecessary complexity.

---

## 1. Goals
The schema should support these Phase 1 priorities cleanly:
- reliable register transactions
- normalized tender handling (including split tender)
- inventory truth by location
- shifts and cash reconciliation
- transaction lifecycle auditability
- exception logging for void/cancel/override behavior
- customer attachment and basic loyalty

This brief focuses on schema decisions that should be made early because they are painful to retrofit later.

---

## 2. Core Schema Principles
- Prefer normalized operational data for money movement and auditability
- Avoid storing too much critical data only inside JSON blobs
- Keep denormalized snapshots only where they improve performance or preserve historical truth
- Every operationally sensitive table should carry `org_id` and relevant `location_id`
- Design for immutable financial/event history where possible
- Distinguish clearly between:
  - transactions
  - tenders
  - lifecycle events
  - exceptions
  - inventory movements

---

## 3. High-Priority Revisions

### 3.1 Transactions: stop relying on `payment_methods (JSONB)` alone
The current v1.4 spec stores transaction payment info in a JSONB field.

That is too weak for:
- split tender
- refund reconstruction
- payment-method reporting
- discrepancy analysis
- suspicious employee behavior patterns

#### Recommendation
Keep `transactions` as the sale header, but move tender detail to a dedicated table.

### Revised `transactions` table
Keep/add:
- id
- org_id
- location_id
- employee_id
- customer_id
- shift_id
- status
- subtotal
- discount_total
- tax_total
- total
- rounded_total (if cash rounding applies)
- note
- created_at
- completed_at
- voided_at
- voided_by
- void_reason_code

Optional retained JSON snapshots:
- cart_snapshot JSONB
- tax_snapshot JSONB

Use snapshots only as historical render data, not as the sole source of tender truth.

---

### 3.2 New `transaction_tenders` table
This is required for split tender.

Suggested fields:
- id
- org_id
- transaction_id
- location_id
- shift_id
- tender_type (`cash`, `card`, `gift_card`, `store_credit`, `loyalty`, `other`)
- amount
- currency_code
- processor_reference nullable
- gift_card_id nullable
- store_credit_ref nullable
- metadata JSONB
- created_at

#### Why this matters
This table enables:
- split-tender checkout
- refund routing logic
- payment-method reporting
- cashier behavior analysis
- exact tender audit trails

---

### 3.3 Transaction line items should be normalized or partially normalized
The v1.4 spec stores transaction items in JSONB.

That may be acceptable as a snapshot, but Phase 1 benefits from line-item normalization if reporting and auditability matter.

#### Recommendation
Either:
1. add `transaction_items` now
or
2. keep JSONB temporarily but treat it as transitional debt to remove early

Preferred `transaction_items` fields:
- id
- transaction_id
- product_id
- variant_id nullable
- item_name_snapshot
- sku_snapshot nullable
- quantity
- unit_price
- discount_amount
- tax_amount
- line_total
- note nullable
- created_at

If modifiers matter operationally, also add:
- `transaction_item_modifiers`

This will pay off in reporting, returns, and integrity checks.

---

### 3.4 New `transaction_events` table
This supports lifecycle auditability.

Suggested fields:
- id
- org_id
- location_id
- register_id nullable
- employee_id
- transaction_id nullable
- cart_session_id nullable
- event_type
- payload JSONB
- created_at

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
- manual_drawer_open

#### Why this matters
This gives the system:
- loss-prevention visibility
- cashier event trails
- support for suspicious pattern detection
- better debugging around register flows

---

### 3.5 New `transaction_exceptions` table
Use this for operationally sensitive actions.

Suggested fields:
- id
- org_id
- location_id
- transaction_id nullable
- employee_id
- action_type
- reason_code
- amount nullable
- requires_approval
- approved_by nullable
- approval_note nullable
- metadata JSONB
- created_at

Suggested action types:
- full_void
- post_total_cancel
- item_void
- cart_clear_high_value
- refund_override
- manual_price_override
- discount_override
- gift_card_adjustment
- store_credit_issue

#### Why separate from events?
Because not every event is exceptional, and exception review/reporting needs its own clean table.

---

### 3.6 Shift / cash tables need better tender linkage
The current shift model is directionally fine, but should rely on normalized tender rows for expected cash math.

#### Recommendation
Expected cash should be derived from:
- opening cash
- cash transaction tender lines
- cash refunds
- pay-ins/pay-outs
- manual drawer adjustments

Avoid deriving cash expectations from aggregate transaction totals alone.

---

### 3.7 Inventory movement must stay explicit
The v1.4 schema already has `inventory_logs`, which is good.

Strengthen with:
- source_type
- source_id
- employee_id
- location_id
- quantity_before
- quantity_after
- reason_code
- created_at

This makes inventory truth easier to defend when investigating shrinkage or mistakes.

---

### 3.8 Gift cards and store credit need stronger auditability
The v1.4 schema already includes gift card tables.

#### Recommendation
Ensure every balance-changing action is explicit and attributable.

Likely useful additions:
- approval_required bool or approval ref for manual adjustments
- linked employee/location on all balance changes
- source transaction / return refs where applicable

If store credit is implemented via gift card mechanics, keep the distinction explicit with `is_store_credit` or separate type field.

---

### 3.9 Layaway should use dedicated tables, not overloaded transactions
Do not overload standard transactions for layaway lifecycle.

Suggested tables:
- `layaways`
- `layaway_items`
- `layaway_payments`

This keeps:
- active balance due
- hold/reservation state
- payment history
- cancellation rules

cleanly separate from finished sales.

---

## 4. Tables to Keep As-Is for Now
Reasonably fine for early phases:
- organizations
- locations
- employees
- categories
- products
- product_variants
- modifier_groups
- modifiers
- product_modifier_groups
- customers

These can evolve, but they are not the highest-risk modeling area right now.

---

## 5. Tables to Defer From Active Engineering Focus
Do not spend serious Phase 1 modeling energy here yet:
- accounting tables
- payroll tables
- online store tables
- transfer suggestion / AI tables
- warehouse-specific tables
- plugin/platform marketplace concepts

Keep them documented, but do not let them dominate implementation sequencing.

---

## 6. Migration Strategy Recommendation
Suggested migration order:

### Migration A
- organizations / locations / employees / roles
- products / variants / modifiers
- inventory / inventory_logs

### Migration B
- transactions
- transaction_items
- transaction_tenders
- customers

### Migration C
- shifts
- cash_movements
- returns
- loyalty basics

### Migration D
- transaction_events
- transaction_exceptions
- manager approvals / reason code support

### Migration E (later)
- gift card/store credit strengthening
- layaway tables

---

## 7. Reporting Implications
These schema changes directly improve:
- payment method breakdown reports
- split tender refunds
- cashier behavior analysis
- void/cancel audit reports
- suspicious employee behavior signals
- shift cash discrepancy analysis
- inventory movement traceability

If these tables are modeled poorly, reporting quality will suffer permanently.

---

## 8. Recommended Immediate Decisions
Make these decisions before serious implementation starts:
1. `transaction_tenders` is mandatory
2. `transaction_events` is mandatory
3. `transaction_exceptions` is mandatory
4. `transaction_items` should be normalized now if possible
5. layaway stays separate from standard transactions
6. expected cash derives from tender lines + cash movement, not only transaction headers

---

## 9. Blunt Recommendation
If SwiftPOS wants to be credible as a retail system with real operator controls, it needs:
- normalized tender handling
- strong event history
- explicit exception logging
- inventory movement provenance

Those are the schema choices worth getting right early.
