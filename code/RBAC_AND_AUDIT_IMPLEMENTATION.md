# Role-Based Access Control and Audit Trail Implementation

## Overview

Two major features have been added to BasicUniformPOS to improve security and compliance:

1. **Role-Based Access Control (RBAC)** for admin pages
2. **Audit Trail / Activity Log** system for transaction events

## Feature 1: Role-Based Access Control

### Files Created

#### 1. `src/lib/domain/admin-access.ts`
A domain module that maps admin routes to required roles and provides utility functions.

**Exported Functions:**
- `adminPageAccess: Record<string, RoleKey[]>` — Maps each admin route to allowed roles
- `canAccessPage(roleKey: string, path: string): boolean` — Check if a role can access a specific page
- `getAccessiblePages(roleKey: string): string[]` — Get all accessible pages for a role

**Admin Page Access Mapping:**
- `/admin/dashboard` → owner, manager, cashier
- `/admin/transactions` → owner, manager, cashier
- `/admin/returns` → owner, manager, cashier
- `/admin/inventory` → owner, manager, inventory_clerk
- `/admin/products` → owner, manager, inventory_clerk
- `/admin/receiving` → owner, manager, inventory_clerk
- `/admin/employees` → owner, manager
- `/admin/customers` → owner, manager, cashier
- `/admin/shift-close` → owner, manager
- `/admin/cash-drawer` → owner, manager
- `/admin/reports` → owner, manager
- `/admin/audit` → owner, manager
- `/admin/purchase-orders` → owner, manager, inventory_clerk
- `/admin/loyalty` → owner, manager
- `/admin/labels` → owner, manager, inventory_clerk, cashier
- `/admin/settings` → owner (most restrictive)

#### 2. `src/components/admin/role-gate.tsx`
A React client component that acts as an access control wrapper.

**Features:**
- Reads user role from localStorage (`bupos_employee_role`)
- Checks against allowed roles prop
- Displays appropriate error messages:
  - "Sign In Required" if no role is stored
  - "Access Denied" with role info if user lacks permission
- Hydration-safe (uses `useState` and `useEffect`)
- Supports custom fallback UI via optional prop

**Usage:**
```tsx
<RoleGate allowedRoles={['owner', 'manager']}>
  <YourAdminComponent />
</RoleGate>
```

**Implementation Notes:**
- Component returns `null` during SSR to prevent hydration mismatches
- Access is determined on client-side by checking localStorage
- Default UI uses teal/emerald accent colors consistent with the admin theme

### Integration Steps

To protect an admin page with RoleGate:

```tsx
// In /admin/your-page/page.tsx
'use client';
import { RoleGate } from '@/components/admin/role-gate';

export default function YourPage() {
  return (
    <RoleGate allowedRoles={['owner', 'manager']}>
      {/* Your admin page content */}
    </RoleGate>
  );
}
```

---

## Feature 2: Audit Trail / Activity Log

### Files Modified

#### `src/app/api/audit/route.ts` (Updated)
Refactored to work with the `transaction_events` table instead of the generic `audit_events` table.

**Schema:**
The API queries the `transaction_events` table with the following columns:
- `id` (uuid)
- `transaction_id` (uuid)
- `actor_employee_id` (uuid)
- `event_kind` (text) — e.g., 'item_added', 'discount_applied', 'payment_started'
- `notes` (text, nullable)
- `payload` (jsonb)
- `created_at` (timestamptz)

**Query Parameters:**
- `from` — Start date (ISO format)
- `to` — End date (ISO format)
- `employee_id` — Filter by actor employee ID
- `event_kind` — Filter by event type
- `page` — Page number (default: 1)
- `pageSize` — Results per page (default: 50, max: 200)

**Response Format:**
```json
{
  "events": [
    {
      "id": "uuid",
      "transaction_id": "uuid",
      "actor_employee_id": "uuid",
      "actor_name": "Employee Name",
      "role_key": "manager",
      "event_kind": "item_added",
      "notes": "Optional notes",
      "payload": { ... },
      "created_at": "2026-03-25T09:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 1234,
    "totalPages": 25
  }
}
```

**Implementation Notes:**
- Uses a single consolidated query to avoid Cloudflare Workers CPU timeout
- Properly joins with `employees` table to include actor display names
- Left join to handle cases where employee record is deleted
- Results ordered by `created_at DESC` (newest first)

