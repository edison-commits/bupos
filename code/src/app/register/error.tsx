'use client';

export default function RegisterError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
      color: '#e2e8f0',
      padding: '2rem',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '28rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔌</div>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
          Register Error
        </h1>
        <p style={{ color: '#94a3b8', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
          {error.message || 'The register encountered an error. Please try again.'}
        </p>
        <button
          onClick={reset}
          style={{
            padding: '0.75rem 1.5rem',
            borderRadius: '0.75rem',
            border: 'none',
            background: '#3b82f6',
            color: 'white',
            fontSize: '1rem',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Restart Register
        </button>
      </div>
    </div>
  );
}
