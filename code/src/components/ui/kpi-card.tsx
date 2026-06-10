import React from "react";

/**
 * Shared KPI / summary tile — the single, consistent "stat card" used
 * across every admin page (Dashboard, Products, Inventory, Customers, …).
 *
 * Fluent/enterprise styling: clean white (panel) surface, 1px neutral
 * border, subtle elevation that lifts on hover, an uppercase tracked
 * label, and a large neutral-dark tabular-nums value. The accent stays
 * reserved for interactive elements — KPI values are neutral by default
 * so the dashboards read calm and professional rather than a wall of
 * coloured numbers.
 *
 * `tone` keeps STATUS semantics where they matter: Low-Stock tiles use
 * `warn` (amber value) and Out-of-Stock use `alert` (red value), while
 * the card chrome stays identical so the grid still looks uniform. The
 * neutral utility classes (bg-white / text-gray-900 / border-gray-200)
 * are remapped for dark mode by the global overrides in globals.css, so
 * this one component is correct in both themes.
 */
export type KpiTone = "default" | "accent" | "warn" | "alert";

const TONE_VALUE_CLASS: Record<KpiTone, string> = {
  default: "text-gray-900",
  accent: "text-[var(--surface-accent)]",
  warn: "text-amber-600",
  alert: "text-red-600",
};

export function KpiCard({
  label,
  value,
  tone = "default",
  delta,
  deltaLabel = "vs prior period",
}: {
  label: string;
  value: React.ReactNode;
  tone?: KpiTone;
  /** Percent change vs the prior period; null = no baseline (shows an em dash). */
  delta?: number | null;
  deltaLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${TONE_VALUE_CLASS[tone]}`}>
        {value}
      </p>
      {delta !== undefined && (
        <p className="mt-1.5 text-xs tabular-nums text-gray-500">
          {delta === null ? (
            <span>— {deltaLabel}</span>
          ) : (
            <>
              <span className={`font-semibold ${delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-gray-500"}`}>
                {delta > 0 ? "▲" : delta < 0 ? "▼" : "■"} {Math.abs(delta).toFixed(1)}%
              </span>{" "}
              {deltaLabel}
            </>
          )}
        </p>
      )}
    </div>
  );
}
