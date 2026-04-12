"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * React hook that tracks online/offline status with active server ping.
 * Uses both navigator.onLine and a periodic connectivity check.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof window === "undefined") return true;
    return navigator.onLine;
  });
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  // Check actual server reachability (not just browser online flag)
  const checkConnectivity = useCallback(async () => {
    try {
      const res = await fetch(`/api/health?_t=${Date.now()}`, {
        method: "HEAD",
        cache: "no-store",
      });
      const online = res.ok;
      setIsOnline(online);
      setLastChecked(new Date().toISOString());
      return online;
    } catch {
      setIsOnline(false);
      setLastChecked(new Date().toISOString());
      return false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => {
      setIsOnline(true);
      checkConnectivity();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Periodic connectivity check every 30 seconds
    const interval = setInterval(checkConnectivity, 30_000);
    // Initial server check
    checkConnectivity();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(interval);
    };
  }, [checkConnectivity]);

  return { isOnline, lastChecked, checkConnectivity };
}
