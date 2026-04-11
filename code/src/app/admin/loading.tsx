export default function Loading() {
  return (
    <div className="flex min-h-screen" style={{ background: "var(--surface-app)" }}>
      {/* Sidebar skeleton */}
      <div className="hidden w-56 shrink-0 flex-col gap-4 p-4 md:flex" style={{ background: "var(--surface-panel)", borderRight: "1px solid var(--border-subtle)" }}>
        {/* Logo placeholder */}
        <div className="mb-4 h-8 w-28 animate-pulse rounded-lg" style={{ background: "var(--border-subtle)" }} />
        {/* Nav items */}
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg" style={{ background: "var(--border-subtle)", width: `${70 + ((i * 13) % 30)}%` }} />
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 p-6 md:p-8">
        {/* Header skeleton */}
        <div className="mb-8 h-8 w-48 animate-pulse rounded-lg" style={{ background: "var(--border-subtle)" }} />

        {/* Stat cards */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-2xl p-5" style={{ background: "var(--surface-panel)", boxShadow: "var(--shadow-card)" }}>
              <div className="h-4 w-20 animate-pulse rounded" style={{ background: "var(--border-subtle)" }} />
              <div className="h-7 w-24 animate-pulse rounded" style={{ background: "var(--border-subtle)" }} />
            </div>
          ))}
        </div>

        {/* Table/list skeleton */}
        <div className="flex flex-col gap-3 rounded-2xl p-5" style={{ background: "var(--surface-panel)", boxShadow: "var(--shadow-card)" }}>
          <div className="mb-2 h-5 w-32 animate-pulse rounded" style={{ background: "var(--border-subtle)" }} />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg" style={{ background: "var(--surface-panel-muted)" }} />
          ))}
        </div>
      </div>
    </div>
  );
}
