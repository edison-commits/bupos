# Customer Display Integration Guide

## Quick Setup

The customer display is ready to use immediately. No additional configuration needed.

## Display URL

**Customer-facing display screen:**
```
http://localhost:3000/register/customer-display
```

This page should be opened in a browser on the customer-facing monitor/display device.

## How It Works

### Current Architecture (BroadcastChannel)

The display listens for real-time updates via **BroadcastChannel** from the POS terminal window in the same browser.

**To enable this, update the POS terminal code** (`/src/app/register/page.tsx` or wherever cart is managed):

```typescript
import { useEffect } from 'react';

export function RegisterPage() {
  const channel = useRef(new BroadcastChannel('basicuniformpos_customer_display'));

  // Whenever cart updates:
  useEffect(() => {
    channel.current.postMessage({
      type: 'cart_update',
      cart: currentCart,
      appliedPromo: appliedPromo,
      exchangeCredit: exchangeCredit
    });
  }, [currentCart, appliedPromo, exchangeCredit]);

  // When transaction completes:
  const onTransactionComplete = () => {
    channel.current.postMessage({ type: 'cart_clear' });
  };

  return (
    // ... your register UI
  );
}
```

### Alternative: API Polling (if BroadcastChannel doesn't work)

If the two windows are on different domains or devices, update the client to poll the API instead:

**File:** `/src/app/register/customer-display/customer-display-client.tsx`

Replace the BroadcastChannel section with:

```typescript
useEffect(() => {
  // Get register session ID (from URL params or store)
  const sessionId = 'your-register-session-id';
  
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/customer-display?registerSessionId=${sessionId}`);
      const state = await response.json();
      
      if (state.cart) {
        setCart(state.cart);
        setTotals(state.totals);
        setCustomerName(state.cart.customerName);
      }
    } catch (error) {
      console.error('Failed to fetch display state:', error);
    }
  }, 1500); // Poll every 1.5 seconds

  return () => clearInterval(pollInterval);
}, []);
```

Then update the POS terminal to POST updates:

```typescript
const onCartUpdate = async (cart, totals) => {
  await fetch('/api/customer-display', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      registerSessionId: sessionId,
      cart,
      totals,
      paymentStatus: 'pending'
    })
  });
};
```

## Screen Behavior

### Idle Screen (No Items)
- Shows store branding with diamond accent
- Displays store location name
- Shows "Welcome" message
- Pulsing indicator dots
- Appears when cart is empty

### Active Screen (Items in Cart)
- Teal header with store name and customer name
- Scrollable list of line items with:
  - Product name and variant
  - SKU reference
  - Quantity × Unit Price = Line Total
  - Modifier costs (if applicable)
  - Line-item discounts (if applied)
- Running totals:
  - Subtotal
  - Discounts (shown in orange)
  - Modifiers (if any)
  - Tax (calculated from cart.taxRate)
  - **Grand Total (large, teal, prominent)**
- Applied promo code display
- Exchange credit display

### Receipt Screen (Transaction Complete)
- Large checkmark animation
- "Thank You!" message
- "Transaction Complete" subtitle
- Final amount
- "Please take your receipt" instruction
- Auto-disappears after 5 seconds (resets to idle)

## Visual Design

### Colors
- **Background**: Dark navy (#0f172a - slate-950)
- **Accents**: Teal (#14b8a6)
- **Text**: White and grays for contrast
- **Highlights**: Orange for discounts, teal for totals

### Font Sizes
All text is sized for viewing 3-4 feet away:
- Headers: 6xl (60px)
- Subtitles: 3xl (30px)
- Main text: 2xl (24px)
- Supporting: lg (18px)

### Layout
- Full-screen dark display
- High contrast for readability
- Plenty of whitespace
- No clutter or distractions

## Testing Checklist

- [ ] Display page loads at `/register/customer-display`
- [ ] Idle screen shows when no items in cart
- [ ] Active screen shows when items added to POS terminal
- [ ] Line items display product name, sku, qty, price
- [ ] Totals calculate and display correctly
- [ ] Grand total is highlighted in teal and large
- [ ] Discount amounts show in orange
- [ ] Applied promo code displays
- [ ] Receipt screen shows on transaction complete
- [ ] Receipt screen auto-clears after 5 seconds
- [ ] Text is readable from 3-4 feet away
- [ ] No console errors

## Hardware Setup

### Recommended Configuration

1. **Main Register Display**
   - Your primary POS terminal screen
   - Browser at `/register`
   - Where cashier works

2. **Customer Display Monitor**
   - 24-32" display mounted facing customer
   - Browser at `/register/customer-display`
   - Same device or networked device

### Monitor Recommendations
- 24-32" display minimum for distance viewing
- Good brightness (300+ nits)
- Good viewing angles (IPS panel)
- HDMI/USB connection to register or network-connected device

## Performance Notes

- BroadcastChannel: Instant updates, same browser/device
- API polling: ~1.5s latency per poll, suitable for network displays
- No external dependencies beyond Next.js
- Minimal CPU/GPU usage (CSS animations only)
- Works offline if using BroadcastChannel

## Troubleshooting

### Display stays blank or shows errors
1. Check that `/register/customer-display` URL loads in browser
2. Check browser console for errors
3. Verify `formatCurrency` import exists in `/lib/formatting.ts`
4. Run `npm run build` to check for type errors

### Updates not showing on display
1. If using BroadcastChannel:
   - Verify POS terminal is posting messages to channel
   - Check browser console for message logs
   - Ensure both windows are same domain
   
2. If using API polling:
   - Check network tab for fetch requests to `/api/customer-display`
   - Verify registerSessionId is correct
   - Check API response in network inspector

### Text too small or hard to read
1. Increase monitor font scaling in browser dev tools
2. Move monitor closer to customer position
3. Check monitor brightness and contrast settings
4. Verify room lighting is adequate

## Next Steps

1. **Integrate with POS Terminal**
   - Find where cart state changes occur
   - Add BroadcastChannel.postMessage() calls
   - Test with real data

2. **Customize Branding**
   - Update store name display
   - Adjust colors to match brand guidelines
   - Add custom logo (update IdleScreen component)

3. **Add Payment Information**
   - Update PaymentScreen component skeleton
   - Add tender amount and change due displays
   - Show payment method

4. **Production Deployment**
   - Test on actual customer display hardware
   - Set up monitor on customer-facing side
   - Configure auto-open on register startup
   - Set monitor to full-screen browser mode

## Support

For issues or feature requests related to the customer display, refer to:
- Implementation details: `CUSTOMER_DISPLAY_IMPLEMENTATION.md`
- Component code: `/src/components/register/customer-display.tsx`
- API routes: `/src/app/api/customer-display/route.ts`
- Display client: `/src/app/register/customer-display/customer-display-client.tsx`
