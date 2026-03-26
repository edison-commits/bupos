# BasicUniformPOS Progress Log

Last updated: 2026-03-24 — America/Los_Angeles
Status: Production on Cloudflare Workers — all Phase 1–3 features live
Owner: Edison
Coder: Forge

## Current phase
Phase 1–3 features are **complete and deployed** to Cloudflare Workers at `https://basicuniformpos.basicuniformpos.workers.dev`. All data flows through Supabase Postgres via `@neondatabase/serverless` WebSocket pooler. The app is fully operational with Casualwear org seeded.

## Latest completed milestones

### 1. Planning / product direction complete
Completed:
- scoped BasicUniformPOS to a **web-first** product
- created master spec, additions doc, trimmed Phase 1 roadmap, engineering plan, schema revision brief, milestone tickets, and kickoff packet
- locked first deployment target to **Casualwear**
- captured key V1 business rules (split tender required, approval thresholds, receipt/no-receipt behavior, manager approval rules)

### 2. Milestone 0–1 foundation complete
Project path:
- `/Users/edison/.openclaw/workspace/basicuniformpos`

Built:
- Next.js web-first scaffold
- admin and register shells
- typed domain models
- config/thresholds from real store rules
- schema direction docs
- seed/mock data shaped for Casualwear
- README and architecture docs

### 3. Persistence / auth / admin CRUD foundation complete
Built:
- local file-backed persistence runtime for dev
- admin email/password auth with server-side sessions
- register PIN login with hashed PIN verification
- admin CRUD starter flows for categories, products, inventory adjustments, employees
- accountability events for PIN login and other actions

### 4. Authz + shift/session foundation complete
Built:
- stronger server-side permission enforcement by role
- manager vs owner restrictions
- persisted register sessions
- shift open/close foundation
- opening float / declared cash / variance handling
- audit events for register session and shift lifecycle
- reserved register-session fields for later cart/transaction/exception work

### 5. Cart + checkout + tender flow complete
Built:
- immutable/pure cart functions (createCart, addItem, removeItem, updateQuantity, setDiscount, computeTotals, voidCart, checkOutCart)
- product grid with category filtering and touch-optimized layout
- cart sidebar with quantity adjustment, line-item removal, discount entry
- multi-tender checkout with single and split modes (cash, card, store credit, loyalty)
- quick cash buttons with smart rounding
- change calculation from cash portion only
- normalized tender lines (one record per payment method)
- receipt view with full tender breakdown, customer name, loyalty points
- no-receipt option
- transaction lifecycle event logging (item_added, item_removed, quantity_changed, discount_applied, cart_voided, payment_started, cart_held, cart_recalled)

### 6. Shift close-out + pay-in/out complete
Built:
- three-step shift close flow (summary → drawer count → confirm)
- denomination-based drawer counting with +/- buttons and manual total mode
- expected vs actual variance with color-coded thresholds
- blind close option (skip drawer count, record expected as declared)
- large variance warning before confirming
- closing note field
- pay-in/pay-out modal with reason codes (change_replenishment, float_adjustment, bank_deposit, vendor_payment, expense_reimbursement, petty_cash, other)
- expected cash formula: opening float + cash tenders - change given + pay-ins - pay-outs

### 7. Customer module complete
Built:
- customer search modal with name/email/phone search
- attach/clear customer on cart
- customer name displayed on receipt
- 5 seed customers with loyalty points, total spend, visit counts
- purchase history display (collapsible per-customer, pulled from transaction events with customer_id payload)

### 8. Returns complete
Built:
- three-step return flow (search transactions → enter refund details → confirm)
- refund method selection (cash, card, store credit)
- negative tender records for returns
- inventory restoration on return
- original transaction marked with has_return, return_transaction_id, returned_at metadata
- return threshold enforcement: cashiers blocked from returns > $40 (requires manager)

