# SwiftPOS Permissions + Approval Scenarios

Date: 2026-03-22  
Audience: Forge + Edison  
Purpose: define concrete approval behavior before checkout and returns are implemented.

---

## Source Rules Already Established
### Roles in current foundation
- owner
- manager
- cashier
- inventory_clerk
- support

### Current explicit approval permissions in domain model
- approval.discount
- approval.void_item
- approval.void_transaction
- approval.store_credit
- approval.price_override

### V1 thresholds
- discounts over **$5**
- full transaction voids over **$20**
- item voids over **$15**
- store credit issuance over **$10**
- manual price overrides over **$10**
- returns over **$40** require manager approval
- exchanges do **not** require approval if fully tracked/scanned

---

## Recommended Approval Model
### Operator roles during risky actions
- **Cashier** may initiate risky action requests but should not self-approve unless promoted policy says otherwise
- **Manager** may approve configured threshold exceptions
- **Owner** may approve anything a manager can approve
- **Inventory clerk/support** should not have register approval authority by default

### Attribution rule
For any approved action, always store:
- requesting employee (cashier/operator)
- approving employee (manager/owner)
- action type
- amount/value basis
- reason code
- timestamp
- transaction/cart/shift reference

Do **not** replace the cashier with the manager as the transaction actor just because the manager approved.

---

## Scenarios Matrix

| ID | Scenario | Requester | Approval needed? | Approver allowed | Notes |
|---|---|---|---|---|---|
| PERM-01 | Discount at $4.99 | cashier | No | n/a | Under threshold |
| PERM-02 | Discount at $5.00 | cashier | No | n/a | Rule is over $5 |
| PERM-03 | Discount at $5.01 | cashier | Yes | manager/owner | Must log discount amount + reason |
| PERM-04 | Manual override at $10.00 | cashier | No | n/a | Rule is over $10 |
| PERM-05 | Manual override at $10.01 | cashier | Yes | manager/owner | Store before/after price |
| PERM-06 | Item void at $15.00 | cashier | No | n/a | Rule is over $15 |
| PERM-07 | Item void at $15.01 | cashier | Yes | manager/owner | Require reason code |
| PERM-08 | Full transaction void at $20.00 | cashier | No | n/a | Rule is over $20 |
| PERM-09 | Full transaction void at $20.01 | cashier | Yes | manager/owner | Require reason + approval |
| PERM-10 | Store credit issue at $10.00 | cashier | No | n/a | Rule is over $10 |
| PERM-11 | Store credit issue at $10.01 | cashier | Yes | manager/owner | High abuse surface |
| PERM-12 | Return at $40.00 | cashier | No | n/a | Rule is over $40 |
| PERM-13 | Return at $40.01 | cashier | Yes | manager/owner | Must link original transaction |
| PERM-14 | Fully scanned exchange | cashier | No | n/a | Provided items and pricing are fully tracked |
| PERM-15 | Exchange with missing/ambiguous item tracking | cashier | Recommended yes | manager/owner | Product rule currently says no approval only if fully tracked/scanned |
| PERM-16 | Manager performs own over-threshold discount | manager | No extra approval by default | manager/owner | Still log exception + reason |
| PERM-17 | Owner performs own over-threshold action | owner | No extra approval by default | owner | Still log exception + reason |
| PERM-18 | Cashier attempts approval with own PIN | cashier | No | n/a | Must fail unless policy explicitly changes |
| PERM-19 | Inventory clerk on register tries approval | inventory_clerk | No | n/a | Out of register approval scope |
| PERM-20 | Support role tries approval | support | No | n/a | Out of register approval scope |

---

## Approval UX Expectations
### Cashier-triggered action flow
1. Cashier initiates risky action.
2. System checks threshold/config.
3. If approval required, block completion of that action.
4. Show concise approval prompt with:
   - action type
   - amount/value that triggered approval
   - cart/transaction context
   - reason code selection/entry
5. Manager enters PIN on same device or a controlled handoff path.
6. System logs approval attribution and resumes original action.

