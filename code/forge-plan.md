# BasicUniformPOS Forge Plan (Milestone 0.5)

This plan outlines the sequential implementation of BasicUniformPOS features leveraging PostgreSQL.

## Milestone 0.5: PostgreSQL Scaffolding and Core CRUD

### 0.5.1: PostgreSQL Migration and Runtime Layer
- **Objective:** Replace the local JSON repository with a robust PostgreSQL migration and runtime layer.
- **Tasks:**
    - Create initial SQL migration files for core entities (organizations, locations, employees, products, categories, etc.).
    - Implement a PostgreSQL client/ORM integration (e.g., Prisma, Drizzle ORM, or raw SQL with a connection pool).
    - Adapt the existing repository helpers to interface with the new PostgreSQL runtime.
    - Ensure data from `src/lib/data/mock-data.ts` can be seeded into the new database.
- **Verification:**
    - Successful seeding of mock data into PostgreSQL.
    - All existing CRU (Create, Read, Update) operations using the JSON store now function correctly with PostgreSQL.
    - `npm run build` passes.

### 0.5.2: Seed Data
- **Objective:** Populate the PostgreSQL database with the initial mock data.
- **Tasks:**
    - Write a script to migrate `src/lib/data/mock-data.ts` into PostgreSQL, utilizing the migration files created in 0.5.1.
- **Verification:**
    - Database is populated with the expected mock data.
    - All application features relying on this data function correctly.

### 0.5.3: Core CRUD Operations
- **Objective:** Implement full Create, Read, Update, and Delete (CRUD) operations for key entities.
- **Tasks:**
    - Implement edit/update flows for products, variants, categories, and employee credentials.
    - Ensure delete operations are handled appropriately (soft delete or cascade as needed).
- **Verification:**
    - Users can successfully create, view, edit, and delete products, variants, categories, and employees via the admin interface.
    - `npm run build` passes.

### 0.5.4: Register Session Lifecycle
- **Objective:** Implement the register opening, closing, and shift/session lifecycle.
- **Tasks:**
    - Develop functionality for opening a new register session, including initial cash drawer balancing.
    - Implement the process for closing a register session, including final cash drawer reconciliation.
    - Integrate with existing register session boundary to ensure persistence.
- **Verification:**
    - Users can reliably open and close register sessions.
    - Cash drawer balancing and reconciliation processes are functional.
    - `npm run build` passes.

### 0.5.5: Transaction Assembly and Checkout Foundations
- **Objective:** Lay the groundwork for transaction assembly, cart management, and checkout.
- **Tasks:**
    - Implement the logic for adding items to a cart.
    - Develop the structure for assembling a full transaction.
    - Integrate with the pre-reserved tender, event, and exception structures from the initial scaffold.
- **Verification:**
    - Items can be added to a cart, and a transaction can be assembled.
    - The data structures for tender, events, and exceptions are correctly utilized.
    - `npm run build` passes.

### 0.5.6: Authorization Guards and RLS
- **Objective:** Implement stronger authorization guards and Row-Level Security (RLS).
- **Tasks:**
    - Wire proper authorization guards in the app router for admin and register functionalities.
    - Implement RLS in PostgreSQL based on the documented direction in `docs/schema/002_rls_direction.sql`.
    - Connect frontend authentication state with backend authorization logic.
- **Verification:**
    - Users are correctly restricted based on their roles and permissions.
    - RLS prevents unauthorized access to sensitive data.
    - `npm run build` passes.

## Notes
- For PostgreSQL integration, consider using a library like `pg` for direct SQL queries or an ORM like Prisma or Drizzle ORM for a more structured approach.
- Ensure all database interactions are handled within the repository layer to maintain separation of concerns.
- All changes should be committed with the prefix `forge(bupos):`.
