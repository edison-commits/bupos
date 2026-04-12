"use client";

import {
  getPendingTransactions,
  removePendingTransaction,
  savePendingTransaction,
} from "./idb-store";

const MAX_RETRY_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = exponential * 0.5 * Math.random();
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to sync all pending offline transactions to the server.
 * Uses exponential backoff between retries and skips transactions
 * that have exceeded MAX_RETRY_ATTEMPTS.
 */
export async function syncPendingTransactions(): Promise<{
  synced: number;
  failed: number;
  skipped: number;
  remaining: number;
}> {
  const pending = await getPendingTransactions();
  if (pending.length === 0) return { synced: 0, failed: 0, skipped: 0, remaining: 0 };

  let synced = 0;
  let failed = 0;
  let skipped = 0;

  for (const txn of pending) {
    // Skip transactions that have exceeded max retries
    if (txn.attempts >= MAX_RETRY_ATTEMPTS) {
      skipped++;
      continue;
    }

    // Apply backoff delay based on previous attempt count
    if (txn.attempts > 0) {
      await sleep(backoffDelay(txn.attempts));
    }

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
        await savePendingTransaction({
          ...txn,
          attempts: txn.attempts + 1,
          lastError: errText.slice(0, 200),
        });
        failed++;
      }
    } catch {
      // Network error — increment attempt count and continue to next
      await savePendingTransaction({
        ...txn,
        attempts: txn.attempts + 1,
        lastError: "Network error",
      });
      failed++;
    }
  }

  const remaining = pending.length - synced;
  return { synced, failed, skipped, remaining };
}
