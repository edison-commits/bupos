"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * React hook that tracks online/offline status with active server ping.
 * Uses both navigator.onLine and a periodic connectivity check.
 */
export function useOnlineStatus() {
  // Always initialize to `true` so SSR and the client's FIRST render match.
  // Reading `navigator.onLine` in the useState initializer produced
  // intermittent React #418 hydration failures on clients that were offline
  // at mount time — SSR rendered the "online" branch, the client then
  // rendered the "offline" branch, and the DOM subtrees didn't match. The
  // real status is picked up in the useEffect below on first paint.
  const [isOnline, setIsOnline] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  // R76-FE-M: AbortController ref so we can cancel an in-flight
  // /api/health ping when the hook unmounts or a newer ping starts.
  // Prior shape had two race vectors:
  //   (a) component unmounted with fetch still pending → setState
  //       on torn-down context (React 18 silently drops, but the
  //       fetch still hits the network).
  //   (b) `isOnline` in the effect deps list retriggered a fresh
  //       checkConnectivity() on every flip — two pings in flight
  //       competed, older resolved last, state flipped back.
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Check actual server reachability (not just browser online flag)
  const checkConnectivity = useCallback(async () => {
    // Abort any prior in-flight check — guarantees serial ordering
    // so the newest result wins the state flip.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/health?_t=${Date.now()}`, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mountedRef.current) return false;
      const online = res.ok;
      setIsOnline(online);
      setLastChecked(new Date().toISOString());
      return online;
    } catch (e) {
      // R76-FE-M: an AbortError here means a newer check superseded
      // us — do NOT flip state to offline based on a stale abort.
      if ((e as { name?: string })?.name === "AbortError") return false;
      if (!mountedRef.current) return false;
      setIsOnline(false);
      setLastChecked(new Date().toISOString());
      return false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = async () => {
      setIsOnline(true);
      const online = await checkConnectivity();
      // Auto-sync pending offline transactions when connectivity is restored
      if (online) {
        try {
          const { syncPendingTransactions } = await import('./sync-service');
          // R32-D10: prune stale dead-letter transactions (>30d) before
          // syncing. Stale rows carry full cart snapshots + customer
          // ids and otherwise sit in IndexedDB forever.
          try {
            const { purgeStaleDeadLetters } = await import('./idb-store');
            const purged = await purgeStaleDeadLetters();
            if (purged > 0) console.info(`[sync] purged ${purged} stale dead-letter transaction(s) (>30d)`);
          } catch {
            // Non-fatal — dead-letter purge is opportunistic.
          }
          const result = await syncPendingTransactions();
          if (result.deadLetters.length > 0) {
            console.warn(`[sync] ${result.deadLetters.length} transaction(s) permanently failed — manual recovery needed`);
          }
        } catch (err) {
          // R21-H-2: safeErr so client-side console doesn't leak bound
          // parameters (customer email, transaction totals) from an
          // upstream pg error that bubbled through fetch().
          const { safeErr } = await import('@/lib/logging/safe-err');
          console.error('[sync] auto-sync failed:', safeErr(err));
        }
      }
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Respect the browser's navigator.onLine flag on first client paint so
    // offline clients flip immediately (don't wait for the /api/health round-trip).
    setIsOnline(navigator.onLine);

    // R34-D16: choose interval based on the CURRENT isOnline state so
    // going online → offline actually flips the poll cadence to 60s.
    // Prior shape captured navigator.onLine ONCE at effect-mount and
    // never updated, leaving offline devices polling every 30s.
    const pollMs = isOnline ? 30_000 : 60_000;
    const interval = setInterval(checkConnectivity, pollMs);
    // Initial server check
    checkConnectivity();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(interval);
      // R76-FE-M: abort any in-flight health ping so it doesn't
      // land stale setState after unmount.
      abortRef.current?.abort();
      mountedRef.current = false;
    };
    // isOnline is intentionally in deps so the interval recycles
    // on state flip.
  }, [checkConnectivity, isOnline]);

  return { isOnline, lastChecked, checkConnectivity };
}
