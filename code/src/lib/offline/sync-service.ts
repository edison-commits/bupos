"use client";

import {
  getPendingTransactions,
  removePendingTransaction,
  savePendingTransaction,
  type PendingTransaction,
} from "./idb-store";

/**
 * Attempt to sync all pending offline transactions to the server.
 * Returns the number of successfully synced transactions.
 */
export async function syncPendingTransactions(): Promise<{
  synced: number;
  failed: number;
  remaining: number;
}> {
  const pending = await getPendingTransactions();
  if (pending.length === 0) return { synced: 0, failed: 0, remaining: 0 };

  let synced = 0;
  let failed = 0;

  for (const txn of pending) {
    try {
      const res = await fetch("/api/offline-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: txn.id,
          cart: txn.cart,
          tenders: txn.tenders,
          approvedExceptions: txn.approvedExceptions,
          timestamp: txn.timestamp,
        }),
      });

      if (res.ok) {
        await removePendingTransaction(txn.id);
        synced++;
      } else {
        const errText = await res.text().catch(() => "Unknown error");
        // Update attempt count
        await savePendingTransaction({
          ...txn,
          attempts: txn.attempts + 1,
          lastError: errText.slice(0, 200),
        });
        failed++;
      }
    } catch {
      // Network still down — stop trying
      failed++;
      break;
    }
  }

  const remaining = pending.length - synced;
  return { synced, failed, remaining };
}