### 9. Loyalty earn/redeem system complete
Built:
- LoyaltyConfig interface (earnRatePerDollar, redemptionValuePerPoint, minimumRedemption)
- loyalty as a TenderType — usable in single and split tender flows
- earn: 1 point per $1 spent (only when customer attached)
- redeem: $0.01 per point, minimum 100 points to redeem
- tender panel shows available points, max redeem button, dollar input
- checkout action updates customer record (loyaltyPoints, totalSpend, visitCount)
- receipt shows points earned/redeemed
- customer_id, loyalty_earned, loyalty_redeemed recorded in transaction event payloads

### 10. Approval enforcement hardened
Built:
- server-side validation in checkoutAction: blocks checkout if discount exceeds threshold without approved exception
- server-side validation: blocks store credit tender exceeding threshold without approval
- client passes approvedExceptions list to server action
- return threshold enforcement: cashier-level returns above $40 throw server error
- approval modal with manager PIN, reason codes, numeric pad

### 11. Admin reports complete
Built:
- **Sales summary**: transaction count, total sales, returns, avg ticket, net sales, tender breakdown by type
- **Shift history**: closed shifts with employee name, date range, float, variance (color-coded), blind close indicator
- **Employee activity**: per-employee sales count, total sales, return count
- **Customer activity**: top customers sorted by spend, with visit count and loyalty points
- **Cashier exception report**: approval exceptions (pending/resolved), void events by cashier, large discount transactions above threshold
- **Discrepancy correlation view**: correlates shift cash variance with cashier name, void count, return count, blind close flag — sorted by largest variance
- **Inventory summary**: total on-hand, reserved, retail value, cost value, low stock count, out of stock count, adjustment count, net adjustment, per-variant stock bar chart
- **Audit trail**: event counts, recent events list
- **Low stock alerts**: items at or below reorder point with color-coded severity

### 12. Phase 2 schema & persistence foundation
Built:
- **007_phase2_migration.sql**: full PostgreSQL migration with tables for customers, pay_in_outs, employee_behavior_flags, gift_cards, gift_card_transactions, store_credit_ledger, layaways, layaway_payments, stocktakes, stocktake_lines, transfers, transfer_lines, plus schema patches and performance indexes
- Phase 2 domain types: GiftCard, GiftCardTransaction, StoreCreditEntry, EmployeeBehaviorFlag, Layaway, LayawayPayment, Stocktake, StocktakeLine, Transfer, TransferLine
- LocalStoreData extended with all Phase 2 entities + seed data defaults
- `postgres-phase2.ts`: full CRUD Postgres query functions for customers, gift cards, store credit, behavior flags, layaways, stocktakes, transfers, pay-in/outs
- `storeCreditBalance` added to Customer type

### 13. Suspicious employee behavior dashboard complete (Block 3)
Built:
- **Flag engine** (`lib/behavior/flag-engine.ts`): 6 rule types run against JSON store data
  - high void/cancel rate vs store average
  - repeated post-total cancellations
  - frequent manual price overrides
  - elevated shift cash discrepancies
  - unusual manual drawer opens
  - excessive gift card / store credit activity
- Flags are advisory with severity levels (low/medium/high)
- Deduplication by employee + flagType
- **Dashboard component** (`behavior-dashboard.tsx`): filterable by severity, employee, review status
- "Run behavior scan" button triggers analysis on demand
- Manager review workflow with notes
- Summary cards: total flags, unreviewed count, high severity count, flagged employee count

### 14. Gift card & store credit controls complete (Block 4)
Built:
- **Gift card manager** (`gift-card-manager.tsx`):
  - Activate new cards with code, amount, optional customer
  - Reload existing cards
  - Disable cards
  - Transaction history per card (activation, reload, redemption)
  - Outstanding liability tracking
  - Status badges (active, depleted, disabled, expired)
