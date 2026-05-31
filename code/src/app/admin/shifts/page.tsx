'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";
import { useState, useEffect } from "react";
import { formatDateTime } from "@/lib/utils/date";
import Link from "next/link";
import { authFetch } from '@/lib/api/client';
import { formatCurrency } from "@/lib/format";

type ShiftStatus = "open" | "closed";

interface ShiftSummary {
  id: string;
  employeeId: string;
  employeeName: string;
  // SHIFTS-LOC-FIX: owners/managers now see shifts across ALL locations,
  // so each row shows which location it belongs to.
  locationName?: string;
  openedAt: string;
  closedAt: string | null;
  status: ShiftStatus;
  openingFloat: number;
  expectedCash: number | null;
  declaredCash: number | null;
  variance: number | null;
}

interface ShiftsResponse {
  shifts: ShiftSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
];

// Local-time today as YYYY-MM-DD (NOT UTC). The prior shape used
// `new Date().toISOString().slice(0, 10)` which returns a UTC date.
// In Pacific TZ at evening, the UTC date is already TOMORROW — so
// the page defaulted to a future date, surfaced "Failed to load
// shifts" in tomorrow's empty range, and a manager looking for
// today's shifts had to manually pick a date. Compute in local TZ
// so the default actually matches "today" as the cashier sees it.
function getLocalToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function ShiftsPage() {
  const [shifts, setShifts] = useState<ShiftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Default to "all dates" (empty filter) — the API returns ALL shifts
  // when no date is set, which is more useful than locking the page
  // to today's empty range. Users can filter to a specific date via
  // the date input. Picking a date lets them narrow down.
  const [dateFilter, setDateFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    loadShifts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, dateFilter, page]);

  async function loadShifts() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: page.toString(),
        pageSize: pageSize.toString(),
      });
      if (dateFilter) params.set("date", dateFilter);

      const res = await authFetch(`/api/shifts?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load shifts");
      const data: ShiftsResponse = await res.json();
      setShifts(data.shifts);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function handleStatusChange(status: string) {
    setStatusFilter(status);
    setPage(1);
  }

  function handleDateChange(d: string) {
    setDateFilter(d);
    setPage(1);
  }

  const totalPages = Math.ceil(total / pageSize);

  function varianceLabel(v: number | null) {
    if (v === null) return "—";
    if (v === 0) return "$0.00";
    const abs = Math.abs(v);
    const label = v > 0 ? `over ${formatCurrency(abs)}` : `short ${formatCurrency(abs)}`;
    return label;
  }

  function varianceClass(v: number | null) {
    if (v === null || v === 0) return "text-zinc-500";
    return v > 0 ? "text-teal-600 font-semibold" : "text-red-600 font-semibold";
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <AdminTopNav />

      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">Shifts</h1>
            <p className="text-sm text-zinc-500 mt-1">
              {total > 0 ? `${total} shift${total !== 1 ? "s" : ""}` : "No shifts"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => handleDateChange(e.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Filters */}
        <div className="mb-4 flex gap-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleStatusChange(tab.key)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                statusFilter === tab.key
                  ? "bg-zinc-900 text-white"
                  : "bg-white text-zinc-600 hover:bg-zinc-100 border border-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50">
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Employee</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Location</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Opened</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Closed</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Status</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Float</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Expected</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Declared</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600 whitespace-nowrap">Variance</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-zinc-100 last:border-0">
                      {Array.from({ length: 10 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 w-24 rounded bg-zinc-100 animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : shifts.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-zinc-400">
                      No shifts found
                    </td>
                  </tr>
                ) : (
                  shifts.map((shift) => (
                    <tr
                      key={shift.id}
                      className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-zinc-900 whitespace-nowrap">
                        {shift.employeeName}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 whitespace-nowrap">
                        {shift.locationName || "—"}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 whitespace-nowrap">
                        {formatDateTime(shift.openedAt)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 whitespace-nowrap">
                        {shift.closedAt ? formatDateTime(shift.closedAt) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                            shift.status === "open"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-zinc-100 text-zinc-600"
                          }`}
                        >
                          {shift.status === "open" ? "● Open" : "Closed"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-700 whitespace-nowrap">
                        {formatCurrency(shift.openingFloat)}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-700 whitespace-nowrap">
                        {shift.expectedCash !== null ? formatCurrency(shift.expectedCash) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-700 whitespace-nowrap">
                        {shift.declaredCash !== null ? formatCurrency(shift.declaredCash) : "—"}
                      </td>
                      <td className={`px-4 py-3 text-right whitespace-nowrap ${varianceClass(shift.variance)}`}>
                        {varianceLabel(shift.variance)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/shift-close?shift=${shift.id}`}
                          className="touch-button inline-block rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 transition-colors"
                        >
                          {shift.status === "open" ? "Close" : "View"}
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3">
              <span className="text-sm text-zinc-500">
                Page {page} of {totalPages} &nbsp;·&nbsp; {total} total
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="touch-button rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="touch-button rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
