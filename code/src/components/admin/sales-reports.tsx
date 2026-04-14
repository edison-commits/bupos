"use client";

import { useState, useMemo } from "react";
import type { LocalStoreData } from "@/lib/persistence/types";

type DateRange = "today" | "7d" | "30d" | "all";

export function SalesReports({ store }: { store: LocalStoreData }) {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [hourStart, setHourStart] = useState(0);
  const [hourEnd, setHourEnd] = useState(23);

  const filteredTransactions = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let cutoffDate: Date;

    switch (dateRange) {
      case "today":
        cutoffDate = startOfToday;
        break;
      case "7d":
        cutoffDate = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "30d":
        cutoffDate = new Date(startOfToday.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case "all":
        cutoffDate = new Date(0);
        break;
    }

    return (store.transactionEventPlaceholders ?? []).filter((event) => {
      if (event.eventKind !== "transaction_placeholder") return false;
      if (!event.createdAt) return false;
      const eventDate = new Date(event.createdAt);
      return eventDate >= cutoffDate;
    });
  }, [store.transactionEventPlaceholders, dateRange]);

  const transactionIds = useMemo(
    () => new Set(filteredTransactions.map((t) => t.transactionId)),
    [filteredTransactions]
  );

  const tendersByType = useMemo(() => {
    const grouped: Record<string, number> = {};
    (store.transactionTenderPlaceholders ?? []).forEach((tender) => {
      if (transactionIds.has(tender.transactionId)) {
        grouped[tender.tenderType] = (grouped[tender.tenderType] || 0) + tender.amount;
      }
    });
    return grouped;
  }, [store.transactionTenderPlaceholders, transactionIds]);

  const salesByEmployee = useMemo(() => {
    const grouped: Record<string, { total: number; count: number }> = {};
    filteredTransactions.forEach((event) => {
      const employeeId = event.actorEmployeeId;
      const grand_total = parseFloat(event.payload?.grand_total || "0");
      if (!grouped[employeeId]) {
        grouped[employeeId] = { total: 0, count: 0 };
      }
      grouped[employeeId].total += grand_total;
      grouped[employeeId].count += 1;
    });
    return grouped;
  }, [filteredTransactions]);

  const salesByHour = useMemo(() => {
    const hourly: number[] = new Array(24).fill(0);
    filteredTransactions.forEach((event) => {
      const date = new Date(event.createdAt);
      const hour = date.getHours();
      const grand_total = parseFloat(event.payload?.grand_total || "0");
      hourly[hour] += grand_total;
    });
    return hourly;
  }, [filteredTransactions]);

  const periodOverview = useMemo(() => {
    let totalSales = 0;
    let totalReturns = 0;
    let totalTax = 0;
    let transactionCount = 0;

    filteredTransactions.forEach((event) => {
      const grand_total = parseFloat(event.payload?.grand_total || "0");
      const is_return = event.payload?.is_return === "true";
      const tax_total = parseFloat(event.payload?.tax_total || "0");

      if (is_return) {
        totalReturns += grand_total;
      } else {
        totalSales += grand_total;
      }
      totalTax += tax_total;
      transactionCount += 1;
    });

    return {
      totalSales,
      totalReturns,
      netSales: totalSales - totalReturns,
      totalTax,
      transactionCount,
      avgTicket: transactionCount > 0 ? (totalSales - totalReturns) / transactionCount : 0,
    };
  }, [filteredTransactions]);

  // Memoize tenderMap so it's not rebuilt on every render
  const tenderMap = useMemo(() => {
    const m = new Map<string, string[]>();
    (store.transactionTenderPlaceholders ?? []).forEach((tender) => {
      if (transactionIds.has(tender.transactionId)) {
        if (!m.has(tender.transactionId)) m.set(tender.transactionId, []);
        m.get(tender.transactionId)!.push(tender.tenderType);
      }
    });
    return m;
  }, [store.transactionTenderPlaceholders, transactionIds]);

  const handleExportCSV = () => {
    const rows: string[] = [];
    rows.push("Date,Time,Transaction ID,Employee,Total,Tax,Tender Type,Is Return");

    filteredTransactions.forEach((event) => {
      const date = new Date(event.createdAt);
      const dateStr = date.toISOString().split("T")[0];
      const timeStr = date.toTimeString().split(" ")[0];
      const employee = (store.employees ?? []).find((e) => e.id === event.actorEmployeeId);
      const employeeName = employee?.displayName || "Unknown";
      const grand_total = event.payload?.grand_total || "0";
      const tax_total = event.payload?.tax_total || "0";
      const is_return = event.payload?.is_return === "true" ? "Yes" : "No";
      const tenders = tenderMap.get(event.transactionId) || ["Unknown"];

      tenders.forEach((tenderType) => {
        rows.push(`${dateStr},${timeStr},${event.transactionId},${employeeName},${grand_total},${tax_total},${tenderType},${is_return}`);
      });
    });

    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-report-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const maxHourlySales = Math.max(...salesByHour, 1);
  const maxTenderAmount = Math.max(...Object.values(tendersByType), 1);
  const employeeIds = Object.keys(salesByEmployee).sort(
    (a, b) => salesByEmployee[b].total - salesByEmployee[a].total
  );

  return (
    <div className="space-y-6">
      {/* Date Range Filter */}
      <div className="flex gap-2">
        {(["today", "7d", "30d", "all"] as const).map((range) => (
          <button
            key={range}
            onClick={() => setDateRange(range)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              dateRange === range
                ? "bg-teal-600 text-white"
                : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {range === "today" && "Today"}
            {range === "7d" && "Last 7 Days"}
            {range === "30d" && "Last 30 Days"}
            {range === "all" && "All Time"}
          </button>
        ))}
      </div>

      {/* Period Overview */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Period Overview</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard label="Total Sales" value={formatCurrency(periodOverview.totalSales)} />
          <MetricCard label="Returns" value={formatCurrency(periodOverview.totalReturns)} />
          <MetricCard label="Net Sales" value={formatCurrency(periodOverview.netSales)} highlight />
          <MetricCard label="Transactions" value={String(periodOverview.transactionCount)} />
          <MetricCard label="Avg Ticket" value={formatCurrency(periodOverview.avgTicket)} />
        </div>
      </div>

      {/* Sales by Tender Type */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">Sales by Tender Type</h3>
        <div className="space-y-3">
          {Object.entries(tendersByType).map(([tenderType, amount]) => (
            <div key={tenderType}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm text-zinc-700">{tenderType}</span>
                <span className="font-semibold text-teal-700">{formatCurrency(amount)}</span>
              </div>
              <div className="h-4 rounded-full bg-zinc-200">
                <div
                  className="h-full rounded-full bg-teal-600"
                  style={{ width: `${(amount / maxTenderAmount) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sales by Employee */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">Sales by Employee</h3>
        <div className="space-y-3">
          {employeeIds.length === 0 ? (
            <p className="text-sm text-zinc-500">No sales data available</p>
          ) : (
            employeeIds.map((employeeId) => {
              const employee = (store.employees ?? []).find((e) => e.id === employeeId);
              const data = salesByEmployee[employeeId];
              const avgTicket = data.count > 0 ? data.total / data.count : 0;
              return (
                <div key={employeeId} className="rounded-lg border border-zinc-200 bg-white p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-zinc-900">{employee?.displayName || "Unknown"}</span>
                    <span className="font-bold text-teal-700">{formatCurrency(data.total)}</span>
                  </div>
                  <div className="flex gap-6 text-xs text-zinc-600">
                    <span>Transactions: {data.count}</span>
                    <span>Avg Ticket: {formatCurrency(avgTicket)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Hourly Sales Distribution */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Hourly Sales Distribution</h3>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-zinc-600">
              From
              <select
                value={hourStart}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setHourStart(val);
                  if (val > hourEnd) setHourEnd(val);
                }}
                className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-800"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHourLabel(i)}</option>
                ))}
              </select>
            </label>
            <span className="text-zinc-400">—</span>
            <label className="flex items-center gap-1.5 text-sm text-zinc-600">
              To
              <select
                value={hourEnd}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setHourEnd(val);
                  if (val < hourStart) setHourStart(val);
                }}
                className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-800"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHourLabel(i)}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => { setHourStart(0); setHourEnd(23); }}
              className="ml-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-50 transition-colors"
              title="Reset to full day"
            >
              Reset
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {salesByHour.map((amount, hour) => {
            if (hour < hourStart || hour > hourEnd) return null;
            return (
              <div key={hour}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="w-16 text-xs font-medium text-zinc-600">{formatHourLabel(hour)}</span>
                  <span className="flex-1 text-right text-xs font-semibold text-teal-700">{formatCurrency(amount)}</span>
                </div>
                <div className="h-4 rounded-full bg-zinc-200">
                  <div
                    className="h-full rounded-full bg-teal-600"
                    style={{ width: `${(amount / maxHourlySales) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {/* Range total */}
        <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-3">
          <span className="text-xs font-semibold text-zinc-500">
            Total ({formatHourLabel(hourStart)} – {formatHourLabel(hourEnd)})
          </span>
          <span className="text-sm font-bold text-teal-700">
            {formatCurrency(salesByHour.slice(hourStart, hourEnd + 1).reduce((sum, v) => sum + v, 0))}
          </span>
        </div>
      </div>

      {/* Export Button */}
      <button
        onClick={handleExportCSV}
        className="w-full rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
      >
        Export to CSV
      </button>
    </div>
  );
}

function MetricCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-teal-700" : "text-zinc-900"}`}>{value}</p>
    </div>
  );
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}