- **Store credit manager** (`store-credit-manager.tsx`):
  - Issue store credit to customers with reason tracking
  - Customer balance display with expandable ledger
  - Issuance report by employee (who issued how much)
  - Outstanding balance, total issued, total redeemed metrics
- Server actions for all operations with auth enforcement

### 15. Layaway workflow complete (Block 5)
Built:
- **Layaway manager** (`layaway-manager.tsx`):
  - View all layaways with status filters
  - Make partial payments (cash, card, store credit)
  - Status progression: active → partially_paid → paid_in_full → collected
  - Mark collected when fully paid
  - Cancel with reason (manager only)
  - Payment history per layaway
  - Summary: total layaways, active count, balance outstanding, payments recorded

### 16. Stocktake workflow complete (Block 6)
Built:
- **Stocktake manager** (`stocktake-manager.tsx`):
  - Create full or cycle (category-filtered) counts
  - Auto-generates count lines from current inventory at selected location
  - Inline count entry per variant with save button
  - Expected vs counted vs variance display
  - Accept stocktake → automatically generates inventory adjustments
  - Cancel stocktake
  - Summary: total stocktakes, in-progress count, accepted count

### 17. Inter-store transfer workflow complete (Block 7)
Built:
- **Transfer manager** (`transfer-manager.tsx`):
  - Create transfer with source/destination locations and item selection
  - Add multiple line items (product variant + quantity)
  - Status progression: requested → in_transit → received
  - Ship: deducts inventory from source location
  - Receive: adds inventory to destination location (creates inventory record if needed)
  - Cancel (requested status only)
  - Line-level tracking: requested, shipped, received quantities
  - Summary: total transfers, pending count, completed count

### 18. Phase 2 register-side integration complete
Built:
- **Gift card as tender type**: lookup by code, redeem with amount input, max button, balance display; deducts from card on checkout (both JSON + PG); depleted cards auto-set to "depleted" status
- **Store credit at checkout**: balance display in tender panel, enforcement on confirm, deducts from customer balance with ledger entry on checkout
- **Layaway creation from register**: "Layaway" button in POS action bar, deposit modal with 10% minimum, quick buttons (min/25%/50%), due date, notes; reserves inventory, records initial deposit payment, confirmation overlay with ID + balance
- **Behavior flag engine on shift close**: all 6 rules auto-run when a shift is closed, new flags persisted and visible in admin dashboard
- **Receipt tender labels**: proper display names for Gift Card, Store Credit, Loyalty Points
- **AuditEventKind expansion**: added register event kinds (layaway_created, item_added, item_removed, etc.)
- **Return modal**: excluded gift_card from refund methods

### 19. Price override with manager approval complete
Built:
- `overridePrice` optional field on CartLineItem
- `setPriceOverride()` pure cart function
- `computeTotals()` uses effective price (override ?? original)
- **PriceOverrideModal** component: shows original price, new price input, markdown/markup calculation with percentage, reset-to-original button
- Cart sidebar shows overridden prices with strikethrough original + amber highlight
- "Price" button on each line item opens override modal
- Manager approval flow triggered when override exceeds `manualPriceOverrideOver` threshold

### 20. End-of-day Z-Report complete
Built:
- **ZReport** component in admin: comprehensive daily closing report
- Sales overview: transaction count, gross sales, returns, net sales, avg ticket, voids
- Tender breakdown by type with counts and totals
- Cash accountability: shifts, floats, cash tendered, pay-ins/outs, net variance
- Employee performance: sales count and total per cashier sorted by revenue
- Gift card & store credit activity: activations, redemptions, issuances
- Exceptions & alerts: manager approval count, behavior flags generated
- Print button for physical Z-report output

### 21. Barcode/SKU scanner support complete
Built:
- `scanLookup` map: flat SKU/barcode → variant+product lookup for O(1) matching
- **Auto-add on exact match**: when search input exactly matches a SKU or barcode, item is auto-added to cart and search cleared
- **Enter key support**: manual SKU entry with Enter auto-adds matching item
- **Scan feedback**: green toast shows "Added: Product — Variant" for 2 seconds
- Out-of-stock detection on scan with feedback message
- Search input auto-focuses after scan for continuous scanning workflow

