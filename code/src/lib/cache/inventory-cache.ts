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
}
