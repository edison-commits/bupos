# BasicUniformPOS Architecture Notes

## Chosen stack
- Next.js App Router
- TypeScript everywhere
- Tailwind v4 for fast, touch-friendly UI primitives
- Local JSON-backed repository + server actions for Milestone 1 runtime
- PostgreSQL-first schema direction documented in `docs/schema/` for the later production seam

## Why this stack
- Web-first and operationally boring.
- Fast iteration for register/admin surfaces.
- Clear path to server actions, APIs, auth, and Postgres-backed data later.

## App shape
- `/` overview and milestone scope
- `/register` touchscreen-oriented register shell
- `/admin` catalog/inventory/staff shell

## Domain focus in this scaffold
- Organizations and locations
- Employees with role and PIN direction
- Categories, products, variants, modifiers, inventory
- Audit events and transaction placeholders for future tender/exceptions work

## Explicitly out of scope in this pass
- Checkout flows
- Reports
- Accounting/payroll
- E-commerce
- Electron/Flutter/mobile wrappers
