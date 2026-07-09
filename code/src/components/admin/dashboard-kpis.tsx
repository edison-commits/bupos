"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LocalStoreData } from "@/lib/persistence/types";
import { formatCurrency } from "@/lib/format";

interface DashboardKPIsProps {
  store: LocalStoreData;
  locationId: string;
}

export function DashboardKPIs({ store, locationId }: DashboardKPIsProps) {
  // Use a stable placeholder on first render (matches server) then hydrate
  // the real "today" on the client to avoid React #418 when the server's
  // UTC day differs from the client's local day around midnight.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); }, []);
  const todayStr = (now ?? new Date(0)).toISOString().slice(0, 10);
  const yesterdayStr = new Date((now ?? new Date(0)).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  const kpis = useMemo(() => {
    const today = todayStr;
    const yesterday = yesterdayStr;

    // All transaction events (sales)
    const allTxns = (store.transactionEventPlaceholders ?? []).filter(
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
    const todayShifts = (store.shifts ?? []).filter((s) => s.openedAt?.startsWith(today));
    const openShifts = todayShifts.filter((s) => s.status === "open");
    const closedShifts = todayShifts.filter((s) => s.status === "closed");
    const totalVariance = closedShifts.reduce((s, sh) => s + Math.abs(sh.closingVariance ?? 0), 0);

    // Inventory alerts
    const lowStockCount = (store.inventory ?? []).filter((inv) => inv.locationId === locationId && inv.onHand > 0 && inv.onHand <= inv.reorderPoint).length;
    const outOfStockCount = (store.inventory ?? []).filter((inv) => inv.locationId === locationId && inv.onHand <= 0).length;

    // Behavior flags (unreviewed)
    const unreviewedFlags = (store.behaviorFlags ?? []).filter((f) => !f.isReviewed).length;
    const todayFlags = (store.behaviorFlags ?? []).filter((f) => f.createdAt?.startsWith(today)).length;

    // Active layaways
    const activeLayaways = (store.layaways ?? []).filter((l) => l.status === "active" || l.status === "partially_paid").length;
    const layawayBalance = (store.layaways ?? [])
      .filter((l) => l.status === "active" || l.status === "partially_paid")
      .reduce((s, l) => s + l.balanceDue, 0);

    // Gift card liability
    const gcLiability = (store.giftCards ?? [])
      .filter((g) => g.status === "active")
      .reduce((s, g) => s + g.balance, 0);

    // Customer metrics
    const totalCustomers = (store.customers ?? []).length;

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

  const attentionItems = buildAttentionItems(kpis);
  const primaryAction = attentionItems[0] ?? {
    title: "Store is ready",
    detail: "No urgent inventory or exception queues are surfaced for this location.",
    href: "/admin/reports",
    action: "Review reports",
    tone: "good" as const,
  };
  const supportItems = attentionItems.length > 1
    ? attentionItems.slice(1, 4)
    : [
        {
          title: "Keep selling",
          detail: "The dashboard will keep refreshing without hiding the current numbers.",
          href: "/register",
          action: "Open register",
          tone: "good" as const,
        },
        {
          title: "Review the day",
          detail: "Use reports when you want more detail than the at-a-glance cards.",
          href: "/admin/reports",
          action: "View reports",
          tone: "neutral" as const,
        },
      ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-bold">Today at a glance</h3>
        <p className="text-sm text-zinc-500" suppressHydrationWarning>
          {now
            ? now.toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "America/Los_Angeles",
              })
            : "\u00a0"/* nbsp reserves line height on SSR */}
        </p>
      </div>

      <section className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">Manager attention</p>
            <h4 className="mt-2 text-xl font-bold text-zinc-950">{primaryAction.title}</h4>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-600">{primaryAction.detail}</p>
          </div>
          <Link
            href={primaryAction.href}
            className="touch-button inline-flex shrink-0 items-center justify-center rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-teal-800"
          >
            {primaryAction.action}
          </Link>
        </div>

        {supportItems.length > 0 ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {supportItems.map((item) => <AttentionCard key={item.title} item={item} />)}
          </div>
        ) : null}
      </section>

      {/* Primary sales KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Gross sales"
          value={formatCurrency(kpis.todayGross)}
          delta={kpis.salesDelta}
          deltaLabel="vs yesterday"
          accent="teal"
        />
        <KPICard
          label="Net sales"
          value={formatCurrency(kpis.todayNet)}
          accent="teal"
        />
        <KPICard
          label="Transactions"
          value={String(kpis.todayTxnCount)}
        />
        <KPICard
          label="Avg ticket"
          value={formatCurrency(kpis.todayAvgTicket)}
        />
      </div>

      {/* Operational KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Returns today"
          value={formatCurrency(kpis.todayReturnTotal)}
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
          value={formatCurrency(kpis.totalVariance)}
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
          subtext={`${formatCurrency(kpis.layawayBalance)} outstanding`}
        />
        <KPICard
          label="Gift card liability"
          value={formatCurrency(kpis.gcLiability)}
        />
        <KPICard
          label="Customers"
          value={String(kpis.totalCustomers)}
        />
      </div>
    </div>
  );
}

type AttentionItem = {
  title: string;
  detail: string;
  href: string;
  action: string;
  tone: "good" | "warn" | "danger" | "neutral";
};

function buildAttentionItems(kpis: {
  openShifts: number;
  totalVariance: number;
  unreviewedFlags: number;
  todayFlags: number;
  lowStockCount: number;
  outOfStockCount: number;
  todayReturnTotal: number;
  todayNet: number;
  todayTxnCount: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (kpis.outOfStockCount > 0 || kpis.lowStockCount > 0) {
    items.push({
      title: kpis.outOfStockCount > 0 ? `${kpis.outOfStockCount} items are out of stock` : `${kpis.lowStockCount} low-stock items`,
      detail: kpis.outOfStockCount > 0
        ? "Restock or hide sold-out variants before they slow down checkout."
        : "Review reorder points before the next busy period.",
      href: "/admin/inventory",
      action: "Review inventory",
      tone: kpis.outOfStockCount > 0 ? "danger" : "warn",
    });
  }

  if (kpis.unreviewedFlags > 0) {
    items.push({
      title: `${kpis.unreviewedFlags} behavior flags need review`,
      detail: "Clear exceptions before end-of-day close so managers are not surprised later.",
      href: "/admin/audit",
      action: "Open audit log",
      tone: "warn",
    });
  }

  return items;
}

function AttentionCard({ item }: { item: AttentionItem }) {
  const toneClass = {
    good: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
    warn: "border-amber-200 bg-amber-50/80 text-amber-950",
    danger: "border-red-200 bg-red-50/80 text-red-950",
    neutral: "border-zinc-200 bg-zinc-50 text-zinc-900",
  }[item.tone];

  return (
    <div className={`rounded-2xl border p-3 ${toneClass}`}>
      <p className="text-sm font-semibold">{item.title}</p>
      <p className="mt-1 text-xs leading-5 opacity-80">{item.detail}</p>
      <Link href={item.href} className="mt-3 inline-flex text-xs font-semibold underline underline-offset-4">
        {item.action}
      </Link>
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
