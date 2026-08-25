'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { safeErr } from '@/lib/logging/safe-err';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  // R42-G: log via safeErr so PG DETAIL / stack frames can't leak into
  // Worker logs; NEVER render error.message to the user.
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'client_error_boundary',
        section: 'admin-root',
        digest: error.digest,
        // error.name is structurally safe (e.g. "Error", "TypeError")
        // and useful in logs for triaging the underlying class.
        error_name: error.name,
        error: safeErr(error),
      }),
    );
  }, [error]);

  // Track whether reset() actually recovered. If the user clicks "Try
  // again" and the same render still crashes (which is the case when
  // the error is in a server component the boundary can't re-render),
  // we offer "Reload page" as the escape hatch.
  const [resetAttempts, setResetAttempts] = useState(0);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f8fafc',
      padding: '2rem',
    }}>
      <div style={{
        textAlign: 'center',
        maxWidth: '32rem',
        padding: '2rem',
        background: 'white',
        borderRadius: '1rem',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⚠️</div>
        <h1 style={{ fontSize: '1.25rem', color: '#1e293b', marginBottom: '0.5rem' }}>
          Admin Error
        </h1>
        <p style={{ color: '#64748b', marginBottom: '1rem', fontSize: '0.875rem' }}>
          {resetAttempts === 0
            ? 'Something went wrong in the admin panel. Please try again.'
            : 'Still failing. Reload the page or sign out and back in. If this keeps happening, share the reference below with support.'}
        </p>
        {error.digest ? (
          <p style={{ color: '#94a3b8', marginBottom: '1.5rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
            Reference: {error.digest}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => {
              setResetAttempts((n) => n + 1);
              reset();
            }}
            style={{
              padding: '0.625rem 1.25rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#2563eb',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {resetAttempts > 0 ? (
            <>
              <button
                onClick={() => { window.location.reload(); }}
                style={{
                  padding: '0.625rem 1.25rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #2563eb',
                  background: 'white',
                  color: '#2563eb',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reload page
              </button>
              <button
                onClick={() => { router.push('/admin'); }}
                style={{
                  padding: '0.625rem 1.25rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #94a3b8',
                  background: 'white',
                  color: '#475569',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Back to dashboard
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
