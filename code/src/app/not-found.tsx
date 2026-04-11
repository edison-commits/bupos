import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4" style={{ background: "var(--surface-app)" }}>
      <div className="flex flex-col items-center text-center">
        {/* BUPOS logo */}
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600">
          <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>

        <h1 className="text-4xl font-bold" style={{ color: "var(--text-primary)" }}>Page not found</h1>
        <p className="mt-2 max-w-sm text-sm" style={{ color: "var(--text-secondary)" }}>
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>

        <Link
          href="/"
          className="mt-8 inline-flex items-center justify-center rounded-2xl bg-teal-600 px-6 py-3 text-sm font-bold text-white hover:bg-teal-700 transition-colors"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