### Important behavior
- Approval should approve **one action instance**, not grant a temporary elevated mode for the rest of the transaction.
- If cart value changes materially after approval, recompute whether approval is still valid.
- Approval should expire if the action context changes enough that the original approval no longer matches reality.

---

## Reason Code Recommendations
Use consistent reason codes for exceptions/approvals:
- customer_changed_mind
- duplicate_scan
- cashier_error
- pricing_correction
- payment_failure
- manager_instruction
- damaged_item
- verified_return
- exchange_even_swap
- goodwill_adjustment
- test_transaction
- other_manual_note_required

Require a free-text note when:
- `other_manual_note_required` selected
- manager denies the request
- store credit issuance is manual
- post-total cancel/void occurs

---

## High-Risk Scenarios That Need Hard Rules

### 1. Manager self-approval on their own cashiered sale
Recommended rule:
- manager may approve their own over-threshold action in MVP
- but system should still log it as self-approved for reporting

Reason:
Blocking all self-approval may be operationally annoying in a small store, but hiding self-approved exceptions is dangerous.

### 2. Approval after payment has already started
Recommended rule:
- risky action should pause payment flow
- invalidate stale payment entries if transaction economics changed
- require re-confirmation of totals before final completion

### 3. Approval after shift is already closing
Recommended rule:
- do not allow new sales exceptions while close workflow is in final submit state
- resolve or cancel exception before shift close completes

### 4. Approval with wrong manager PIN repeated multiple times
Recommended rule:
- keep denial audit trail
- do not lock terminal too aggressively in MVP
- but surface repeated failed approvals in integrity reporting later

### 5. Cashier switches users mid-approval
Recommended rule:
- approval request should remain bound to original cashier/session/cart
- if session changes, void pending request and require restart

---

## Data / Logging Requirements Per Approval
For each approval-required action, capture at minimum:
- `action_type`
- `threshold_type`
- `threshold_value`
- `actual_amount`
- `requested_by_employee_id`
- `approved_by_employee_id`
- `reason_code`
- `note`
- `register_session_id`
- `shift_id`
- `transaction_id` or `cart_session_id`
- `approved_at`
- outcome: approved / denied / abandoned / expired

---

## Recommended Enforcement Table

| Action | Block action until approval? | Needs reason code? | Needs separate exception record? |
|---|---:|---:|---:|
| over-threshold discount | Yes | Yes | Yes |
| over-threshold manual price override | Yes | Yes | Yes |
| over-threshold item void | Yes | Yes | Yes |
| over-threshold full transaction void | Yes | Yes | Yes |
| over-threshold store credit issuance | Yes | Yes | Yes |
| over-threshold return | Yes | Yes | Yes |
| fully tracked exchange | No | Optional | Maybe event only |
| manager self-performed threshold action | No extra approval | Yes | Yes |

---

## What Forge Should Implement Carefully
1. **Strict over-vs-equal semantics**  
   The current rules are written as "over," so exact threshold values should not trigger approval unless product changes the wording.

2. **Separate requester from approver**  
   This is critical for fraud visibility and accountability.

3. **One approval does not unlock the whole cart**  
   Avoid broad elevated state. Approve action-by-action.

4. **Approval context can go stale**  
   If line items, totals, or refund amounts change after approval prompt opens, recompute.

5. **Exchanges need a clean decision tree**  
   "No approval if fully tracked/scanned" implies approval probably is needed when that condition is not met.

---

## Open Product Clarifications Worth Asking Later
These do not block the first build, but should be answered before pilot:
- Can a manager self-approve their own exception actions in all cases, or only some?
- If original split-tender refund cannot be reconstructed, what is preferred fallback order: original tender attempt -> store credit -> manager choice?
- Does a post-total cart cancellation under $20 still require a reason code even when approval is not required? Recommended answer: yes.
- Should repeated low-value voids in one shift trigger review even if each individual void is under threshold? Recommended answer: yes, later rule-based reporting.
