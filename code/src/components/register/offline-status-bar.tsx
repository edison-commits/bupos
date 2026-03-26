"use client";

import { useState, useEffect, useCallback } from "react";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { getPendingCount } from "@/lib/offline/idb-store";
import { syncPendingTransactions } from "@/lib/offline/sync-service";

export function OfflineStatusBar() {
  const { isOnline, checkConnectivity } = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Poll pending count
  useEffect(() => {
    if (typeof window === "undefined" || !("indexedDB" in window)) return;

    const check = () => {
      getPendingCount().then(setPendingCount).catch(() => {});
    };
    check();
    const interval = setInterval(check, 5_000);
    return () => clearInterval(interval);
  }, []);

  // Auto-sync when coming back online
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !syncing) {
      handleSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, pendingCount]);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);

    try {
      const result = await syncPendingTransactions();
      if (result.synced > 0) {
        setSyncResult(`Synced ${result.synced} transaction${result.synced > 1 ? "s" : ""}`);
      }
      if (result.failed > 0) {
        setSyncResult((prev) =>
          (prev ? prev + ". " : "") + `${result.failed} failed — will retry`,
        );
      }
      setPendingCount(result.remaining);
    } catch {
      setSyncResult("Sync error — will retry");
    } finally {
      setSyncing(false);
      // Clear result message after 5s
      setTimeout(() => setSyncResult(null), 5_000);
    }
  }, [syncing]);

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
