/**
 * Shared inventory response cache used by /api/inventory.
 *
 * Lives in src/lib/cache/ (not src/app/api/inventory/route.ts) so that write
 * paths (checkout, returns, receiving, PO, offline-sync, transfers) can
 * invalidate without creating a circular dependency between app routes.
 */
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";

export const _inventoryCache = new Map<string, { data: unknown; expiresAt: number }>();
export const INV_CACHE_TTL = 30_000;
export const MAX_INV_CACHE_SIZE = 50;

export function invalidateInventoryCache(orgId?: string) {
  if (!orgId) {
    _inventoryCache.clear();
    return;
  }
  const prefix = `${orgId}:`;
  for (const key of _inventoryCache.keys()) {
    if (key.startsWith(prefix)) _inventoryCache.delete(key);
  }
  // R94-MED: cascade into the readStore cache. Every mutation that
  // touches inventory (checkout, returns, receiving, PO, offline-
  // sync, transfers) ALSO changes tables in get_full_store's
  // snapshot (inventory_levels) or adjacent ones (transactions,
  // pay_in_outs's parent shifts, etc.). Prior shape: callers
  // busted the inventory-response cache but left readStore serving
  // stale data for up to 30s — admin dashboards showing
  // yesterday's on_hand after a cashier ring-up. Cascading here
  // keeps every write-path call site DRY (inline imports +
  // explicit invalidateStoreCache across 30+ sites was the prior
  // R84-R94 sweep's payload; the cascade means new write-path
  // additions only need to remember invalidateInventoryCache).
  //
  // Uses dynamic import to avoid a top-level circular dep
  // (postgres-read-store imports from @/lib/supabase-rest which
  // imports from @/lib/cache/inventory-cache transitively in some
  // build configurations).
  //
  // OPS-AUDIT5-CRIT1: route through waitUntilOrAwait. The prior bare
  // `import(...).then(...).catch(...)` ExpressionStatement was a
  // dangling Promise — the `no_handle_cross_request_promise_resolution`
  // Workers compat flag CANCELS in-flight Promises that haven't been
  // adopted by either an `await` or `ExecutionContext.waitUntil` by
  // the time the response returns. Net effect: every checkout / return
  // / receiving / PO / transfer silently skipped the readStore
  // invalidation, and admin dashboards served up to 30s of stale
  // on_hand counts. waitUntilOrAwait either schedules the work via
  // ctx.waitUntil (Workers) OR awaits inline (dev/test) — keeps the
  // write path fast in prod while still guaranteeing the cascade
  // settles. The eslint `no-workers-hazards` rule only matched
  // `void import(...).then(...)` so the bare-statement form slipped
  // past for a round; sibling fix in OPS-AUDIT5-MED3 broadens the
  // detector.
  const cascade = import("@/lib/persistence/postgres-read-store")
    .then((m) => m.invalidateStoreCache(orgId))
    .catch(() => {
      // Module load failure here is non-fatal for the mutation —
      // worst case: 30s of stale reads from readStore. Log nothing
      // to keep the write path cheap.
    });
  // Adopt the cascade Promise via ExecutionContext.waitUntil so the
  // Workers runtime keeps it alive past the response. The .catch()
  // above swallows errors; this .catch() catches any waitUntilOrAwait
  // bookkeeping error (cloudflare context lookup, etc.) so a stray
  // throw from the runtime helper can't leak into the write path.
  void waitUntilOrAwait(cascade).catch(() => { /* swallow — non-fatal */ });
}
