"use client";

import { useMemo, useRef } from "react";
import type { LocalStoreData } from "@/lib/persistence/types";

interface ZReportProps {
  store: LocalStoreData;
  locationId: string;
}

export function ZReport({ store, locationId }: ZReportProps) {
  const printRef = useRef<HTMLDivElement>(null);

  const report = useMemo(() => {
    const location = store.locations.find((l) => l.id === locationId);
    const today = new Date().toISOString().slice(0, 10);

    // Filter today's transaction events (sales + returns)
    const todayTxns = (store.transactionEventPlaceholders ?? []).filter((e) => {
      if (e.eventKind !== "transaction_placeholder") return false;
      if (!e.payload?.grand_total) return false;
      if (e.transactionId === "txn_register_shift_placeholder" || e.transactionId === "txn_inventory_placeholder") return false;
      if (e.payload?.location_id && e.payload.location_id !== locationId) return false;
      return e.createdAt?.startsWith(today);
    });

    const sales = todayTxns.filter((e) => e.payload?.is_return !== "true");
    const returns = todayTxns.filter((e) => e.payload?.is_return === "true");

    const grossSales = sales.reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
    const totalReturns = returns.reduce((s, e) => s + Math.abs(Number(e.payload?.grand_total ?? 0)), 0);
    const netSales = grossSales - totalReturns;
    const txnCount = sales.length;
    const returnCount = returns.length;
    const avgTicket = txnCount > 0 ? grossSales / txnCount : 0;

    // Tender breakdown (today only)
    const todayTxnIds = new Set(todayTxns.map((e) => e.transactionId));
    const todayTenders = (store.transactionTenderPlaceholders ?? []).filter((t) => todayTxnIds.has(t.transactionId));
    const tenderMap = new Map<string, { total: number; count: number }>();
    for (const t of todayTenders) {
      const existing = tenderMap.get(t.tenderType) ?? { total: 0, count: 0 };
      existing.total += t.amount;
      existing.count += 1;
      tenderMap.set(t.tenderType, existing);
    }

    // Cash accountability
    const todayShifts = (store.shifts ?? []).filter((s) => s.openedAt?.startsWith(today));
    const closedShifts = todayShifts.filter((s) => s.status === "closed");
    const openShifts = todayShifts.filter((s) => s.status === "open");
    const totalOpeningFloat = todayShifts.reduce((s, sh) => s + sh.openingFloat, 0);
    const totalVariance = closedShifts.reduce((s, sh) => s + (sh.closingVariance ?? 0), 0);

    // Pay in/out today
    const todayShiftIds = new Set(todayShifts.map((s) => s.id));
    const todayPayInOuts = (store.payInOuts ?? []).filter((p) => todayShiftIds.has(p.shiftId));
    const totalPayIn = todayPayInOuts.filter((p) => p.direction === "pay_in").reduce((s, p) => s + p.amount, 0);
    const totalPayOut = todayPayInOuts.filter((p) => p.direction === "pay_out").reduce((s, p) => s + p.amount, 0);

    // Voids today
    const todayVoids = (store.transactionEventPlaceholders ?? []).filter((e) =>
      (e.eventKind === "cart_voided" as string) && e.createdAt?.startsWith(today),
    );

    // Exceptions today
    const todayExceptions = (store.transactionExceptionPlaceholders ?? []).filter((e) =>
      todayTxnIds.has(e.transactionId) || todayTxnIds.has(e.transactionId.replace("pending_", "")),
    );

    // Top items by revenue
    const itemRevenue = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const e of sales) {
      const itemCountStr = e.payload?.item_count ?? "0";
      const grandTotal = Number(e.payload?.grand_total ?? 0);
      const itemCount = Number(itemCountStr);
      // Aggregate at the transaction level since we don't have line-item detail in events
      const key = e.transactionId;
      itemRevenue.set(key, { name: `Txn #${e.transactionId.slice(0, 8)}`, quantity: itemCount, revenue: grandTotal });
    }

    // Employee performance today
    const empSales = new Map<string, { name: string; count: number; total: number }>();
    for (const e of sales) {
      const empId = e.actorEmployeeId;
      const emp = (store.employees ?? []).find((em) => em.id === empId);
      const existing = empSales.get(empId) ?? { name: emp?.displayName ?? empId.slice(0, 8), count: 0, total: 0 };
      existing.count += 1;
      existing.total += Number(e.payload?.grand_total ?? 0);
      empSales.set(empId, existing);
    }

    // Gift card activity today
    const todayGcTxns = (store.giftCardTransactions ?? []).filter((t) => t.createdAt?.startsWith(today));
    const gcRedemptions = todayGcTxns.filter((t) => t.transactionType === "redemption");
    const gcActivations = todayGcTxns.filter((t) => t.transactionType === "activation");
    const gcRedeemTotal = gcRedemptions.reduce((s, t) => s + Math.abs(t.amount), 0);
    const gcActivateTotal = gcActivations.reduce((s, t) => s + t.amount, 0);

    // Store credit activity today
    const todayScEntries = (store.storeCreditLedger ?? []).filter((e) => e.createdAt?.startsWith(today));
    const scIssued = todayScEntries.filter((e) => e.transactionType === "issuance").reduce((s, e) => s + e.amount, 0);
    const scRedeemed = todayScEntries.filter((e) => e.transactionType === "redemption").reduce((s, e) => s + Math.abs(e.amount), 0);

    // Behavior flags generated today
    const todayFlags = (store.behaviorFlags ?? []).filter((f) => f.createdAt?.startsWith(today));

    return {
      location,
      today,
      grossSales,
      totalReturns,
      netSales,
      txnCount,
      returnCount,
      avgTicket,
      tenderMap,
      todayShifts,
      closedShifts,
      openShifts,
      totalOpeningFloat,
      totalVariance,
      totalPayIn,
      totalPayOut,
      todayVoids,
      todayExceptions,
      empSales,
      gcRedeemTotal,
      gcActivateTotal,
      scIssued,
      scRedeemed,
      todayFlags,
    };
  }, [store, locationId]);

  const handlePrint = () => {
    window.print();
  };

  const handleExportCSV = () => {
    const rows: string[][] = [
      ["End-of-Day Z-Report"],
      [`Location: ${report.location?.name ?? "All"}`, `Date: ${report.today}`],
      [],
      ["Sales Overview"],
      ["Metric", "Value"],
      ["Transactions", String(report.txnCount)],
      ["Gross sales", report.grossSales.toFixed(2)],
      ["Returns", `${report.returnCount} / ${report.totalReturns.toFixed(2)}`],
      ["Net sales", report.netSales.toFixed(2)],
      ["Avg ticket", report.avgTicket.toFixed(2)],
      ["Voids", String(report.todayVoids.length)],
      [],
      ["Tender Breakdown"],
      ["Tender Type", "Transactions", "Total"],
      ...Array.from(report.tenderMap.entries()).map(([type, data]) => [
        tenderLabel(type), String(data.count), data.total.toFixed(2),
      ]),
      [],
      ["Cash Accountability"],
      ["Metric", "Value"],
      ["Shifts today", String(report.todayShifts.length)],
      ["Closed shifts", String(report.closedShifts.length)],
      ["Still open", String(report.openShifts.length)],
      ["Total opening floats", report.totalOpeningFloat.toFixed(2)],
      ["Cash tendered", (report.tenderMap.get("cash")?.total ?? 0).toFixed(2)],
      ["Pay-ins", report.totalPayIn.toFixed(2)],
      ["Pay-outs", report.totalPayOut.toFixed(2)],
      ["Net cash variance", report.totalVariance.toFixed(2)],
      [],
      ["Employee Performance"],
      ["Employee", "Sales Count", "Total"],
      ...Array.from(report.empSales.values())
        .sort((a, b) => b.total - a.total)
        .map((emp) => [emp.name, String(emp.count), emp.total.toFixed(2)]),
      [],
      ["Exceptions & Alerts"],
      ["Manager approvals", String(report.todayExceptions.length)],
      ["Behavior flags", String(report.todayFlags.length)],
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `z-report-${report.today}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const tenderLabel = (type: string): string => {
    const labels: Record<string, string> = { cash: "Cash", card: "Card", store_credit: "Store Credit", loyalty: "Loyalty", gift_card: "Gift Card", split: "Split" };
    return labels[type] ?? type;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold">End-of-Day Z-Report</h3>
          <p className="text-sm text-zinc-500">{report.location?.name ?? "All locations"} — {report.today}</p>
        </div>
        <div className="flex gap-2" data-print-hide>
          <button
            type="button"
            onClick={handleExportCSV}
            className="touch-button rounded-xl border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="touch-button rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            Print
          </button>
        </div>
      </div>

      <div ref={printRef} className="space-y-6">
        {/* Sales Overview */}
        <div className="rounded-2xl border border-zinc-200 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Sales Overview</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ZMetric label="Transactions" value={String(report.txnCount)} />
            <ZMetric label="Gross sales" value={`$${report.grossSales.toFixed(2)}`} />
            <ZMetric label="Returns" value={`${report.returnCount} / $${report.totalReturns.toFixed(2)}`} />
            <ZMetric label="Net sales" value={`$${report.netSales.toFixed(2)}`} accent />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <ZMetric label="Avg ticket" value={`$${report.avgTicket.toFixed(2)}`} />
            <ZMetric label="Voids" value={String(report.todayVoids.length)} />
          </div>
        </div>

        {/* Tender Breakdown */}
        <div className="rounded-2xl border border-zinc-200 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Tender Breakdown</p>
          {report.tenderMap.size === 0 ? (
            <p className="text-sm text-zinc-500">No tenders recorded today.</p>
          ) : (
            <div className="space-y-1">
              {Array.from(report.tenderMap.entries()).map(([type, data]) => (
                <div key={type} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                  <span>{tenderLabel(type)}</span>
                  <span className="font-semibold">{data.count} txns · ${data.total.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cash Accountability */}
        <div className="rounded-2xl border border-zinc-200 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Cash Accountability</p>
          <div className="space-y-2 text-sm">
            <ZRow label="Shifts today" value={String(report.todayShifts.length)} />
            <ZRow label="Closed shifts" value={String(report.closedShifts.length)} />
            {report.openShifts.length > 0 && (
              <ZRow label="Still open" value={String(report.openShifts.length)} warn />
            )}
            <ZRow label="Total opening floats" value={`$${report.totalOpeningFloat.toFixed(2)}`} />
            <ZRow label="Cash tendered" value={`$${(report.tenderMap.get("cash")?.total ?? 0).toFixed(2)}`} />
            <ZRow label="Pay-ins" value={`+$${report.totalPayIn.toFixed(2)}`} />
            <ZRow label="Pay-outs" value={`−$${report.totalPayOut.toFixed(2)}`} />
            <div className="border-t border-zinc-200 pt-2">
              <ZRow
                label="Net cash variance"
                value={`${report.totalVariance >= 0 ? "+" : ""}$${report.totalVariance.toFixed(2)}`}
                warn={Math.abs(report.totalVariance) > 2}
              />
            </div>
          </div>
        </div>

        {/* Employee Performance */}
        {report.empSales.size > 0 && (
          <div className="rounded-2xl border border-zinc-200 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Employee Performance</p>
            <div className="space-y-1">
              {Array.from(report.empSales.values())
                .sort((a, b) => b.total - a.total)
                .map((emp) => (
                  <div key={emp.name} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                    <span className="font-medium">{emp.name}</span>
                    <span>{emp.count} sales · ${emp.total.toFixed(2)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Gift Card & Store Credit */}
        {(report.gcRedeemTotal > 0 || report.gcActivateTotal > 0 || report.scIssued > 0 || report.scRedeemed > 0) && (
          <div className="rounded-2xl border border-zinc-200 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Gift Cards & Store Credit</p>
            <div className="space-y-2 text-sm">
              {report.gcActivateTotal > 0 && <ZRow label="Gift cards activated" value={`$${report.gcActivateTotal.toFixed(2)}`} />}
              {report.gcRedeemTotal > 0 && <ZRow label="Gift cards redeemed" value={`$${report.gcRedeemTotal.toFixed(2)}`} />}
              {report.scIssued > 0 && <ZRow label="Store credit issued" value={`$${report.scIssued.toFixed(2)}`} />}
              {report.scRedeemed > 0 && <ZRow label="Store credit redeemed" value={`$${report.scRedeemed.toFixed(2)}`} />}
            </div>
          </div>
        )}

        {/* Exceptions & Flags */}
        <div className="rounded-2xl border border-zinc-200 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Exceptions & Alerts</p>
          <div className="space-y-2 text-sm">
            <ZRow label="Manager approvals" value={String(report.todayExceptions.length)} />
            <ZRow label="Behavior flags generated" value={String(report.todayFlags.length)} warn={report.todayFlags.length > 0} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ZMetric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${accent ? "text-teal-700" : ""}`}>{value}</p>
    </div>
  );
}

function ZRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-600">{label}</span>
      <span className={`font-semibold ${warn ? "text-amber-600" : ""}`}>{value}</span>
    </div>
  );
}
