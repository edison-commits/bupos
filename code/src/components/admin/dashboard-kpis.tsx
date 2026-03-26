"use client";

import { useMemo } from "react";
import type { LocalStoreData } from "@/lib/persistence/types";

interface DashboardKPIsProps {
  store: LocalStoreData;
  locationId: string;
}

export function DashboardKPIs({ store, locationId }: DashboardKPIsProps) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

  const kpis = useMemo(() => {
    const today = todayStr;
    const yesterday = yesterdayStr;

    // All transaction events (sales)
    const allTxns = store.transactionEventPlaceholders.filter(
      (e) =>
        e.eventKind === "transaction_placeholder" &&
        e.payload?.grand_total &&
        e.transactionId !== "txn_register_shift_placeholder" &&
        e.transactionId !== "txn_inventory_placeholder" &&
        (!e.payload?.location_id || e.payload.location_id === locationId),
    );

    const todaySales = allTxns.filter((e) => e.createdAt?.startsWith(today) && e.payload?.is_return !== "true");
    const todayReturns = allTxns.filter((e) => e.createdAt?.startsWith(today) && e.payload?.is_return === "true");
    const yesterdaySales = allTxns.filter((e) => e.createdAt?.startsWith(yesterday) && e.payload?.is_return !== "true");

    const todayGross = todaySales.reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
    const todayReturnTotal = todayReturns.reduce((s, e) => s + Math.abs(Number(e.payload?.grand_total ?? 0)), 0);
    const todayNet = todayGross - todayReturnTotal;
    const todayTxnCount = todaySales.length;
    const todayAvgTicket = todayTxnCount > 0 ? todayGross / todayTxnCount : 0;

    const yesterdayGross = yesterdaySales.reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
    const salesDelta = yesterdayGross > 0
      ? ((todayGross - yesterdayGross) / yesterdayGross) * 100
      : todayGross > 0 ? 100 : 0;

    // Shift info
    const todayShifts = store.shifts.filter((s) => s.openedAt?.startsWith(today));
    const openShifts = todayShifts.filter((s) => s.status === "open");
    const closedShifts = todayShifts.filter((s) => s.status === "closed");
    const totalVariance = closedShifts.reduce((s, sh) => s + Math.abs(sh.closingVariance ?? 0), 0);

    // Inventory alerts
    const lowStockCount = store.inventory.filter((inv) => inv.locationId === locationId && inv.onHand > 0 && inv.onHand <= inv.reorderPoint).length;
    const outOfStockCount = store.inventory.filter((inv) => inv.locationId === locationId && inv.onHand <= 0).length;

    // Behavior flags (unreviewed)
    const unreviewedFlags = store.behaviorFlags.filter((f) => !f.isReviewed).length;
    const todayFlags = store.behaviorFlags.filter((f) => f.createdAt?.startsWith(today)).length;

    // Active layaways
    const activeLayaways = store.layaways.filter((l) => l.status === "active" || l.status === "partially_paid").length;
    const layawayBalance = store.layaways
      .filter((l) => l.status === "active" || l.status === "partially_paid")
      .reduce((s, l) => s + l.balanceDue, 0);

    // Gift card liability
    const gcLiability = store.giftCards
      .filter((g) => g.status === "active")
      .reduce((s, g) => s + g.balance, 0);

    // Customer metrics
    const totalCustomers = store.customers.length;

    return {
      todayGross,
      todayNet,
      todayReturnTotal,
      todayTxnCount,
      todayAvgTicket,
      salesDelta,
      openShifts: openShifts.length,
      closedShifts: closedShifts.length,
      totalVariance,
      lowStockCount,
      outOfStockCount,
      unreviewedFlags,
      todayFlags,
      activeLayaways,
      layawayBalance,
      gcLiability,
      totalCustomers,
    };
  }, [store, locationId, todayStr, yesterdayStr]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-bold">Today at a glance</h3>
        <p className="text-sm text-zinc-500">{new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>

      {/* Primary sales KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Gross sales"
          value={`$${kpis.todayGross.toFixed(2)}`}
          delta={kpis.salesDelta}
          deltaLabel="vs yesterday"
          accent="teal"
        />
        <KPICard
          label="Net sales"
          value={`$${kpis.todayNet.toFixed(2)}`}
          accent="teal"
        />
        <KPICard
          label="Transactions"
          value={String(kpis.todayTxnCount)}
        />
        <KPICard
          label="Avg ticket"
          value={`$${kpis.todayAvgTicket.toFixed(2)}`}
        />
      </div>

      {/* Operational KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Returns today"
          value={`$${kpis.todayReturnTotal.toFixed(2)}`}
          warn={kpis.todayReturnTotal > 0}
        />
        <KPICard
          label="Open shifts"
          value={String(kpis.openShifts)}
          subtext={`${kpis.closedShifts} closed`}
          warn={kpis.openShifts > 2}
        />
        <KPICard
          label="Cash variance"
          value={`$${kpis.totalVariance.toFixed(2)}`}
          warn={kpis.totalVariance > 5}
        />
        <KPICard
          label="Behavior flags"
          value={`${kpis.unreviewedFlags} unreviewed`}
          subtext={`${kpis.todayFlags} new today`}
          warn={kpis.unreviewedFlags > 0}
        />
      </div>

      {/* Inventory + liability */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Low stock"
          value={String(kpis.lowStockCount)}
          subtext={`${kpis.outOfStockCount} out of stock`}
          warn={kpis.lowStockCount > 3 || kpis.outOfStockCount > 0}
        />
        <KPICard
          label="Active layaways"
          value={String(kpis.activeLayaways)}
          subtext={`$${kpis.layawayBalance.toFixed(2)} outstanding`}
        />
        <KPICard
          label="Gift card liability"
          value={`$${kpis.gcLiability.toFixed(2)}`}
        />
        <KPICard
          label="Customers"
          value={String(kpis.totalCustomers)}
        />
      </div>
    </div>
  );
}

function KPICard({
  label,
  value,
  subtext,
  delta,
  deltaLabel,
  accent,
  warn,
}: {
  label: string;
  value: string;
  subtext?: string;
  delta?: number;
  deltaLabel?: string;
  accent?: "teal";
  warn?: boolean;
}) {
  const valueColor = warn
    ? "text-amber-600"
    : accent === "teal"
      ? "text-teal-700"
      : "";

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${valueColor}`}>{value}</p>
      {subtext && <p className="mt-0.5 text-xs text-zinc-500">{subtext}</p>}
      {delta !== undefined && (
        <p className={`mt-0.5 text-xs font-medium ${delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(1)}% {deltaLabel}
        </p>
      )}
    </div>
  );
}
