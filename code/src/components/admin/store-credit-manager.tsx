"use client";

import { useState, useTransition } from "react";
import { issueStoreCreditAction } from "@/app/admin/store-credit-actions";
import type { Customer, StoreCreditEntry, Employee } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

export function StoreCreditManager({
  customers,
  ledger,
  employees,
}: {
  customers: Customer[];
  ledger: StoreCreditEntry[];
  employees: Employee[];
}) {
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const empMap = new Map(employees.map((e) => [e.id, e]));

  const totalOutstanding = customers.reduce((s, c) => s + c.storeCreditBalance, 0);
  const customersWithCredit = customers.filter((c) => c.storeCreditBalance > 0);
  const totalIssued = ledger.filter((e) => e.transactionType === "issuance").reduce((s, e) => s + e.amount, 0);
  const totalRedeemed = ledger.filter((e) => e.transactionType === "redemption").reduce((s, e) => s + Math.abs(e.amount), 0);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Outstanding balance</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(totalOutstanding)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Customers with credit</p>
          <p className="mt-1 text-2xl font-semibold">{customersWithCredit.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total issued</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(totalIssued)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total redeemed</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(totalRedeemed)}</p>
        </div>
      </div>

      {/* Issue form */}
      <button
        onClick={() => setShowIssueForm(!showIssueForm)}
        className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
      >
        {showIssueForm ? "Cancel" : "Issue store credit"}
      </button>

      {showIssueForm && (
        <form
          action={(fd) => {
            startTransition(async () => {
              await issueStoreCreditAction(fd);
              setShowIssueForm(false);
            });
          }}
          className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3"
        >
          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium">
              <span>Customer</span>
              <select name="customerId" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                <option value="">Select customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Amount ($)</span>
              <input name="amount" type="number" step="0.01" min="0.01" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" placeholder="10.00" />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Reason</span>
              <input name="reason" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" placeholder="Return credit, goodwill, etc." />
            </label>
          </div>
          <button type="submit" disabled={isPending} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {isPending ? "Issuing..." : "Issue credit"}
          </button>
        </form>
      )}

      {/* Customer balances */}
      {customersWithCredit.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Customers with store credit</p>
          {customersWithCredit.sort((a, b) => b.storeCreditBalance - a.storeCreditBalance).map((c) => {
            const custLedger = ledger.filter((e) => e.customerId === c.id);
            const isExpanded = selectedCustomerId === c.id;
            return (
              <div key={c.id} className="rounded-xl border border-zinc-200 bg-white">
                <button
                  onClick={() => setSelectedCustomerId(isExpanded ? null : c.id)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <span className="text-sm font-medium">{c.firstName} {c.lastName}</span>
                  <span className="text-sm font-semibold">{formatCurrency(c.storeCreditBalance)}</span>
                </button>
                {isExpanded && custLedger.length > 0 && (
                  <div className="border-t border-zinc-100 px-4 py-3 space-y-1">
                    {custLedger.map((entry) => {
                      const emp = entry.employeeId ? empMap.get(entry.employeeId) : null;
                      return (
                        <div key={entry.id} className="flex items-center justify-between text-sm">
                          <div>
                            <span className="font-medium">{entry.transactionType}</span>
                            {entry.reason && <span className="text-zinc-500"> — {entry.reason}</span>}
                            {emp && <span className="text-zinc-400"> · {emp.displayName}</span>}
                          </div>
                          <span className={`font-medium ${entry.amount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                            {entry.amount > 0 ? "+" : ""}{formatCurrency(entry.amount)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Issuance report by employee */}
      {ledger.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Issuance by employee</p>
          {(() => {
            const byEmployee = new Map<string, { count: number; total: number }>();
            for (const entry of ledger) {
              if (entry.transactionType !== "issuance" || !entry.employeeId) continue;
              const existing = byEmployee.get(entry.employeeId) ?? { count: 0, total: 0 };
              existing.count += 1;
              existing.total += entry.amount;
              byEmployee.set(entry.employeeId, existing);
            }
            return [...byEmployee.entries()]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([empId, data]) => {
                const emp = empMap.get(empId);
                return (
                  <div key={empId} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                    <span className="font-medium">{emp?.displayName ?? empId}</span>
                    <span>{data.count} issuances · {formatCurrency(data.total)}</span>
                  </div>
                );
              });
          })()}
        </div>
      )}
    </div>
  );
}
