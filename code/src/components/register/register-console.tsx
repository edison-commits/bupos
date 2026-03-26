import { RegisterConsoleClient } from "./register-console-client";
import { hasPermission } from "@/lib/domain/permissions";
import type { LocalStoreData, RegisterSessionContext } from "@/lib/persistence/types";

export function RegisterConsole({
  store,
  context,
  notice,
  error,
}: {
  store: LocalStoreData;
  context: RegisterSessionContext;
  notice?: string;
  error?: string;
}) {
  const canOpenRegister = hasPermission(context.employee.roleKey, "register.open");

  // Calculate expected cash from tender truth:
  // opening float + cash tenders received - change given back + pay-ins - pay-outs
  const cashTenderTotal = store.transactionTenderPlaceholders
    .filter((t) => t.tenderType === "cash")
    .reduce((sum, t) => sum + t.amount, 0);
  const changeGivenTotal = store.transactionTenderPlaceholders
    .filter((t) => t.tenderType === "cash" && t.metadata?.change_due)
    .reduce((sum, t) => sum + Number(t.metadata?.change_due ?? 0), 0);

  // Pay-in/out adjustments for this shift
  const shiftPayInOuts = context.activeShift
    ? store.payInOuts.filter((p) => p.shiftId === context.activeShift!.id)
    : [];
  const payInTotal = shiftPayInOuts
    .filter((p) => p.direction === "pay_in")
    .reduce((sum, p) => sum + p.amount, 0);
  const payOutTotal = shiftPayInOuts
    .filter((p) => p.direction === "pay_out")
    .reduce((sum, p) => sum + p.amount, 0);

  const openingFloat = context.activeShift?.openingFloat ?? 0;
  const expectedCash = Number(
    (openingFloat + cashTenderTotal - changeGivenTotal + payInTotal - payOutTotal).toFixed(2),
  );

  // Shift stats: transaction count and sales total from tender placeholders
  const shiftTransactionIds = new Set(
    store.transactionTenderPlaceholders
      .filter((t) => t.transactionId !== "txn_register_shift_placeholder")
      .map((t) => t.transactionId),
  );
  const transactionCount = shiftTransactionIds.size;
  const salesTotal = store.transactionEventPlaceholders
    .filter(
      (e) =>
        e.eventKind === "transaction_placeholder" &&
        e.payload?.grand_total &&
        shiftTransactionIds.has(e.transactionId),
    )
    .reduce((sum, e) => sum + Number(e.payload?.grand_total ?? 0), 0);

  // Tender breakdown
  const tenderMap = new Map<string, { total: number; count: number }>();
  for (const t of store.transactionTenderPlaceholders) {
    if (t.transactionId === "txn_register_shift_placeholder") continue;
    const existing = tenderMap.get(t.tenderType) ?? { total: 0, count: 0 };
    existing.total += t.amount;
    existing.count += 1;
    tenderMap.set(t.tenderType, existing);
  }
  const tenderBreakdown = Array.from(tenderMap.entries()).map(([type, data]) => ({
    type,
    total: data.total,
    count: data.count,
  }));

  // Recent shifts for sidebar
  const recentShifts = store.shifts
    .filter((entry) => entry.locationId === context.location.id)
    .slice(0, 5)
    .map((entry) => ({
      ...entry,
      employee: store.employees.find((employee) => employee.id === entry.employeeId),
    }));

  return (
    <RegisterConsoleClient
      store={store}
      context={context}
      notice={notice}
      error={error}
      canOpenRegister={canOpenRegister}
      expectedCash={expectedCash}
      transactionCount={transactionCount}
      salesTotal={salesTotal}
      tenderBreakdown={tenderBreakdown}
      recentShifts={recentShifts}
      payInOuts={shiftPayInOuts}
    />
  );
}
