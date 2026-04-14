import type { LocalStoreData } from "@/lib/persistence/types";
import { formatDateTime } from "@/lib/utils/date";

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

export function SalesSummary({ store }: { store: LocalStoreData }) {
  const txnEvents = store.transactionEventPlaceholders.filter(
    (e) => e.eventKind === "transaction_placeholder" && e.payload?.grand_total && e.transactionId !== "txn_register_shift_placeholder" && e.transactionId !== "txn_inventory_placeholder",
  );
  const totalSales = txnEvents.filter((e) => !e.payload?.is_return).reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
  const totalReturns = txnEvents.filter((e) => e.payload?.is_return === "true").reduce((s, e) => s + Math.abs(Number(e.payload?.grand_total ?? 0)), 0);
  const netSales = totalSales - totalReturns;
  const txnCount = txnEvents.filter((e) => !e.payload?.is_return).length;
  const returnCount = txnEvents.filter((e) => e.payload?.is_return === "true").length;
  const avgTicket = txnCount > 0 ? totalSales / txnCount : 0;

  const tenderMap = new Map<string, { total: number; count: number }>();
  for (const t of store.transactionTenderPlaceholders) {
    if (t.transactionId === "txn_register_shift_placeholder") continue;
    const existing = tenderMap.get(t.tenderType) ?? { total: 0, count: 0 };
    existing.total += t.amount;
    existing.count += 1;
    tenderMap.set(t.tenderType, existing);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Transactions" value={String(txnCount)} />
        <Metric label="Total sales" value={`$${totalSales.toFixed(2)}`} />
        <Metric label="Returns" value={`${returnCount} / $${totalReturns.toFixed(2)}`} />
        <Metric label="Avg ticket" value={`$${avgTicket.toFixed(2)}`} />
      </div>
      <div className="rounded-2xl bg-zinc-50 px-4 py-3">
        <p className="text-sm font-semibold text-zinc-600">Net sales: <span className="text-lg text-zinc-900">${netSales.toFixed(2)}</span></p>
      </div>
      {tenderMap.size > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">By tender type</p>
          {Array.from(tenderMap.entries()).map(([type, data]) => (
            <div key={type} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
              <span className="capitalize">{type === "store_credit" ? "Store credit" : type}</span>
              <span className="font-semibold">{data.count} · ${data.total.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ShiftHistory({ store }: { store: LocalStoreData }) {
  const closedShifts = store.shifts
    .filter((s) => s.status === "closed")
    .slice(0, 10)
    .map((s) => ({ ...s, employee: store.employees.find((e) => e.id === s.employeeId) }));
  if (closedShifts.length === 0) return <p className="text-sm text-zinc-600">No closed shifts yet.</p>;
  return (
    <div className="space-y-2">
      {closedShifts.map((shift) => (
        <div key={shift.id} className="rounded-2xl border border-zinc-200 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{shift.employee?.displayName ?? "Unknown"}</p>
              <p className="text-xs text-zinc-500">{formatDateTime(shift.openedAt)} — {shift.closedAt ? formatDateTime(shift.closedAt) : "open"}</p>
            </div>
            <div className="text-right">
              <p className="text-sm">Float ${shift.openingFloat.toFixed(2)}</p>
              {typeof shift.closingVariance === "number" && (
                <p className={`text-sm font-semibold ${shift.closingVariance === 0 ? "text-emerald-700" : Math.abs(shift.closingVariance) <= 1 ? "text-amber-700" : "text-red-700"}`}>
                  Variance {shift.closingVariance >= 0 ? "+" : ""}${shift.closingVariance.toFixed(2)}
                </p>
              )}
              {shift.blindClose && <p className="text-xs text-zinc-400">blind close</p>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmployeeActivity({ store }: { store: LocalStoreData }) {
  const employeeStats = store.employees.filter((e) => e.isActive).map((emp) => {
    const empTxns = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === emp.id && e.eventKind === "transaction_placeholder" && e.payload?.grand_total && !e.payload?.is_return && e.transactionId !== "txn_register_shift_placeholder",
    );
    const empVoids = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === emp.id && e.eventKind === "transaction_placeholder" && e.payload?.is_return === "true",
    );
    const totalSales = empTxns.reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
    return { employee: emp, txnCount: empTxns.length, totalSales, voidCount: empVoids.length };
  }).filter((s) => s.txnCount > 0 || s.voidCount > 0);

  if (employeeStats.length === 0) return <p className="text-sm text-zinc-600">No employee activity recorded yet.</p>;
  return (
    <div className="space-y-2">
      {employeeStats.map((stat) => (
        <div key={stat.employee.id} className="flex items-center justify-between rounded-2xl bg-zinc-50 px-4 py-3">
          <div>
            <p className="font-semibold">{stat.employee.displayName}</p>
            <p className="text-xs text-zinc-500">{stat.employee.roleKey}</p>
          </div>
          <div className="text-right text-sm">
            <p>{stat.txnCount} sales · ${stat.totalSales.toFixed(2)}</p>
            {stat.voidCount > 0 && <p className="text-amber-700">{stat.voidCount} returns</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CustomerActivity({ customers }: { customers: LocalStoreData["customers"] }) {
  const sorted = [...customers].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 10);
  if (sorted.length === 0) return <p className="text-sm text-zinc-600">No customers yet.</p>;
  return (
    <div className="space-y-2">
      {sorted.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-2xl bg-zinc-50 px-4 py-3">
          <div className="flex flex-1 items-center gap-3">
            <div>
              <p className="font-semibold">{c.firstName} {c.lastName}</p>
              <p className="text-xs text-zinc-500">{c.email ?? c.phone ?? "No contact"}</p>
            </div>
            {c.taxExempt && (
              <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">TAX EXEMPT</span>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">${c.totalSpend.toFixed(2)}</p>
            <p className="text-xs text-zinc-500">{c.visitCount} visits · {c.loyaltyPoints} pts</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CashierExceptions({ store }: { store: LocalStoreData }) {
  const exceptions = store.transactionExceptionPlaceholders.map((exc) => {
    const event = store.transactionEventPlaceholders.find((e) => e.transactionId === exc.transactionId);
    const actor = event ? store.employees.find((e) => e.id === event.actorEmployeeId) : null;
    return { ...exc, event, actor };
  });
  const voidEvents = store.transactionEventPlaceholders.filter(
    (e) => e.eventKind === ("cart_voided" as string) || e.eventKind === ("transaction_voided" as string),
  ).map((e) => ({ ...e, actor: store.employees.find((emp) => emp.id === e.actorEmployeeId) }));
  const discountThreshold = store.registerConfiguration.approvalThresholds.discountOver;
  const largeDiscountTxns = store.transactionEventPlaceholders.filter((e) => {
    if (e.eventKind !== ("discount_applied" as string)) return false;
    return Number(e.payload?.discount_amount ?? 0) > discountThreshold;
  }).map((e) => ({ ...e, actor: store.employees.find((emp) => emp.id === e.actorEmployeeId) }));

  const hasData = exceptions.length > 0 || voidEvents.length > 0 || largeDiscountTxns.length > 0;
  if (!hasData) return <p className="text-sm text-zinc-600">No exceptions recorded yet.</p>;

  return (
    <div className="space-y-4">
      {exceptions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Approval exceptions ({exceptions.length})</p>
          {exceptions.slice(0, 10).map((exc) => (
            <div key={exc.id} className={`flex items-center justify-between rounded-xl px-4 py-2 text-sm ${exc.resolvedAt ? "bg-emerald-50" : "bg-amber-50"}`}>
              <div>
                <p className="font-medium">{exc.exceptionCode.replace(/_/g, " ")}</p>
                <p className="text-xs text-zinc-500">{exc.actor?.displayName ?? "Unknown"} · {exc.transactionId.slice(0, 8)}</p>
              </div>
              <span className={`text-xs font-semibold ${exc.resolvedAt ? "text-emerald-700" : "text-amber-700"}`}>
                {exc.resolvedAt ? "Resolved" : "Pending"}
              </span>
            </div>
          ))}
        </div>
      )}
      {voidEvents.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Voids ({voidEvents.length})</p>
          {voidEvents.slice(0, 10).map((evt) => (
            <div key={evt.id} className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-2 text-sm">
              <div>
                <p className="font-medium">{evt.eventKind.replace(/_/g, " ")}</p>
                <p className="text-xs text-zinc-500">{evt.actor?.displayName ?? "Unknown"} · {formatDateTime(evt.createdAt)}</p>
              </div>
              <span className="text-xs text-red-700">{evt.payload?.reason_code ?? "No reason"}</span>
            </div>
          ))}
        </div>
      )}
      {largeDiscountTxns.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Large discounts ({largeDiscountTxns.length})</p>
          {largeDiscountTxns.slice(0, 10).map((evt) => (
            <div key={evt.id} className="flex items-center justify-between rounded-xl bg-purple-50 px-4 py-2 text-sm">
              <div>
                <p className="font-medium">${evt.payload?.discount_amount ?? "?"}</p>
                <p className="text-xs text-zinc-500">{evt.actor?.displayName ?? "Unknown"} · {formatDateTime(evt.createdAt)}</p>
              </div>
              <span className="text-xs text-purple-700">Over ${discountThreshold}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiscrepancyCorrelation({ store }: { store: LocalStoreData }) {
  const closedShifts = store.shifts.filter((s) => s.status === "closed" && typeof s.closingVariance === "number");
  if (closedShifts.length === 0) return <p className="text-sm text-zinc-600">No closed shifts with variance data yet.</p>;

  const rows = closedShifts.map((shift) => {
    const emp = store.employees.find((e) => e.id === shift.employeeId);
    const shiftVoids = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === shift.employeeId &&
        (e.eventKind === ("cart_voided" as string) || e.eventKind === ("item_removed" as string)) &&
        e.createdAt >= shift.openedAt && (!shift.closedAt || e.createdAt <= shift.closedAt),
    ).length;
    const shiftReturns = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === shift.employeeId && e.eventKind === "transaction_placeholder" &&
        e.payload?.is_return === "true" && e.createdAt >= shift.openedAt && (!shift.closedAt || e.createdAt <= shift.closedAt),
    ).length;
    return { shift, emp, shiftVoids, shiftReturns };
  }).sort((a, b) => Math.abs(b.shift.closingVariance ?? 0) - Math.abs(a.shift.closingVariance ?? 0));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 px-4">
        <span>Cashier</span>
        <span className="text-right">Variance</span>
        <span className="text-right">Voids</span>
        <span className="text-right">Returns</span>
        <span className="text-right">Blind</span>
      </div>
      {rows.slice(0, 10).map((row) => {
        const variance = row.shift.closingVariance ?? 0;
        const varColor = variance === 0 ? "text-emerald-700" : Math.abs(variance) <= 1 ? "text-amber-700" : "text-red-700";
        return (
          <div key={row.shift.id} className="grid grid-cols-5 gap-2 rounded-xl bg-zinc-50 px-4 py-2 text-sm items-center">
            <span className="truncate font-medium">{row.emp?.displayName ?? "?"}</span>
            <span className={`text-right font-semibold ${varColor}`}>{variance >= 0 ? "+" : ""}${variance.toFixed(2)}</span>
            <span className="text-right">{row.shiftVoids}</span>
            <span className="text-right">{row.shiftReturns}</span>
            <span className="text-right">{row.shift.blindClose ? "Yes" : "No"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function InventorySummary({ store }: { store: LocalStoreData }) {
  const totalOnHand = store.inventory.reduce((s, i) => s + i.onHand, 0);
  const totalReserved = store.inventory.reduce((s, i) => s + i.reserved, 0);
  const totalRetailValue = store.inventory.reduce((s, inv) => {
    const variant = store.variants.find((v) => v.id === inv.productVariantId);
    return s + (variant ? variant.price * inv.onHand : 0);
  }, 0);
  const totalCostValue = store.inventory.reduce((s, inv) => {
    const variant = store.variants.find((v) => v.id === inv.productVariantId);
    return s + (variant?.cost ? variant.cost * inv.onHand : 0);
  }, 0);
  const lowStockCount = store.inventory.filter((i) => i.onHand <= i.reorderPoint).length;
  const outOfStockCount = store.inventory.filter((i) => i.onHand === 0).length;
  const adjustments = store.inventoryAdjustments ?? [];
  const adjustmentCount = adjustments.length;
  const netAdjustment = adjustments.reduce((s, a) => s + a.delta, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Total on hand" value={String(totalOnHand)} />
        <Metric label="Reserved" value={String(totalReserved)} />
        <Metric label="Retail value" value={`$${totalRetailValue.toFixed(2)}`} />
        <Metric label="Cost value" value={`$${totalCostValue.toFixed(2)}`} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Low stock items" value={String(lowStockCount)} />
        <Metric label="Out of stock" value={String(outOfStockCount)} />
        <Metric label="Adjustments" value={String(adjustmentCount)} />
        <Metric label="Net adjustment" value={`${netAdjustment >= 0 ? "+" : ""}${netAdjustment}`} />
      </div>
      {store.inventory.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Stock by variant</p>
          {store.inventory.map((inv) => {
            const variant = store.variants.find((v) => v.id === inv.productVariantId);
            const product = variant ? store.products.find((p) => p.id === variant.productId) : null;
            const pct = inv.reorderPoint > 0 ? Math.round((inv.onHand / (inv.reorderPoint * 3)) * 100) : 100;
            const barColor = inv.onHand === 0 ? "bg-red-500" : inv.onHand <= inv.reorderPoint ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div key={inv.id} className="flex items-center gap-3 rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{product?.name ?? "?"} — {variant?.name ?? inv.productVariantId}</p>
                  <p className="text-xs text-zinc-500">{variant?.sku}</p>
                </div>
                <div className="w-24">
                  <div className="h-2 rounded-full bg-zinc-200">
                    <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </div>
                <span className="w-16 text-right font-semibold">{inv.onHand}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
