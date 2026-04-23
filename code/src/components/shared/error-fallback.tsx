"use client";

import { useEffect } from "react";
import { safeErr } from "@/lib/logging/safe-err";

/**
 * R42-G: shared error-boundary fallback UI. Never renders `error.message`
 * to the user — server-thrown messages may carry internal IDs, SKUs,
 * PG DETAIL strings, or untrusted input. The user sees a generic
 * message + an opaque digest for ops correlation; the raw error is
 * logged via `safeErr` so PG bound-params and stack frames can't leak
 * into Worker logs.
 *
 * Every app/.../error.tsx in this repo should use this component.
 */
export function ErrorFallback({
  error,
  reset,
  section,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  section?: string;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "client_error_boundary",
        section: section ?? "unknown",
        digest: error.digest,
        error: safeErr(error),
      }),
    );
  }, [error, section]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-bold text-zinc-800">Something went wrong</h2>
      <p className="text-sm text-zinc-500">
        An unexpected error occurred. Please try again.
      </p>
      {error.digest ? (
        <p className="text-xs text-zinc-400 font-mono">Reference: {error.digest}</p>
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
