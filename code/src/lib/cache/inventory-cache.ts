/**
 * Shared inventory response cache used by /api/inventory.
 *
 * Lives in src/lib/cache/ (not src/app/api/inventory/route.ts) so that write
 * paths (checkout, returns, receiving, PO, offline-sync, transfers) can
 * invalidate without creating a circular dependency between app routes.
 */
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
  import("@/lib/persistence/postgres-read-store").then((m) => {
    m.invalidateStoreCache(orgId);
  }).catch(() => {
    // Module load failure here is non-fatal for the mutation —
    // worst case: 30s of stale reads from readStore. Log nothing
    // to keep the write path cheap.
  });
}