### 22. Discount enhancements complete
Built:
- **DiscountMode type**: `"fixed" | "percent"` for cart-level and line-level discounts
- **LineDiscount interface**: mode, value, optional reason — applied per line item
- **Cart-level discount toggle**: $ fixed or % percentage mode with UI toggle in cart sidebar
- **Percentage discount computation**: applies to (subtotal + mods - line discounts) before cart discount
- **Line discount modal** (`line-discount-modal.tsx`): mode toggle, value input, quick % buttons (5/10/15/20/25/50), reason field, live preview of discount amount and after-discount total
- **Per-line "Disc" button** in cart sidebar with active state indicator
- `setDiscountMode()` and `setLineDiscount()` pure cart functions
- `computeTotals()` updated: line discounts applied first, then cart discount (fixed or %)
- Manager approval threshold enforcement for line discounts exceeding `discountOver`
- Checkout action updated to compute effective cart discount for threshold check in percentage mode

### 23. Exchange flow complete
Built:
- **ExchangeModal** (`exchange-modal.tsx`): two-step flow — search original transaction → enter return value
- Exchange processes the return as store credit internally, then applies the return credit as a fixed cart discount
- **Exchange credit banner** in POS: shows active exchange mode with credit amount and original transaction reference
- Exchange button in action bar alongside Return
- Clear exchange credit option to cancel exchange mode
- Exchange credit automatically cleared on new sale

### 24. Admin dashboard KPIs complete
Built:
- **DashboardKPIs** component (`dashboard-kpis.tsx`): real-time KPI cards for today's performance
- **Sales KPIs**: gross sales, net sales, transaction count, average ticket, % change vs yesterday
- **Operational KPIs**: returns today, open/closed shifts, cash variance, behavior flags (unreviewed + new today)
- **Inventory & liability**: low stock count, out-of-stock count, active layaways with outstanding balance, gift card liability, customer count
- Color-coded warning states for elevated values
- Delta indicator (% change vs yesterday) for gross sales
- Inserted as top section in admin console after session card

### 25. Employee time clock complete
Built:
- **TimeClockEntry domain model**: clock_in, clock_out, break_start, break_end event types
- **TimesheetSummary type**: computed worked time, break time, status per employee per day
- **clockAction server action**: persists time clock events to JSON store
- **getTimesheetSummaries**: builds daily summaries with break pairs and worked time computation
- **TimeClockWidget** (`time-clock-widget.tsx`): register-side widget showing current status (not clocked in / clocked in / on break / clocked out), clock in/out buttons, break start/end buttons, time summary with worked/break durations
- **TimesheetView** (`timesheet-view.tsx`): admin-side table with employee name, role, status badge, clock in/out times, break count + duration, total hours worked
- Widget renders in register console session bar area; timesheet renders in admin console

### 26. Promo/coupon code engine complete
Built:
- **PromoCode domain model**: fixed/percent/BOGO types, start/expiry dates, min purchase, max/current redemptions, status lifecycle
- **PromoRedemption tracking model**: links promo to transaction with discount amount
- **3 seed promo codes**: WELCOME10 (10% off $20+), SAVE5 ($5 off $30+), BOGOTEE (BOGO tees)
- **PromoCodeModal** (`promo-code-modal.tsx`): code input (uppercase, monospace), real-time validation against all rules (status, dates, redemption cap, minimum purchase), discount preview with amount and type, error states
- Promo button in POS action bar (purple theme), shows active promo code name
- Applied promo sets cart-level fixed discount and broadcasts to customer display
- Promo cleared on new sale

