'use client';

import { useEffect } from 'react';
import { safeErr } from '@/lib/logging/safe-err';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // R42-G: log via safeErr. Top-level boundary — any PG DETAIL / bound-
  // param leak elsewhere gets redacted at the outermost layer. User-
  // facing message is already generic.
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'global_error_boundary',
        digest: error.digest,
        error: safeErr(error),
      }),
    );
  }, [error]);

  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#fef2f2',
        color: '#991b1b',
      }}>
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#7f1d1d', marginBottom: '1.5rem' }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: '#991b1b',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
