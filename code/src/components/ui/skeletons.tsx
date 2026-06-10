/**
 * Shared loading skeletons (animate-pulse) so list pages show structured
 * placeholders instead of "Loading…" text. Theme-aware via surface tokens.
 */

function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ background: "var(--surface-panel-muted)" }}
    />
  );
}

/** N stacked row placeholders — for tables/lists. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 rounded-lg border px-4 py-3"
          style={{ borderColor: "var(--border-subtle)", background: "var(--surface-panel)" }}
        >
          <Bar className="h-4 w-1/3" />
          <Bar className="h-4 w-1/5" />
          <Bar className="h-4 flex-1" />
          <Bar className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** N KPI-card placeholders — for dashboard/summary strips. */
export function CardSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="status" aria-label="Loading">
      {Array.from({ length: cards }, (_, i) => (
        <div
          key={i}
          className="rounded-lg border p-4"
          style={{ borderColor: "var(--border-subtle)", background: "var(--surface-panel)" }}
        >
          <Bar className="h-3 w-16" />
          <Bar className="mt-2 h-6 w-24" />
        </div>
      ))}
    </div>
  );
}