### 27. Customer-facing display complete
Built:
- **CustomerDisplay** component (`customer-display.tsx`): dark-themed full-screen display designed for secondary monitor, shows cart items with prices/discounts, totals, promo/exchange badges, welcome message when empty
- **BroadcastChannel sync**: POS terminal broadcasts cart state changes on `basicuniformpos_customer_display` channel; customer display page listens and updates in real-time
- **CustomerDisplayClient** (`customer-display-client.tsx`): wraps display component with BroadcastChannel listener
- **Dedicated route** at `/register/customer-display`: opens in separate window, reads store for org/location names
- Shows line discounts, price overrides, promo codes, exchange credits on the customer-facing screen

### 28. Supabase Postgres migration complete
Built:
- **36-table schema** deployed to Supabase project `jkdgdcfpgxjfdlccvqjf` (us-west-2)
- Core tables (21): organizations, locations, employees, categories, products, variants, inventory, customers, register_sessions, shifts, transactions, tenders, events, exceptions, audit_events, pay_in_outs, auth_credentials, sessions, modifiers, modifier_groups, product_modifier_groups, inventory_adjustments
- Phase 2 tables (12): gift_cards, gift_card_transactions, store_credit_ledger, behavior_flags, layaways, layaway_payments, stocktakes, stocktake_lines, transfers, transfer_lines
- Phase 3 tables (3): time_clock_entries, promo_codes, promo_redemptions
- **Connection pooler wired**: `db/index.ts` connects via Supabase Supavisor (transaction mode, port 6543) with SSL
- **Phase 3 PG code paths** (`postgres-phase3.ts`): time clock insert/read/timesheet summaries, promo code CRUD/redemption with atomic transactions
- **Time clock action** updated with `isPg()` dual-path (JSON fallback + Postgres)
- **Table name fix**: `behavior_flags` aligned between migration DDL and query code
- `tsc --noEmit` and `eslint` pass clean

### 29. Rename SwiftPOS → BasicUniformPOS complete
Changed:
- Package name, cookie names, BroadcastChannel name, JSON store filename, all internal references
- Verified with full type-check and lint after rename

### 30. Cloudflare Workers deployment complete
Built:
- **OpenNext adapter** (`@opennextjs/cloudflare`): builds Next.js App Router for Cloudflare Workers runtime
- **`@neondatabase/serverless`**: WebSocket-based Postgres driver for Workers (replaces node-postgres)
- **Connection pool max=3**: tuned for Workers memory constraints
- **`wrangler.toml`** configured with `USE_POSTGRES=true`, Supabase URL env vars
- **Service Worker** (`sw.js`): offline resilience with cache-first strategy for static assets
- Deployed at `https://basicuniformpos.basicuniformpos.workers.dev`
- Organization: Casualwear (33262270-7100-4b46-b2fb-8b50ad872bbb)

### 31. Hardening features batch complete
Built:
- **Product images on POS grid**: thumbnail images on product tiles and variant picker overlay
- **Admin catalog thumbnails**: product images displayed next to names in catalog list
- **Employee quick-switch PIN**: "Switch" button in register session bar, PIN pad modal, atomically updates session + shift employee
- **Scheduled email reports**: Supabase Edge Function `daily-report` sends daily sales summary via Resend API
- **Purchase order management**: admin PO workflow with supplier, line items, receive shipments, status tracking
- **Tax-exempt sales**: `taxExempt` flag on Customer, sets `cart.taxRate = 0` through checkout
- **Product bundles**: admin bundle manager, create bundles with variant+quantity pairs, savings display
- **Data export**: export transactions, inventory, customers as CSV from admin
- **ESC/POS receipt printer**: Web Serial API integration for thermal receipt printers at 9600 baud

### 32. Customer-facing display upgrade complete
Built:
- Rewritten **CustomerDisplay** with premium animated UI
- Last scanned item glow highlight animation
- Running total with text-5xl and smooth transitions
- Live clock updating every second
- Rotating welcome messages when cart is empty
- Gradient dark theme background

