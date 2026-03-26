# SwiftPOS Touchscreen Register UX Checklist

Date: 2026-03-22  
Audience: Forge + Edison  
Purpose: keep the register genuinely fast on all-in-one touchscreen PCs and tablets.

---

## Product Priorities This Checklist Supports
- stability
- speed/responsiveness
- touchscreen friendliness
- low-friction cashier flow
- cash-handling trust

---

## 1. Interaction Model
- Primary cashier actions should be completable with touch alone during normal sales.
- Keyboard use should be optional, not required, for common register flow.
- One tap should do one obvious thing.
- High-frequency actions should stay in thumb-reachable zones on common tablet and all-in-one layouts.
- Do not make the cashier aim at tiny icons for destructive or high-frequency actions.

---

## 2. Touch Target Rules
- Minimum target size should stay at or above the current touch-button baseline.
- Keep enough spacing between adjacent destructive/non-destructive actions.
- Quantity + / - controls must be comfortably tappable without precision.
- Tender buttons must be large enough for fast repeated use.
- Approval actions must not be hidden in tiny inline links.
- Close / void / clear actions must be visually distinct from pay / complete actions.

Quick pass/fail check:
- Can a rushed cashier reliably hit the intended action with one finger on a smudged screen?

---

## 3. Visual Hierarchy
- Cart total and remaining balance must be impossible to miss.
- Primary action per step should be visually dominant.
- Secondary actions should be available but quieter.
- High-risk actions should look meaningfully riskier than normal actions.
- Manager approval state should be obvious and not blend into standard validation messages.
- Cash change due should be very prominent when it exists.

---

## 4. Cart Screen Layout
- Cart contents should remain readable at a glance with name, variant, qty, line total.
- Avoid line-item density that forces precision tapping.
- Selected line item state should be unmistakable.
- Scrolling cart should not interfere with tapping item actions.
- Empty-cart state should make the next step obvious: search, category browse, or favorites.
- Cart should keep totals visible even when line list is long.

Recommended persistent elements:
- current cashier / session identity
- shift state
- current customer or walk-in state
- subtotal / tax / total
- checkout CTA

---

## 5. Product Discovery
- Product search box must be instantly focusable and fast.
- Category chips/buttons should be finger-sized.
- Touch favorites should exist for top sellers.
- Product cards should support image-first browsing where it helps speed.
- Out-of-stock or inactive products should be visually obvious and hard to mis-tap.
- Search results should not jump around during input in a way that causes wrong taps.

---

## 6. Amount Entry UX
- Numeric entry for cash tender, override amounts, shift opening float, and close cash must use a touch-friendly keypad or similarly large control.
- Decimal entry should be predictable.
- Amount fields should sanitize cleanly without weird cursor jumps.
- Default focus should not summon a tiny browser-native number spinner experience if avoidable.
- Common full-pay shortcuts should exist where useful:
  - exact cash
  - exact card
  - remaining balance

---

## 7. Split Tender UX
- Remaining balance should stay visible at all times during tender entry.
- Each applied tender must appear as a separate line before completion.
- It should be easy to understand which tender can still be edited or removed.
- Overpayment rules must be visually clear, especially cash vs non-cash.
- The system must clearly indicate when checkout is complete vs when more tender is still required.
- Do not hide split tender behind a secondary mystery menu; it is core V1 behavior.

---

## 8. Approval UX
- Approval prompt should clearly show:
  - requested action
  - amount that triggered approval
  - threshold basis
  - cashier identity
  - reason code requirement
- Manager PIN entry should be fast on touch.
- Denial path should be explicit and easy.
- Returning to the cart after denial should not feel like a crash or dead end.
- Approval success should resume exactly the intended action, not create a vague elevated state.

---

## 9. Returns / Exchange UX
- Transaction lookup must support fast cashier recovery when customer has a receipt, order number, or item to scan.
- Returned items should be clearly distinguished from original sold quantities.
- Approval-needed returns should show why approval is required.
- Exchanges should make the "tracked/scanned" condition obvious so cashiers understand when approval is not needed.
- Refund destination/tender outcome must be explained in plain language.

---

## 10. Shift / Session UX
- Register session status should be visible without leaving the register flow.
- Open shift action should be obvious after PIN login.
- Starting cash entry should be fast and low-friction.
- Close shift flow should clearly separate:
  - expected cash
  - declared cash
  - variance
  - notes
- Blind close mode must not accidentally reveal expected cash.
- Auto-close or forced-close behavior should be explicit, never silent.

---

## 11. Error Recovery
- Validation messages should tell the cashier what to do next.
- Errors should appear near the relevant action, not as vague page-level noise only.
- Failed payment/approval actions must leave the cart in a recoverable state.
- Avoid modal dead ends where the only escape is refreshing the page.
- After transient failure, retry should be obvious and safe.

---

## 12. Performance Perception
- Product add-to-cart should feel instant.
- Totals should update immediately after edits.
- Approval prompt should appear without lag when threshold crossed.
- Checkout completion should provide immediate progress feedback.
- Avoid full-page reload feel for common register actions.
- Skeletons/spinners should be used sparingly; frozen uncertainty is worse than a tiny delay.

---

## 13. Accessibility / Real-World Use
- Contrast should survive bright retail lighting.
- Important statuses should not rely on color alone.
- Text should stay readable at arm’s length on all-in-one hardware.
- Numeric keypad and tender controls should work for left- or right-handed use.
- Sound/visual confirmation may help later, but not at the cost of clutter.

---

## 14. Anti-Mistap Safeguards
- Destructive actions should require either confirmation or a deliberate secondary step.
- Complete sale button should not sit directly adjacent to void/clear cart.
- Removing an applied tender should be clearly intentional.
- Manager approval should not be triggerable by accident from normal cashier taps.
- Double-submission protection is mandatory on checkout and shift close.

---

## 15. Quick Device Passes To Run
### All-in-one touchscreen PC
- standing operator distance
- repeated item adds
- cash tender entry
- manager approval handoff on same screen
- shift open/close numeric entry

### Tablet browser
- portrait/landscape sanity check
- cart scroll + item edit
- split tender entry
- no-receipt completion
- return lookup

---

## Red Flags
If any of these are true, the UX is not ready:
- cashier needs keyboard for ordinary checkout
- totals or remaining balance can scroll out of sight during payment
- split tender is hidden or confusing
- approval flow changes who appears to own the transaction
- destructive actions are easy to mis-tap
- shift close math is hard to understand
- error recovery requires refresh or manager guesswork

---

## Recommended Build Principle
When design choices compete, prefer:
1. fewer taps
2. clearer state
3. larger targets
4. more obvious totals and balance
5. explicit accountability over clever compactness

A POS register is not a consumer app. Speed and trust beat elegance every time.
