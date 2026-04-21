"use client";

import { useEffect } from "react";

/**
 * Shared error boundary UI used by every admin subroute's error.tsx.
 * Logs the digest (for cross-referencing with server logs) and renders
 * a "Try again" button tied to Next's reset() callback.
 */
export function AdminErrorBoundary({
  error,
  reset,
  section,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  section?: string;
}) {
  useEffect(() => {
    // Log to console so ops can correlate the digest with server-side logs.
    // The browser's own error reporter also captures this.
    console.error("[admin-error]", {
      section: section ?? "admin",
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error, section]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-bold text-zinc-800">Something went wrong</h2>
      <p className="text-sm text-zinc-500">
        {error.message || "An unexpected error occurred."}
      </p>
      {error.digest ? (
        <p className="text-xs text-zinc-400 font-mono">Digest: {error.digest}</p>
      ) : null}
      <button
        onClick={reset}
        className="rounded-2xl bg-zinc-900 px-5 py-3 text-sm font-bold text-white hover:bg-zinc-800"
      >
        Try again
      </button>
    </div>
  );
}