### 33. Dashboard analytics charts complete
Built:
- **DashboardCharts** component with 4 Recharts visualizations
- Sales trend area chart (daily totals)
- Hourly sales bar chart
- Tender mix pie chart with color coding
- Employee sales horizontal bar chart
- Data sourced from transaction events and tenders
- Responsive 2-column grid layout in admin Analytics section

### 34. End-of-day wizard complete
Built:
- **EODWizard** component: 4-step guided end-of-day flow
- Step 1: Review Summary (sales, tenders, cash position)
- Step 2: Count Drawer (denomination quick-add buttons, running total)
- Step 3: Close Notes (optional notes field)
- Step 4: Confirmation (variance display, color-coded)
- Progress bar with step indicators
- "Send daily report" button calling Supabase Edge Function
- Full-screen modal overlay from register session bar

### 35. Mobile/tablet touch optimization complete
Built:
- **`@media (pointer: coarse)`** CSS rules in `globals.css` for touch device detection
- `--touch-target: 4rem` custom property for minimum hit areas
- Product grid: responsive `grid-cols-2 md:grid-cols-3 xl:grid-cols-4`, 6rem min-height tiles
- Category tabs: `py-2 sm:px-6 sm:text-base` for larger tap targets
- Search input: `text-base` to prevent iOS zoom
- Cart sidebar: quantity buttons `h-10 w-10`, action buttons `px-3 py-2 text-sm`, discount toggles enlarged
- Void cart button: `px-4 py-2 text-sm`
- Discount input: `w-24 rounded-xl px-3 py-2`
- Checkboxes/radio buttons: 1.5rem on touch devices
- All interactive elements use `touch-button` class for consistent sizing

