"use client";
/**
 * R40-7: service-worker update banner.
 *
 * Service worker (`public/sw.js`) no longer calls `skipWaiting()`
 * unconditionally on install — a malicious update would otherwise
 * take over active admin tabs' in-flight fetches with zero user
 * affordance to decline.
 *
 * This component listens for a `waiting` SW (a new version installed,
 * ready to activate on next reload) and shows a bottom-right banner
 * with a "Reload to update" button. Clicking it:
 *   1. posts `{type: 'SKIP_WAITING'}` to the waiting SW
 *   2. waits for the `controllerchange` event
 *   3. reloads the page so the new SW controls the fresh fetches
 *
 * The user can ignore the banner; the new SW activates naturally on
 * the next full navigation (browser restart / tab reopen).
 */
import { useEffect, useState } from "react";

export function SwUpdateBanner() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let registration: ServiceWorkerRegistration | null = null;
    let unsubUpdatefound: (() => void) | null = null;
    let unsubStatechange: (() => void) | null = null;

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      registration = reg;

      // If a worker is ALREADY waiting when we mount, surface
      // immediately — common on subsequent page loads after a new SW
      // finished installing in an earlier tab.
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaiting(reg.waiting);
      }

      const onUpdatefound = () => {
        const installing = reg.installing;
        if (!installing) return;
        const onStatechange = () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            // A new worker finished installing while an older one is
            // still controlling the page — the new one is now in
            // `waiting`. Surface the banner.
            setWaiting(installing);
          }
        };
        installing.addEventListener("statechange", onStatechange);
        unsubStatechange = () => installing.removeEventListener("statechange", onStatechange);
      };
      reg.addEventListener("updatefound", onUpdatefound);
      unsubUpdatefound = () => reg.removeEventListener("updatefound", onUpdatefound);
    }).catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      unsubUpdatefound?.();
      unsubStatechange?.();
    };
  }, []);

  if (!waiting) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-100 shadow-lg"
    >
      <span>A new version is ready.</span>
      <button
        type="button"
        onClick={() => {
          // Tell the waiting SW to activate; the controllerchange
          // listener then reloads the page.
          waiting.postMessage({ type: "SKIP_WAITING" });
        }}
        className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setWaiting(null)}
        className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 hover:text-white"
        aria-label="Dismiss"
      >
        Later
      </button>
    </div>
  );
}
