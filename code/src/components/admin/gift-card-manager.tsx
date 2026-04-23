"use client";

import { useState, useTransition } from "react";
import { activateGiftCardAction, disableGiftCardAction, reloadGiftCardAction } from "@/app/admin/gift-card-actions";
import type { GiftCard, GiftCardTransaction, Employee, Customer } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";
import { usePasswordGate } from "@/components/shared/password-gate";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  depleted: "bg-zinc-100 text-zinc-600",
  disabled: "bg-red-100 text-red-800",
  expired: "bg-amber-100 text-amber-800",
};

export function GiftCardManager({
  giftCards,
  transactions,
  employees,
  customers,
}: {
  giftCards: GiftCard[];
  transactions: GiftCardTransaction[];
  employees: Employee[];
  customers: Customer[];
}) {
  const [showActivateForm, setShowActivateForm] = useState(false);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [promptPassword, passwordGate] = usePasswordGate();

  const empMap = new Map(employees.map((e) => [e.id, e]));
  const custMap = new Map(customers.map((c) => [c.id, c]));

  const totalOutstandingLiability = giftCards
    .filter((gc) => gc.status === "active" || gc.status === "depleted")
    .reduce((s, gc) => s + gc.balance, 0);

  const activeCount = giftCards.filter((gc) => gc.status === "active").length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total cards</p>
          <p className="mt-1 text-2xl font-semibold">{giftCards.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Active</p>
          <p className="mt-1 text-2xl font-semibold">{activeCount}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Outstanding liability</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(totalOutstandingLiability)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Transactions</p>
          <p className="mt-1 text-2xl font-semibold">{transactions.length}</p>
        </div>
      </div>

      {/* Action bar */}
      <button
        onClick={() => setShowActivateForm(!showActivateForm)}
        className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
      >
        {showActivateForm ? "Cancel" : "Activate new gift card"}
      </button>

      {/* Activate form */}
      {showActivateForm && (
        <form
          action={(fd) => {
            startTransition(async () => {
              await activateGiftCardAction(fd);
              setShowActivateForm(false);
            });
          }}
          className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3"
        >
          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium">
              <span>Card code</span>
              <input name="code" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" placeholder="e.g. GC-2026-001" />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Amount ($)</span>
              <input name="amount" type="number" step="0.01" min="0.01" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" placeholder="25.00" />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Customer (optional)</span>
              <select name="customerId" className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                <option value="">No customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isPending ? "Activating..." : "Activate card"}
          </button>
        </form>
      )}

      {/* Card list */}
      {giftCards.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No gift cards yet.</p>
      ) : (
        <div className="space-y-2">
          {giftCards.map((gc) => {
            const activator = gc.activatedBy ? empMap.get(gc.activatedBy) : null;
            const customer = gc.customerId ? custMap.get(gc.customerId) : null;
            const cardTxns = transactions.filter((t) => t.giftCardId === gc.id);
            const isExpanded = selectedCard === gc.id;

            return (
              <div key={gc.id} className="rounded-xl border border-zinc-200 bg-white">
                <button
                  onClick={() => setSelectedCard(isExpanded ? null : gc.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{gc.code}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[gc.status]}`}>{gc.status}</span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {formatCurrency(gc.balance)} / {formatCurrency(gc.initialBalance)}
                      {customer ? ` · ${customer.firstName} ${customer.lastName}` : ""}
                      {activator ? ` · Activated by ${activator.displayName}` : ""}
                    </p>
                  </div>
                  <span className="text-lg font-semibold">{formatCurrency(gc.balance)}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-3 space-y-3">
                    {/* Transaction history */}
                    <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Transaction history</p>
                    {cardTxns.length === 0 ? (
                      <p className="text-xs text-zinc-400">No transactions.</p>
                    ) : (
                      <div className="space-y-1">
                        {cardTxns.map((txn) => (
                          <div key={txn.id} className="flex items-center justify-between text-sm">
                            <span className="text-zinc-600">{txn.transactionType}</span>
                            <span className={`font-medium ${txn.amount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                              {txn.amount > 0 ? "+" : ""}{formatCurrency(txn.amount)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2">
                      {gc.status === "active" && (
                        <>
                          <form
                            action={(fd) => { startTransition(() => reloadGiftCardAction(fd)); }}
                            className="flex items-center gap-2"
                          >
                            <input type="hidden" name="giftCardId" value={gc.id} />
                            <input name="amount" type="number" step="0.01" min="0.01" placeholder="Reload $" className="w-24 rounded-lg border border-zinc-300 px-2 py-1 text-xs" />
                            <button type="submit" disabled={isPending} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                              Reload
                            </button>
                          </form>
                          <button
                            onClick={async () => {
                              // R37-H3 → R41-1: step-up via shared
                              // <PasswordGate> modal instead of
                              // window.prompt. Replaces native-ugly
                              // browser prompt with a proper in-page
                              // modal + inline error surface.
                              const pwd = await promptPassword({
                                title: `Disable gift card ${gc.code}?`,
                                description:
                                  "This zeroes the customer's balance and can't be undone. Enter your password to confirm.",
                                confirmLabel: "Disable",
                                confirmVariant: "destructive",
                              });
                              if (!pwd) return;
                              startTransition(async () => {
                                const r = await disableGiftCardAction(gc.id, pwd);
                                if (!r.success) {
                                  window.alert(r.error);
                                }
                              });
                            }}
                            disabled={isPending}
                            className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            Disable
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* R41-1: <PasswordGate> renders nothing when no prompt is
          active; safe to mount once at the component root. */}
      {passwordGate}
    </div>
  );
}
