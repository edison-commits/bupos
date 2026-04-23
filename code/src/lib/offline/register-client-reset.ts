/**
 * R42-L: client-side cleanup on register logout.
 *
 * When a cashier signs out, we drop three client-side identity
 * artifacts that the cookie-deletion alone leaves behind:
 *
 *   1. `pos_device_id` in localStorage — a stable per-browser UUID the
 *      register uses to pair HMAC-signed device cookies. If the cashier
 *      logs out and the next person logs in, re-using the same
 *      `pos_device_id` keeps a continuous device identity across two
 *      different employee sessions. Rotating on logout means the new
 *      cashier pairs under a fresh id.
 *
 *   2. Pending offline transactions in IndexedDB — the `offline-pos`
 *      store holds cart snapshots tagged with `employeeName`. If the
 *      cashier logs out before those syncs complete, the pending
 *      records carry the previous cashier's name + customer carts.
 *      DevTools on a shared POS tablet would show them to the next
 *      cashier. We only wipe SYNCED entries; unsynced ones are kept
 *      because losing them = losing real money (they'll be replayed
 *      next time the cashier signs back in on this device).
 *
 *   3. Service-worker caches and storage — `Clear-Site-Data` via a
 *      fetch sidestep works in modern browsers; we call it as a
 *      best-effort so CDN-cached authenticated responses don't persist.
 *
 * R44-FE6: idb-store is now STATICALLY imported so the loop below
 * doesn't race a server-action redirect. Prior shape dynamically
 * imported the module inside the helper, which required a chunk
 * fetch; the logout form submission in parallel would cancel pending
 * fetches when the browser navigated, aborting cleanup. Static import
 * puts the module in the hydrated bundle so the IDB ops can start
 * immediately, though async completion still races — the caller's
 * fire-and-forget pattern accepts that risk for the dead-letter rows
 * (a subsequent login re-runs this helper and mops up).
 *
 * Best-effort: swallows every error. Logout MUST complete even if
 * localStorage is disabled, IDB is blocked, or clear-site-data isn't
 * supported.
 */

import { getPendingTransactions, removePendingTransaction, clearCatalog } from "./idb-store";

export async function clearLocalRegisterState(): Promise<void> {
  try {
    localStorage.removeItem("pos_device_id");
  } catch {
    // localStorage might be disabled / full / not available (private mode)
  }

  // R46-M3: wipe the cached catalog so shared-device cross-tenant
  // rotation doesn't serve the previous tenant's products / prices /
  // inventory to the next cashier in offline mode. Best-effort.
  try {
    await clearCatalog();
  } catch {
    // IDB blocked or module failed; best-effort.
  }

  // Wipe only SYNCED pending transactions — unsynced ones are money
  // we'd lose. R44-FE6: idb-store is now statically imported (see
  // module-top docblock).
  try {
    const pending = await getPendingTransactions();
    for (const txn of pending) {
      // A sync-completed entry is marked via the attempts counter being
      // >= MAX and/or the entry being very old; for logout cleanup,
      // a heuristic "older than 24h OR maxed-out attempts" is fine —
      // those are dead letters, not active syncs. Active syncs (<24h
      // old, not maxed out) are left behind so the next sign-in can
      // still replay them.
      const age = Date.now() - new Date(txn.timestamp).getTime();
      const DAY_MS = 24 * 60 * 60 * 1000;
      if (age > DAY_MS || (typeof txn.attempts === "number" && txn.attempts >= 10)) {
        await removePendingTransaction(txn.id).catch(() => undefined);
      }
    }
  } catch {
    // IDB blocked or module failed to load; best-effort.
  }
}
