/**
 * R84-final: unified admin-mutation revalidation helper.
 *
 * Background:
 *   `/admin/page.tsx` reads via `readStore(orgId)` which is cache-
 *   backed with a 30s TTL (`postgres-read-store.ts:_storeCache`).
 *   Admin mutation Server Actions call `revalidatePath("/admin")`
 *   which re-renders the Server Component — but readStore still
 *   returns the cached snapshot for up to 30s, so admins see stale
 *   data immediately after their own writes. R84-hand added
 *   `invalidateStoreCache` to the REGISTER-side mutation paths
 *   (checkout-action + return-action) but the symmetric admin-side
 *   calls were missing.
 *
 *   R84-DB identified this as a MED pattern extension: 31 admin
 *   revalidatePath("/admin") call sites across 7 Server Action
 *   files, zero invalidateStoreCache calls. Self-heals after 30s
 *   but the gap is real UX drift.
 *
 * Usage: call `revalidateAdmin(orgId)` anywhere you previously
 * called `revalidatePath("/admin")` in an admin Server Action.
 * Does both the cache bust AND the route revalidation.
 */

import { revalidatePath } from "next/cache";
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";

export function revalidateAdmin(orgId: string): void {
  // Cache bust FIRST so the subsequent re-render reads fresh data.
  invalidateStoreCache(orgId);
  revalidatePath("/admin");
}