### 36. Barcode label printing complete
Built:
- **BarcodeLabelPrinter** component in admin catalog section
- Search products by name, SKU, or barcode
- Add to print queue with per-item quantity controls
- Label size options: small (1.8"), medium (2.4"), large (3")
- Toggle price and SKU display on labels
- **Code128B barcode generation**: pure SVG rendering with checksum computation
- Print preview showing up to 8 labels per item with barcode, product name, SKU, price
- Browser print dialog for output (compatible with label printers and standard printers)
- Uses variant barcode if available, falls back to SKU

### 37. Operational features batch complete
Built:
- **Multi-register support**: Register type, RegisterSelector component for selecting active register
- **Bulk product import**: CSV upload with drag-and-drop, column validation, 10-row preview, template download
- **Low stock auto-reorder**: Items below reorder point, draft PO generation with estimated order value
- **Customer email receipts**: Email receipt sending via Supabase `send-receipt` Edge Function
- **Profit margin dashboard**: 6 KPI cards, sortable variant table, color-coded margins, category filter
- **Inventory recount scheduler**: Cycle count scheduling with frequency/day-of-week config, calendar preview

### 38. Revenue & reporting features complete
Built:
- **Customer receipt lookup**: Search by email/phone/name, purchase history view, receipt detail modal with print/email
- **Discount scheduling**: Create recurring (day/time) or date-range promotions, auto-active detection, weekly calendar preview, scope by category/product
- **Employee performance metrics**: 8 KPIs per employee (sales, avg ticket, sales/hour, void rate, exceptions, cash variance, hours worked), sortable leaderboard, comparison view, date range filter
- **Tax reporting**: Period selector (monthly/quarterly/yearly/custom), tax summary dashboard with gross/net/collected/expected/variance, daily breakdown table, CSV export with business header
- **Sales digest settings**: Configure daily/weekly automated email digests with recipient list, preview of digest content (top sellers, tender breakdown, returns, low stock alerts), test email button

### 39. Order calendar & daily manager report complete
Built:
- **Order calendar**: Monthly calendar view in admin with event types (order due, order placed, expected delivery, received, notes), recurring schedule support, supplier/PO linking, carrier tracking, shipment tracking panel
- **Daily manager report**: Date-navigable ops snapshot with executive summary, hourly sales chart (CSS bars), tender breakdown, per-employee performance, cash accountability, inventory alerts, customer insights, action items/flags, manager notes, print button

### 40. Polish, UX & advanced features complete
Built:
- **Keyboard shortcuts**: F1-F10 mapped to register actions (checkout, hold, recall, customer, return, exchange, promo, layaway, new sale, print), Escape for void, ? for shortcuts overlay, context-aware per screen
- **Dark mode**: CSS custom properties for dark theme, `html.dark` class toggle, ThemeToggle button with localStorage persistence, Tailwind override layer for all zinc/white/border classes
- **Multi-location dashboard**: Side-by-side KPI comparison, ranking leaderboard with metric selector, CSS bar charts, staff distribution, performance flags, auto-generated insights
- **AI product recommendations**: Co-purchase matrix from transaction history, category-based fallback, horizontal scrollable strip below product grid, "bought together N times" badges, quick-add button
- **Advanced loyalty tiers**: Bronze/silver/gold/platinum with configurable thresholds, earn multipliers, redemption bonuses, perks editor, customer distribution chart, progress-to-next-tier bars, tier milestone messages
- **Payroll summary**: Period selector (week/biweekly/custom), per-employee daily breakdown with clock in/out/breaks, regular vs overtime hours (40hr threshold), editable hourly rates, gross pay calculation, anomaly detection (missing clock-out, long shifts, no breaks), CSV export, approval workflow with manager notes

## Current state of the product
BasicUniformPOS is **fully deployed and operational** on Cloudflare Workers at `https://basicuniformpos.basicuniformpos.workers.dev`.

**Stack**: Next.js 16.2.1 (App Router, Turbopack) → OpenNext → Cloudflare Workers, Supabase Postgres, Tailwind CSS v4, React 19, TypeScript

What exists now:
- full product/admin foundation with CRUD (create, edit, delete products/categories/variants)
- dual persistence layer (JSON file-backed + Supabase Postgres via `@neondatabase/serverless`)
- auth/session foundation (admin email/password, register PIN, employee quick-switch)
- role-based access control with permission enforcement
- register session and shift lifecycle (open, close, pay-in/out, end-of-day wizard)
- complete cart → checkout → receipt flow with product images
- multi-tender (cash, card, store credit, loyalty, gift card, split)
- hold/recall carts
- void/cancel with mandatory reason codes and manager approval
- customer attach with loyalty earn/redeem
- return processing with inventory restoration
- exchange flow with automatic credit application
- purchase history per customer
- comprehensive admin reports, dashboards, and analytics charts
- server-side approval threshold enforcement
- transaction lifecycle audit trail
- **suspicious employee behavior dashboard** with 6 rule types + auto-run on shift close
- **gift card lifecycle** (activate, reload, redeem at register, disable)
- **store credit ledger** with full audit trail and employee attribution + register redemption
- **layaway workflow** (create from register, partial payments, collect, cancel)
- **stocktake workflow** (create, count, accept with auto-adjustments)
- **inter-store transfer workflow** (request, ship, receive, cancel)
- **purchase order management** (create, add lines, receive shipments)
- **per-item price override** with manager approval threshold enforcement
- **end-of-day Z-Report** with sales, tenders, cash accountability, employee performance
- **end-of-day wizard** with 4-step guided close flow and daily report email
- **barcode/SKU scanner support** with auto-add and continuous scan workflow
- **discount enhancements**: percentage vs fixed (cart + line level), per-item discounts with reason tracking
- **admin dashboard KPIs**: real-time today-at-a-glance with sales, operations, inventory, and liability metrics
- **admin analytics charts**: sales trend, hourly, tender mix, employee performance (Recharts)
- **employee time clock**: clock in/out, break tracking, per-employee timesheet in admin
- **promo/coupon codes**: fixed/percent/BOGO types with validation, min purchase, redemption caps, expiry
- **customer-facing display**: premium dark-themed secondary screen with BroadcastChannel real-time sync
- **product bundles**: package pricing with savings display
- **tax-exempt sales**: per-customer flag, zero-rated through checkout
- **data export**: CSV export for transactions, inventory, customers
- **ESC/POS receipt printer**: Web Serial API for thermal printers
- **scheduled email reports**: Supabase Edge Function + Resend API daily digest
- **barcode label printing**: Code128 SVG generation, configurable labels, browser print
- **mobile/tablet touch optimization**: `@media (pointer: coarse)` adaptive sizing, 4rem minimum targets
- **service worker offline resilience**: cache-first for static assets
- **product images**: thumbnails on POS grid, admin catalog, variant picker
- **multi-register support**: register selection at session start
- **bulk product import**: CSV upload with validation and preview
- **low stock auto-reorder**: draft PO generation from below-reorder-point items
- **profit margin dashboard**: margin analysis by product/category with color-coded indicators
- **inventory recount scheduler**: automated cycle count scheduling
- **customer receipt lookup**: search past purchases by email/phone, print/email receipts
- **discount scheduling**: time-based promotions with recurring or date-range schedules
- **employee performance metrics**: sales/hour, avg ticket, void rate, cash variance, leaderboard
- **tax reporting**: period-based tax summaries with daily breakdown and CSV export
- **sales digest emails**: configurable daily/weekly automated email summaries
- **order calendar**: monthly view with order/delivery events, recurring schedules, carrier tracking
- **daily manager report**: comprehensive ops snapshot with all sections, print-friendly
- **keyboard shortcuts**: F1-F10 register hotkeys with context awareness and overlay help
- **dark mode**: full dark theme with CSS variables, toggle button, localStorage persistence
- **multi-location dashboard**: side-by-side performance comparison with ranking and charts
- **AI product recommendations**: co-purchase analysis, category-based suggestions in register
- **advanced loyalty tiers**: bronze/silver/gold/platinum with escalating earn rates and perks
- **payroll summary**: time clock → hours/overtime/gross pay with anomaly detection and CSV export

## Deployment status
- ✅ Cloudflare Workers: `https://basicuniformpos.basicuniformpos.workers.dev`
- ✅ Supabase Postgres: project `jkdgdcfpgxjfdlccvqjf` (us-west-2), 36 tables
- ✅ Supabase Edge Functions: `daily-report`, `send-receipt`
- ✅ `USE_POSTGRES=true` in Workers env
- ✅ RLS with `orgTx()` helper for write operations
- ✅ Connection pool max=3 for Workers memory constraints

## Next phase candidates
- Custom domain (basicuniformpos.com or similar)
- Supabase Auth integration (replace cookie-based auth)
- Electron desktop wrapper
- Flutter mobile apps
- E-commerce / online storefront
- Shopify/WooCommerce sync
- Marketing automation
- Accounting engine
- Payroll integration
- Public API / webhooks
- AI-driven recommendations
- Advanced loyalty tiers
- Multi-currency support
- Kitchen display system (KDS)

## Key product rules currently driving the build
- web-first only
- optimize for stability and touchscreen speed
- split tender is mandatory in V1
- receipt must show tender breakdown
- no-receipt option required
- returns over $40 require manager approval
- exchanges do not require approval if fully tracked/scanned
- manager approval thresholds:
  - discounts > $5
  - full transaction voids > $20
  - item voids > $15
  - store credit issuance > $10
  - manual price overrides > $10

## Notes
- Current persistence/auth approach is intentionally a dev-friendly local seam, not the final production backend.
- Production direction is still web-first Next.js + Supabase/PostgreSQL.
- Edison should update this file when meaningful BasicUniformPOS milestones are reached.
