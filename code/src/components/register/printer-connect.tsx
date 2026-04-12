/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useCallback, useRef, useImperativeHandle, forwardRef } from "react";

export interface PrinterHandle {
  print: (data: Uint8Array) => Promise<boolean>;
  isConnected: boolean;
}

export const PrinterConnect = forwardRef<PrinterHandle>(function PrinterConnect(_, ref) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<any>(null);
  const writerRef = useRef<any>(null);

  const connect = useCallback(async () => {
    if (!("serial" in navigator)) {
      setError("Web Serial API not supported in this browser. Use Chrome or Edge.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      const writer = port.writable.getWriter();
      writerRef.current = writer;
      setConnected(true);
    } catch (e: any) {
      if (e.name !== "NotFoundError") { // User cancelled
        setError(e.message ?? "Failed to connect");
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      if (writerRef.current) {
        writerRef.current.releaseLock();
        writerRef.current = null;
      }
      if (portRef.current) {
        await portRef.current.close();
        portRef.current = null;
      }
    } catch {
      // ignore
    }
    setConnected(false);
  }, []);

  const print = useCallback(async (data: Uint8Array): Promise<boolean> => {
    if (!writerRef.current) return false;
    try {
      await writerRef.current.write(data);
      return true;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  useImperativeHandle(ref, () => ({
    print,
    isConnected: connected,
  }), [print, connected]);

  return (
    <div className="flex items-center gap-2">
      {connected ? (
        <>
          <span className="flex items-center gap-1.5 text-sm text-emerald-700">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            Printer connected
          </span>
          <button
            type="button"
            onClick={disconnect}
            className="rounded-lg bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200"
          >
            Disconnect
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={connect}
          disabled={connecting}
          className="touch-button rounded-xl bg-zinc-100 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
        >
          {connecting ? "Connecting…" : "Connect printer"}
        </button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
});
