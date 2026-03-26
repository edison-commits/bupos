# End-of-Day Shift Close and Z-Report Feature

## Files Created

### 1. API Route: `/src/app/api/shift-close/route.ts` (276 lines)

**Endpoints:**

#### GET /api/shift-close
Fetches current open shift and generates Z-report calculations.

**Query Parameters:**
- `shift` (optional) - Specific shift ID. If not provided, fetches the most recent open shift at the location.

**Response:**
```json
{
  "shift": {
    "id": "shift-id",
    "employeeName": "Employee Name",
    "openedAt": "2026-03-24T10:00:00.000Z",
    "openingFloat": 100.00,
    "status": "open"
  },
  "report": {
    "salesCount": 25,
    "salesAmount": 1250.50,
    "tenderBreakdown": [
      { "type": "cash", "count": 10, "amount": 500.00 },
      { "type": "card", "count": 15, "amount": 750.50 }
    ],
    "refundsCount": 2,
    "refundsAmount": 75.00,
    "netSales": 1175.50,
    "payIns": 50.00,
    "payOuts": 25.00,
    "expectedCash": 625.00
  }
}
```

#### POST /api/shift-close
Closes a shift with the declared cash count.

**Request Body:**
```json
{
  "shiftId": "shift-id",
  "declaredCash": 625.50,
  "notes": "Optional closing notes"
}
```

**Response:**
```json
{
  "success": true,
  "shift": {
    "id": "shift-id",
    "closedAt": "2026-03-24T18:00:00.000Z",
    "expectedCash": 625.00,
    "declaredCash": 625.50,
    "variance": 0.50
  },
  "report": { ... }
}
```

**Features:**
- Uses `orgQuery()` for RLS-scoped queries
- Uses `orgTx()` for transactional updates
- Calculates expected cash: opening float + cash sales - refunded amounts + pay ins - pay outs
- Handles tender breakdown by type (cash, card, etc.)
- Returns full Z-report with metrics

---

### 2. Client Component: `/src/app/admin/shift-close/page.tsx` (461 lines)

**Features:**

#### Layout & UX
- Clean header with back button
- Responsive grid layout (mobile, tablet, desktop)
- Gradient backgrounds using teal/emerald accent colors
- Skeleton loaders for initial data fetch

#### Shift Information Section
- Employee name and shift start time
- Opening float amount
- Shift duration in minutes

#### Z-Report Summary
- **Sales Metrics:**
  - Total sales count and amount
  - Breakdown by payment method (Cash, Credit/Debit, etc.)
  - Transaction count per tender type
  - Visual indicators with colored badges

- **Returns & Refunds:**
  - Return count and amount
  - Net sales calculation

- **Adjustments:**
  - Pay ins (green highlighted)
  - Pay outs (red highlighted)

- **Expected Cash Display:**
  - Prominent blue card showing calculated expected cash
  - Formula explanation

#### Cash Count Input
- Currency input field with $ symbol
- Real-time variance calculation
- Visual feedback:
  - Green when perfectly matched
  - Amber when over
  - Red when short
- Variance amount and description

#### Optional Closing Notes
- Textarea for documenting discrepancies or notes

#### Actions
- **Cancel Button:** Returns to previous page
- **Close Shift Button:** 
  - Disabled until cash count entered
  - Shows loading state during submission
  - Transitions to success screen
- **Print Button:** Prints Z-report for records

#### States
- Loading skeleton during data fetch
- Error banner with retry option
- Success screen with redirect to dashboard
- Disabled states for buttons during operations

#### Styling
- Tailwind CSS with emerald/teal theme
- Metric boxes with color variants (teal, amber, emerald)
- Responsive grid layouts
- Hover states and transitions
- Print-friendly styles

---

## Database Queries Used

The implementation uses the following database patterns:

### RLS-Scoped Queries (orgQuery)
```sql
-- Fetch open shifts
SELECT s.* FROM shifts s
WHERE s.location_id = $1 AND s.status = 'open'
ORDER BY s.opened_at DESC LIMIT 1

-- Fetch transactions by shift
SELECT t.id, t.status, t.grand_total, t.created_at
FROM transactions t
WHERE t.shift_id = $1 AND t.created_at >= $2 AND t.created_at <= $3

-- Tender breakdown
SELECT tender_type, SUM(amount)::numeric AS amount, COUNT(*)::int AS count
FROM transaction_tenders
WHERE transaction_id = ANY($1)
GROUP BY tender_type
ORDER BY amount DESC

-- Pay ins/outs
SELECT direction, SUM(amount)::numeric AS total
FROM pay_in_outs
WHERE shift_id = $1
GROUP BY direction
```

### Transactional Updates (orgTx)
```sql
-- Close shift with variance
UPDATE shifts SET
  status = 'closed',
  closed_at = $1,
  closing_declared_cash = $2,
  closing_expected_cash = $3,
  closing_variance = $4,
  closed_note = $5
WHERE id = $6
```

---

## Configuration

**Organization ID:** `33262270-7100-4b46-b2fb-8b50ad872bbb`
**Location ID:** `c57268b3-cb14-4c1a-bda6-55e49ddc6313`

---

## Integration Notes

1. **No changes to app-nav.tsx** - Navigation integration is handled separately
2. **Uses existing DB patterns** - Follows orgQuery/orgTx conventions from codebase
3. **Parallel queries** - Uses `Promise.all` implicitly through sequential API calls
4. **Error handling** - Comprehensive try-catch blocks and user-friendly error messages
5. **Loading states** - Skeleton loaders prevent content shift
6. **Print support** - CSS media queries support printing Z-reports

---

## Usage

Navigate to `/admin/shift-close` to open the shift closing interface.

The component:
1. Fetches the current open shift and Z-report data
2. Displays comprehensive sales summary with tender breakdown
3. Allows entering the physical cash count
4. Calculates variance (over/short)
5. Closes the shift and stores variance data
6. Redirects to dashboard on success
