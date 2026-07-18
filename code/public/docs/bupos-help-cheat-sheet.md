# BUPOS Help / Store Recovery Cheat Sheet

*Keep this near the register or manager workstation. It explains what the BUPOS Help page can do today, what it will never do on its own, and when to escalate.*

## Where to go

Open **Admin → Help**.

Use this page when something feels wrong with the store system, especially:

- the register seems stuck or inconsistent
- shifts look open when they should be closed
- a manager needs evidence before deciding what happened
- support needs a clean packet of diagnostic details
- you need a safe next step without guessing

## The short rule

> **BUPOS Help diagnoses first. It does not secretly fix or change store data.**

The Help page can run checks, show evidence, create manager review requests, and link to Audit. Repairs do **not** run from the Help trail.

## Quick reference

| You say / notice | What to do in BUPOS | What happens |
|---|---|---|
| “Something is wrong with the register.” | Open **Admin → Help** and run the store health check. | BUPOS runs read-only diagnostics and shows plain-English status. |
| “There may be duplicate open shifts.” | Review the **Shift evidence** cards. | BUPOS shows shift id, employee id, location id, register session, reason, and age. |
| “A manager needs to review this.” | Click **Create manager review request** on the evidence card. | BUPOS writes an audited pending manager review request. No repair runs. |
| “I need to see what happened later.” | Use **Manager review trail** or **View in Audit**. | BUPOS shows open requests, reviewed outcomes, receipts, and correlation details. |
| “The Help trail will not load.” | Use the visible **Audit** link for the full event history. | Audit remains the full history source if the compact Help trail has a loading issue. |
| “Support asked for diagnostics.” | Download the support packet from Help. | BUPOS creates a sanitized JSON packet for support review. |
| “Stop / don’t change anything.” | Do not approve any manager action. | No repair is executed from the Help trail. |

## What the Help page can do today

### 1. Run read-only store health checks

The Help page checks store-system health without changing business data.

Current examples include:

- database connectivity
- open-shift conflicts
- stale open shifts
- support-packet readiness

Each check returns:

- status
- short summary
- recommended next step
- request/correlation details where relevant

### 2. Show shift evidence cards

When BUPOS finds stale or duplicate open shifts, it can show evidence cards.

These cards may include:

- shift id
- employee id
- location id
- register session id
- age in hours
- reason, such as `duplicate_open_shift` or `stale_open_shift`

Use the card to decide whether a manager should review the situation.

### 3. Create manager review requests

For Help actions that need manager attention, BUPOS can create a pending manager review request.

That request is written to Audit as a Help approval-request event.

Important:

- this is a review request, not a repair
- it is audit-visible
- it includes a receipt fingerprint
- it can include sanitized shift evidence

### 4. Show the Manager review trail

The Help page shows a compact read-only trail:

- **Open requests** — pending manager review items
- **Reviewed outcomes** — acknowledged, denied, or manual-review-required decisions

The trail uses status badges:

| Status | Meaning |
|---|---|
| `Pending review` | A manager still needs to look at this. |
| `Acknowledged` | A manager reviewed and acknowledged it. |
| `Denied` | A manager rejected the request. |
| `Manual review required` | A manager marked it for hands-on follow-up. |

### 5. Link to Audit for the full history

Audit is the long-term source of truth.

Use Audit when:

- the Help trail fails to load
- you need the full payload/history
- you need to review manager decisions
- you need to connect a request to a receipt or review outcome

## What BUPOS Help will NOT do by itself

BUPOS Help will **not** automatically:

- close shifts
- reopen shifts
- change inventory counts
- retry payment captures
- issue or retry refunds
- change customer records
- delete or merge customer data
- push inventory to Shopify
- run database migrations
- change credentials or environment settings
- send customer emails or messages
- perform bulk cleanup

If any of those are ever added later, they must be separate, manager-gated, role-checked, and audited workflows.

## Approval rules

### Store staff

Store staff can use Help to understand what is wrong and gather evidence.

They should not guess or manually force risky corrections without manager review.

### Managers

Managers can review Help requests and mark them as:

- acknowledged
- denied
- manual review required

Current manager review decisions are audit records. They still do not execute repairs.

### Technical support

Technical support can use the sanitized support packet and Audit trail to investigate without needing secrets or raw local machine details.

## What to tell support

When escalating, provide:

- Help request time
- store/location affected
- visible check status
- approval request ID if shown
- receipt fingerprint prefix
- whether the issue affects selling right now
- whether staff already tried refreshing or re-running checks

Do **not** paste passwords, API keys, tokens, private credentials, or raw environment values.

## If the Help trail is empty

If **Open requests** says:

> No requests are waiting for manager review.

That means no Help action is currently waiting for manager approval.

If **Reviewed outcomes** says:

> No reviewed Help outcomes yet.

That means no manager has reviewed a Help request recently.

Both can be normal.

## If the Help trail shows an error

If Help says it could not load manager requests or review outcomes:

1. click the Audit link for the full event history
2. refresh the Help trail once
3. if it still fails, escalate to support with the time and page shown

A loading error does **not** mean BUPOS made a repair.

## Plain-English examples

| Store situation | Safe wording |
|---|---|
| Register state looks wrong | “Run the Help check and show me what it says.” |
| Employee has multiple open shifts | “Create a manager review request for this shift evidence.” |
| Manager wants history | “Open Audit and filter to Help approval requests.” |
| Support needs details | “Download the sanitized support packet.” |
| Unsure whether to fix something manually | “Stop. Mark this manual review required and call support.” |

## Golden rule

> **If the next step would change money, inventory, customers, shifts, credentials, or production settings, stop and require manager/owner approval first.**

BUPOS Help is a safety rail, not an autopilot.
