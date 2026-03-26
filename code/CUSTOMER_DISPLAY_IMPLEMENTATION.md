# Customer-Facing Display Implementation

## Overview

A customer-facing display system for BasicUniformPOS that shows cart updates in real-time on a second screen during checkout. The display features a dark theme with teal accents, large readable text (text-2xl to text-6xl), and auto-rotates between idle/welcome and active cart views.

## Files Created

### 1. Component: `/src/components/register/customer-display.tsx`

The main React component that renders the customer display with four screens:

#### Screen States

1. **Idle Screen** - Shows store branding and welcome message when no items in cart
   - Large diamond accent (◆)
   - Store name display
   - "Welcome" and "Ready to checkout" messages
   - Pulsing indicator dots

2. **Active Cart Screen** - Shows current order details
   - Header with store name and customer name (if available)
   - Scrollable list of line items with:
     - Product name and variant
     - SKU
     - Unit price × quantity = line total
     - Modifier costs (if any)
     - Line discounts (if any)
   - Running totals section:
     - Subtotal
     - Discount amount
     - Modifier charges
     - Tax
     - **Grand total (prominently displayed)**
   - Optional promo code and exchange credit display

3. **Receipt Screen** - Transaction complete thank you message
   - Large checkmark (✓)
   - "Thank You!" and "Transaction Complete"
   - Grand total display
   - "Please take your receipt" message

4. **Payment Screen** (Placeholder for future)
   - Can show amount due, amount tendered, change due

#### Key Features

- **Large Typography**: Text sized from 2xl to 6xl for viewing from 3-4 feet away
- **Dark Theme**: Slate-950 background with white/gray text
- **Teal Accents**: #14b8a6 color for key totals and interactive elements
- **Auto-rotation**: Automatically switches between idle and active modes based on cart item count
- **Responsive Layout**: Flexbox-based layout for easy text scaling

### 2. API Route: `/src/app/api/customer-display/route.ts`

RESTful API endpoints for managing customer display state across the POS system.

#### Endpoints

**POST /api/customer-display**
- Updates the display state from the POS terminal
- Called whenever cart changes, payment status changes, etc.
- Body:
  ```json
  {
    "registerSessionId": "session-uuid",
    "cart": { ...Cart object },
    "totals": { ...CartTotals object },
    "paymentStatus": "pending|processing|complete",
    "amountTendered": 0.00,
    "changeDue": 0.00
  }
  ```

**GET /api/customer-display**
- Fetches current display state for a register session
- Query params:
  - `registerSessionId` (required) - Session to fetch
  - `timeout` (optional, ms) - How long to wait for updates
- Returns:
  ```json
  {
    "cart": { ...Cart object },
    "totals": { ...CartTotals object },
    "paymentStatus": "pending|processing|complete",
    "amountTendered": 0.00,
    "changeDue": 0.00
  }
  ```

**DELETE /api/customer-display**
- Clears display state when transaction completes
- Query params:
  - `registerSessionId` (required) - Session to clear

#### Storage

- Uses in-memory `Map<registerSessionId, displayState>`
- Non-persistent (resets on server restart)
- In production, could be upgraded to Redis, database, or state management system

### 3. Formatting Utility: `/src/lib/formatting.ts`

Helper functions for consistent formatting across the display:

```typescript
formatCurrency(amount: number): string
  // Returns: "$123.45"

formatPercent(percent: number): string
  // Returns: "15.5%"

formatDate(date: string | Date, includeTime?: boolean): string
  // Returns: "Mar 25, 2026" or "Mar 25, 2026 3:41 PM"
```

### 4. Server Page: `/src/app/register/customer-display/page.tsx`

Already existing. Loads store/location info and passes to client component.

### 5. Client Component: `/src/app/register/customer-display/customer-display-client.tsx`

Already existing. Listens for BroadcastChannel messages from the POS terminal with key event types:
- `cart_update` - Line items, totals, promo, exchange credit
- `cart_clear` - Reset display for new transaction

## Integration Points

### From POS Terminal

The main POS register should:

1. **Create BroadcastChannel** connection:
   ```typescript
   const channel = new BroadcastChannel("basicuniformpos_customer_display");
   ```

2. **Send cart updates** whenever items are added/removed or totals change:
   ```typescript
   channel.postMessage({
     type: "cart_update",
     cart: currentCart,
     appliedPromo: promoCode,
     exchangeCredit: creditAmount
   });
   ```

3. **Send clear message** when transaction completes:
   ```typescript
   channel.postMessage({ type: "cart_clear" });
   ```

### Alternative: API-based polling

If BroadcastChannel doesn't work across windows, the client component can be updated to poll the API:

```typescript
// In customer-display-client.tsx useEffect:
const interval = setInterval(async () => {
  const response = await fetch(`/api/customer-display?registerSessionId=${sessionId}`);
  const state = await response.json();
  // Update cart and totals
}, 1500); // Poll every 1.5 seconds
```

## Styling Details

### Color Scheme
- **Background**: `bg-slate-950` (dark navy)
- **Primary Text**: `text-white`
- **Secondary Text**: `text-gray-400`
- **Accents**: `text-teal-400` or `text-teal-500` or `text-teal-600`
- **Headers**: `bg-gradient-to-r from-teal-600 to-teal-700`
- **Line Items**: `bg-slate-800` with `border-slate-700`

### Typography Hierarchy
- Title/Header: `text-6xl font-bold`
- Section Headers: `text-3xl font-bold`
- Main Text: `text-2xl font-semibold`
- Totals: `text-3xl font-bold text-teal-400`
- Supporting Text: `text-lg text-gray-400`

### Spacing
- Full-screen layout with flexbox
- Header: `px-8 py-6`
- Content: `px-8 py-6`
- Cards: `p-6` with `rounded-lg`

## Future Enhancements

1. **Payment Details Display** - Show amount due, tendered, change
2. **Receipt Preview** - Show itemized receipt before printing
3. **Customer Information** - Display loyalty info, store credit
4. **Animations** - Slide transitions between screens, item additions
5. **QR Codes** - Display for digital receipts or post-transaction surveys
6. **Promotions** - Flash banner for applied discounts/coupons
7. **Multi-language Support** - Localize text for different regions
8. **Customization** - Admin settings for colors, messaging, branding

## Testing

To test the customer display:

1. Open two browser windows side-by-side
2. Main window: http://localhost:3000/register
3. Display window: http://localhost:3000/register/customer-display
4. Add items to cart in main window
5. Watch them appear on display window in real-time
6. Verify totals update correctly
7. Test clearing cart

## Accessibility Notes

- Large text meets WCAG AA contrast requirements
- Background/foreground color combinations ensure readability from distance
- No reliance on color alone for information (price/qty text, not just green/red)
- Animated elements (pulse, bounce) can be disabled via prefers-reduced-motion