### Files Created

#### `src/app/admin/audit/page.tsx` (New)
A comprehensive admin page for viewing and analyzing transaction event logs.

**Features:**
- **Date Range Filtering** — From/To date picker
- **Employee Filtering** — Dropdown of all employees
- **Event Type Filtering** — Dropdown of discovered event kinds
- **Paginated Results** — Displays 50 events per page with navigation
- **Expandable Rows** — Click to view full JSON payload for each event
- **Color-Coded Event Types** — Visual badges with distinct colors:
  - `item_added` → Blue
  - `item_removed` → Red
  - `discount_applied` → Green
  - `payment_started` → Purple
  - `cart_voided` → Dark Red
  - `cart_held` → Yellow
  - `cart_recalled` → Teal
  - `quantity_changed` → Orange
  - `pin_login` → Slate
  - `register_session_started` → Teal
  - `register_session_ended` → Dark Slate
  - Others → Gray (default)

**UI Components:**
- Responsive layout with Tailwind CSS
- Filter panel with date inputs and dropdowns
- Results table with sortable columns
- Pagination controls (previous/next buttons)
- Expandable row details showing full payload JSON
- Loading and empty states
- Error message display

**Role Protection:**
- Page wrapped in `RoleGate` with `allowedRoles={['owner', 'manager']}`
- Only owners and managers can access the audit page

**Usage:**
Users can navigate to `/admin/audit` to view audit logs. The page will:
1. Load all employees for the dropdown filter
2. Load event kinds discovered in the database
3. Display recent events with default pagination
4. Allow filtering by date range, employee, and event type
5. Show expandable details for each event

---

## Database Considerations

### Table: `transaction_events`
The audit trail is built on the existing `transaction_events` table:

```sql
CREATE TABLE transaction_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  actor_employee_id uuid references employee_profiles(id),
  event_kind text not null,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Indexes:
- `idx_transaction_events_txn` on `transaction_id`
- `idx_transaction_events_actor` on `actor_employee_id`

### Table: `employees`
The API joins with the `employees` table to include actor information:
- `id` (uuid)
- `display_name` (text)
- `first_name` (text)
- `last_name` (text)
- `role_key` (text)

---

## RLS (Row-Level Security)

All database queries use `orgQuery()` which:
1. Sets the RLS context with `SET LOCAL app.current_org_id`
2. Ensures queries are scoped to the current organization
3. Uses a single consolidated query to avoid CPU timeouts

**Important:** Do not make parallel `orgQuery()` calls as this can exceed Cloudflare Workers CPU limits.

---

## Usage Examples

### Checking Access Before Navigation

```typescript
import { canAccessPage } from '@/lib/domain/admin-access';

const userRole = localStorage.getItem('bupos_employee_role');
if (canAccessPage(userRole, '/admin/employees')) {
  // User can access
}
```

### Getting Accessible Pages

```typescript
import { getAccessiblePages } from '@/lib/domain/admin-access';

const role = 'manager';
const pages = getAccessiblePages(role);
// Returns: ['/admin/dashboard', '/admin/transactions', ...]
```

### Querying Audit Events

```typescript
// Fetch all events from the last 7 days for a specific employee
const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const response = await fetch(`/api/audit?from=${from}&employee_id=${empId}`);
const { events, pagination } = await response.json();
```

---

## Testing Checklist

- [ ] Verify `admin-access.ts` exports functions correctly
- [ ] Test `RoleGate` component blocks access for non-approved roles
- [ ] Test `RoleGate` redirects to sign-in page when no role is stored
- [ ] Navigate to `/admin/audit` and verify it requires owner/manager role
- [ ] Test date range filtering on audit page
- [ ] Test employee filtering on audit page
- [ ] Test event type filtering on audit page
- [ ] Verify pagination controls work correctly
- [ ] Click rows to expand and view full JSON payloads
- [ ] Verify event kind color badges display correctly
- [ ] Test clearing all filters

---

## Future Enhancements

1. **Export Audit Logs** — Add CSV/PDF export functionality
2. **Search** — Full-text search across notes and payload
3. **Alerts** — Set up monitoring for specific event kinds
4. **Analytics** — Dashboard showing trends in event types
5. **Retention Policy** — Automatic archival of old audit logs
6. **Compliance Reports** — Generate SOC 2 / PCI DSS reports
