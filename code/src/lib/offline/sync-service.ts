"use client";

import {
  getPendingTransactions,
  removePendingTransaction,
  savePendingTransaction,
  type PendingTransaction,
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
/** Return transactions that have permanently failed (exceeded max retries). */
export async function getDeadLetterTransactions(): Promise<PendingTransaction[]> {
  const pending = await getPendingTransactions();
  return pending.filter((txn) => txn.attempts >= MAX_RETRY_ATTEMPTS);
}

export async function syncPendingTransactions(): Promise<{
  synced: number;
  failed: number;
  skipped: number;
  remaining: number;
  deadLetters: PendingTransaction[];
}> {
  const pending = await getPendingTransactions();
  if (pending.length === 0) return { synced: 0, failed: 0, skipped: 0, remaining: 0, deadLetters: [] };

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  const deadLetters: PendingTransaction[] = [];

  // Separate out dead letters up front
  const active: PendingTransaction[] = [];
  for (const txn of pending) {
    if (txn.attempts >= MAX_RETRY_ATTEMPTS) {
      skipped++;
      deadLetters.push(txn);
    } else {
      active.push(txn);
    }
  }

  // R32-H9: serialize sync. Prior CONCURRENCY = 4 with Promise.all
  // could dispatch a VOID after its underlying SALE but see them
  // finish in either order (parallel fetch completions are not
  // ordered). Cross-transaction dependencies (void-of-sale, exchange-
  // of-sale) could then flip: the server sees the void arrive first,
  // rejects it (no matching sale yet), and dead-letters it, while
  // the sale commits successfully — leaving orphaned sale + lost
  // void. Serial sync preserves the client-side capture order. The
  // backlog-after-reconnect cost is acceptable because offline
  // sessions are bounded by shift length.
  const CONCURRENCY = 1;
  const syncOne = async (txn: PendingTransaction): Promise<void> => {
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
      } else if (res.status === 409) {
        // 409s are either TRANSIENT (approval consumed by another
        // cashier, insufficient inventory right now, insufficient
        // loyalty points) or TERMINAL (promo deactivated/expired after
        // the offline save — server sets `retriable: false`). Trust the
        // server's signal; default to retriable so a missing flag
        // doesn't silently dead-letter a cart that would succeed on
        // retry once the racing condition clears.
        const body = await res.json().catch(() => ({ error: "Conflict", retriable: true }));
        if (body.retriable === false) {
          await savePendingTransaction({
            ...txn,
            attempts: MAX_RETRY_ATTEMPTS,
            lastError: body.error ?? "Cart no longer valid",
          });
        } else {
          await savePendingTransaction({
            ...txn,
            attempts: txn.attempts + 1,
            lastError: body.error ?? "Conflict",
          });
        }
        failed++;
      } else {
        const errText = await res.text().catch(() => "Unknown error");
        // R34-D6: scrub the raw server body before persisting it into
        // IndexedDB. Upstream error bodies can embed PII (customer
        // email, sku, phone) when a pg error bubbles through. IDB
        // persists across sessions, so a dead-letter from Alice's
        // session sits in the same DB Bob can inspect via devtools.
        // Strip Postgres DETAIL/KEY fragments, quotes, and anything
        // that looks like an email or phone number.
        const scrubbed = errText
          .replace(/\s*DETAIL:.*$/is, "")
          .replace(/Key\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, "Key (…)=(…)")
          .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
          .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
        await savePendingTransaction({
          ...txn,
          attempts: txn.attempts + 1,
          lastError: scrubbed.slice(0, 200),
        });
        failed++;
      }
    } catch {
      await savePendingTransaction({
        ...txn,
        attempts: txn.attempts + 1,
        lastError: "Network error",
      });
      failed++;
    }
  };

  // Simple worker-pool pattern: each worker pulls the next txn off a shared queue.
  const queue = active.slice();
  const worker = async () => {
    while (queue.length > 0) {
      const txn = queue.shift();
      if (!txn) return;
      await syncOne(txn);
    }
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, active.length) }, worker);
  await Promise.all(workers);

  const remaining = pending.length - synced;
  return { synced, failed, skipped, remaining, deadLetters };
}
