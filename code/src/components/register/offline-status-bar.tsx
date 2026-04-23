"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { getPendingCount } from "@/lib/offline/idb-store";
import { syncPendingTransactions } from "@/lib/offline/sync-service";

export function OfflineStatusBar() {
  const { isOnline, checkConnectivity } = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Defer the first status render until after mount so we don't flash
  // "Online" on page load for a genuinely-offline client (SSR renders
  // `isOnline=true` because it can't know the browser state; hydration
  // starts with that, then the useOnlineStatus effect flips to false ~1
  // frame later). This `hasMounted` guard lets us render nothing on the
  // very first paint and the real status on the second — which prevents
  // the "green dot → amber bar" flicker a cashier would otherwise see
  // after reloading a disconnected register.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => { setHasMounted(true); }, []);

  // R43-M: mount-guard. Prior shape had `getPendingCount().then(setPendingCount)`
  // with no abort — unmount between the IDB round-trip starting and
  // resolving triggered "setState on unmounted component" in strict
  // mode and could write stale data to a now-unmounted store.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Poll pending count
  useEffect(() => {
    if (typeof window === "undefined" || !("indexedDB" in window)) return;

    const check = () => {
      getPendingCount()
        .then((n) => { if (mountedRef.current) setPendingCount(n); })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 5_000);
    return () => clearInterval(interval);
  }, []);

  // IMPORTANT: all hooks must be declared before any conditional return.
  // Previously a `if (!hasMounted) return null` sat between this block and
  // `useCallback`/`useEffect` below, which meant on the very first render
  // (hasMounted=false) React saw 6 hooks; on the second (hasMounted=true)
  // it saw 8 — violating the Rules of Hooks and crashing with "Rendered
  // more hooks than during the previous render" on hydration.
  //
  // R34-D16: track the clear-timeout in a ref so unmount cancels it.
  // Prior shape fired setTimeout in `finally` with no cleanup —
  // unmount within the 5s window triggered setState on an
  // unmounted component.
  const clearResultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (clearResultTimeoutRef.current) {
        clearTimeout(clearResultTimeoutRef.current);
      }
    };
  }, []);
  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);

    // R76-FE-H1: hoist `hasDeadLetters` OUTSIDE the try block so the
    // finally branch can honor it. R75's shape declared it inside the
    // try and relied on `return` to skip the auto-clear — but
    // `try { return; } finally { ... }` still runs the finally in JS,
    // so dead-letter messages disappeared after 5s despite the fix's
    // stated intent. This is a self-regression of R75-F.
    let hasDeadLetters = false;
    try {
      const result = await syncPendingTransactions();
      // R43-M: guard every setState behind the mount ref. A sync can
      // take seconds; the component can unmount during it (navigation,
      // shift close), and strict-mode React will warn on any stale
      // setState.
      if (!mountedRef.current) return;
      if (result.synced > 0) {
        setSyncResult(`Synced ${result.synced} transaction${result.synced > 1 ? "s" : ""}`);
      }
      // R37-H4: surface dead-letter cases separately from retryable
      // failures. Prior shape lumped terminal 403s (deactivated employee
      // → "A manager must re-enter this sale") into "X failed — will
      // retry", burning silent retry cycles and hiding the real signal
      // from the cashier/manager standing at the register.
      if (result.deadLetters.length > 0) {
        hasDeadLetters = true;
        const first = result.deadLetters[0]?.lastError;
        const extra = result.deadLetters.length > 1 ? ` (+${result.deadLetters.length - 1} more)` : "";
        setSyncResult((prev) =>
          (prev ? prev + ". " : "") +
          `${result.deadLetters.length} can't be synced${extra}: ${first ?? "manager action required"}`,
        );
      }
      const retryableFailed = result.failed - result.deadLetters.length;
      if (retryableFailed > 0) {
        setSyncResult((prev) =>
          (prev ? prev + ". " : "") + `${retryableFailed} failed — will retry`,
        );
      }
      setPendingCount(result.remaining);
    } catch {
      if (mountedRef.current) setSyncResult("Sync error — will retry");
    } finally {
      if (mountedRef.current) setSyncing(false);
      // Clear result message after 5s (R34-D16: canceled on unmount).
      // R75-F / R76-FE-H1: SKIP the auto-clear when dead letters exist
      // — the user needs to see the actionable message until they
      // act on it. `hasDeadLetters` is hoisted above the try for
      // this branch to read.
      if (!hasDeadLetters) {
        if (clearResultTimeoutRef.current) clearTimeout(clearResultTimeoutRef.current);
        clearResultTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) setSyncResult(null);
        }, 5_000);
      }
    }
  }, [syncing]);

  // Auto-sync when coming back online (depends on handleSync so it re-runs when syncing status changes)
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !syncing) {
      handleSync();
    }
  }, [isOnline, pendingCount, syncing, handleSync]);

  // Render nothing on first paint to avoid the online→offline flicker.
  // MUST come after every hook above — conditional early return before any
  // hook breaks the Rules of Hooks.
  if (!hasMounted) return null;

  // If online and nothing pending, show a minimal green dot
  if (isOnline && pendingCount === 0 && !syncResult) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        Online
      </div>
    );
  }

  // Offline state
  if (!isOnline) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-4 py-2 text-sm font-semibold bg-amber-50 border-2 border-amber-300 text-amber-800">
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-amber-400" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
        </span>
        <div className="flex-1">
          <span>Offline mode</span>
          {pendingCount > 0 && (
            <span className="ml-2 text-amber-600">
              · {pendingCount} sale{pendingCount > 1 ? "s" : ""} queued
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={checkConnectivity}
          className="rounded-md bg-amber-200 px-2 py-1 text-xs font-bold text-amber-800 hover:bg-amber-300 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // Online but has pending or syncing
  return (
    <div className="flex items-center gap-3 rounded-lg px-4 py-2 text-sm font-semibold bg-blue-50 border border-blue-200 text-blue-800">
      {syncing ? (
        <>
          <svg className="h-4 w-4 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8" className="opacity-75" />
          </svg>
          <span>Syncing {pendingCount} transaction{pendingCount > 1 ? "s" : ""}...</span>
        </>
      ) : syncResult ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span>{syncResult}</span>
        </>
      ) : (
        <>
          <span className="relative flex h-2 w-2">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          <span>{pendingCount} queued sale{pendingCount > 1 ? "s" : ""}</span>
          <button
            type="button"
            onClick={handleSync}
            className="rounded-md bg-blue-200 px-2 py-1 text-xs font-bold text-blue-800 hover:bg-blue-300 transition-colors"
          >
            Sync now
          </button>
        </>
      )}
    </div>
  );
}
