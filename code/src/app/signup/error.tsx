"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function SignupError({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[signup-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100">
          <svg className="h-7 w-7 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="mb-2 text-2xl font-bold text-zinc-900">Signup error</h1>
        <p className="mb-6 text-sm text-zinc-500">
          An error occurred during signup. Please try again.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
