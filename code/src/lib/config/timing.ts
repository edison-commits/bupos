/**
 * Shared timing constants (in milliseconds) used across UI components and API routes.
 * Centralizing these makes them searchable and prevents inconsistent timeout values.
 */

// --- UI timeouts (used in React components / browser) ---
/** Default fetch timeout for admin/employee-facing API calls (15s). */
export const FETCH_TIMEOUT_MS = 15_000; // 15 seconds

/** How long to show a success/feedback toast before auto-dismissing (2s). */
export const FEEDBACK_TOAST_MS = 2_000; // 2 seconds

/** How long to show a submit-success indicator (5s). */
export const SUCCESS_TOAST_MS = 5_000; // 5 seconds

/** How often to poll the dashboard endpoint for live KPI updates (60s). */
export const DASHBOARD_POLL_INTERVAL_MS = 60_000; // 60 seconds

// --- API cache TTLs (server-side) ---
/** Product list cache TTL used in /api/products (30s). */
export const PRODUCTS_CACHE_TTL_MS = 30_000; // 30 seconds

// --- Derived convenience exports ---
export const ONE_SECOND_MS = 1_000;
export const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
export const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
