"use client";

import { useState, useTransition } from "react";
import { reviewFlagAction, runFlagEngineAction } from "@/app/admin/behavior-actions";
import type { EmployeeBehaviorFlag, Employee, BehaviorFlagSeverity } from "@/lib/domain/types";

type FilterKey = "all" | "unreviewed" | "low" | "medium" | "high";

const SEVERITY_COLORS: Record<BehaviorFlagSeverity, string> = {
  low: "bg-yellow-50 text-yellow-800 border-yellow-200",
  medium: "bg-orange-50 text-orange-800 border-orange-200",
  high: "bg-red-50 text-red-800 border-red-200",
};

const SEVERITY_BADGE: Record<BehaviorFlagSeverity, string> = {
  low: "bg-yellow-100 text-yellow-800",
  medium: "bg-orange-100 text-orange-800",
  high: "bg-red-100 text-red-800",
};

export function BehaviorDashboard({
  flags,
  employees,
}: {
  flags: EmployeeBehaviorFlag[];
  employees: Employee[];
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [isPending, startTransition] = useTransition();
  const [scanResult, setScanResult] = useState<string | null>(null);

  const empMap = new Map(employees.map((e) => [e.id, e]));

  const filtered = flags.filter((f) => {
    if (filter === "unreviewed" && f.isReviewed) return false;
    if (filter === "low" && f.severity !== "low") return false;
    if (filter === "medium" && f.severity !== "medium") return false;
    if (filter === "high" && f.severity !== "high") return false;
    if (employeeFilter !== "all" && f.employeeId !== employeeFilter) return false;
    return true;
  });

  const unreviewedCount = flags.filter((f) => !f.isReviewed).length;
  const highCount = flags.filter((f) => f.severity === "high" && !f.isReviewed).length;
  const mediumCount = flags.filter((f) => f.severity === "medium" && !f.isReviewed).length;
  const lowCount = flags.filter((f) => f.severity === "low" && !f.isReviewed).length;

  // Unique flagged employees
  const flaggedEmployeeIds = [...new Set(flags.map((f) => f.employeeId))];

  function handleScanNow() {
    startTransition(async () => {
      const result = await runFlagEngineAction();
      setScanResult(`Scan complete: ${result.generated} new flag(s) generated.`);
    });
  }

  function handleReview(flagId: string) {
    startTransition(async () => {
      await reviewFlagAction(flagId, reviewNotes);
      setReviewingId(null);
      setReviewNotes("");
    });
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="Total flags" value={flags.length} />
        <SummaryCard label="Unreviewed" value={unreviewedCount} color={unreviewedCount > 0 ? "text-amber-700" : undefined} />
        <SummaryCard label="High severity" value={highCount} color={highCount > 0 ? "text-red-700" : undefined} />
        <SummaryCard label="Flagged employees" value={flaggedEmployeeIds.length} />
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleScanNow}
          disabled={isPending}
          className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {isPending ? "Scanning..." : "Run behavior scan"}
        </button>

        {scanResult && (
          <p className="rounded-2xl bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{scanResult}</p>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {(["all", "unreviewed", "high", "medium", "low"] as FilterKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              filter === key
                ? "bg-zinc-900 text-white"
                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            }`}
          >
            {key === "all" ? "All" : key === "unreviewed" ? `Unreviewed (${unreviewedCount})` : `${key.charAt(0).toUpperCase() + key.slice(1)} (${key === "high" ? highCount : key === "medium" ? mediumCount : lowCount})`}
          </button>
        ))}

        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          className="rounded-full border border-zinc-300 px-3 py-1 text-xs"
        >
          <option value="all">All employees</option>
          {flaggedEmployeeIds.map((id) => {
            const emp = empMap.get(id);
            return (
              <option key={id} value={id}>
                {emp?.displayName ?? id}
              </option>
            );
          })}
        </select>
      </div>

      {/* Flag list */}
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500">
          {flags.length === 0
            ? "No behavior flags yet. Click \"Run behavior scan\" to analyze employee activity."
            : "No flags match current filters."}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((flag) => {
            const emp = empMap.get(flag.employeeId);
            return (
              <div
                key={flag.id}
                className={`rounded-xl border px-4 py-3 ${flag.isReviewed ? "border-zinc-200 bg-zinc-50 opacity-60" : SEVERITY_COLORS[flag.severity]}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_BADGE[flag.severity]}`}>
                        {flag.severity}
                      </span>
                      <h4 className="text-sm font-semibold">{flag.title}</h4>
                    </div>
                    <p className="mt-1 text-sm">{flag.description}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {emp?.displayName ?? "Unknown"} · {flag.flagType.replace(/_/g, " ")} · {new Date(flag.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {flag.isReviewed ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">Reviewed</span>
                    ) : reviewingId === flag.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={reviewNotes}
                          onChange={(e) => setReviewNotes(e.target.value)}
                          placeholder="Notes (optional)"
                          className="w-36 rounded-xl border border-zinc-300 px-2 py-1 text-xs"
                        />
                        <button
                          onClick={() => handleReview(flag.id)}
                          disabled={isPending}
                          className="rounded-xl bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => { setReviewingId(null); setReviewNotes(""); }}
                          className="text-xs text-zinc-500"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setReviewingId(flag.id)}
                        className="rounded-xl border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                      >
                        Review
                      </button>
                    )}
                  </div>
                </div>
                {flag.isReviewed && flag.reviewNotes && (
                  <p className="mt-2 text-xs text-zinc-500 italic">Review: {flag.reviewNotes}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color ?? ""}`}>{value}</p>
    </div>
  );
}
