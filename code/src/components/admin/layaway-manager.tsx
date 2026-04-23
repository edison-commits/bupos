"use client";

import { useState, useTransition } from "react";
import { cancelLayawayAction, collectLayawayAction, makeLayawayPaymentAction, type LayawayCancelDisposition } from "@/app/admin/layaway-actions";
import type { Layaway, LayawayPayment, Customer, Employee } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";
// R52-J: step-up <PasswordGate> prompts for makeLayawayPayment
// (server bucketKey:'layaway-payment-stepup') and cancelLayaway on
// refund dispositions (bucketKey:'layaway-cancel-stepup'). Prior
// UI didn't thread actorPassword so every payment and every refund
// cancel threw "password required".
import { usePasswordGate } from "@/components/shared/password-gate";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-blue-100 text-blue-800",
  partially_paid: "bg-amber-100 text-amber-800",
  paid_in_full: "bg-emerald-100 text-emerald-800",
  collected: "bg-zinc-100 text-zinc-600",
  cancelled: "bg-red-100 text-red-800",
  forfeited: "bg-red-100 text-red-800",
};

export function LayawayManager({
  layaways,
  payments,
  customers,
  employees,
}: {
  layaways: Layaway[];
  payments: LayawayPayment[];
  customers: Customer[];
  employees: Employee[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelDisposition, setCancelDisposition] = useState<LayawayCancelDisposition>("refund_cash");
  const [promptPassword, passwordGate] = usePasswordGate();

  const custMap = new Map(customers.map((c) => [c.id, c]));
  const empMap = new Map(employees.map((e) => [e.id, e]));

  const activeCount = layaways.filter((l) => l.status === "active" || l.status === "partially_paid").length;
  const totalBalanceDue = layaways
    .filter((l) => l.status === "active" || l.status === "partially_paid")
    .reduce((s, l) => s + l.balanceDue, 0);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total layaways</p>
          <p className="mt-1 text-2xl font-semibold">{layaways.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Active</p>
          <p className="mt-1 text-2xl font-semibold">{activeCount}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Balance outstanding</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(totalBalanceDue)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Payments recorded</p>
          <p className="mt-1 text-2xl font-semibold">{payments.length}</p>
        </div>
      </div>

      {/* Layaway list */}
      {layaways.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No layaways yet. Layaways are created from the register during checkout.</p>
      ) : (
        <div className="space-y-2">
          {layaways.map((lay) => {
            const customer = custMap.get(lay.customerId);
            const employee = empMap.get(lay.employeeId);
            const layPayments = payments.filter((p) => p.layawayId === lay.id);
            const isExpanded = selectedId === lay.id;

            return (
              <div key={lay.id} className="rounded-xl border border-zinc-200 bg-white">
                <button
                  onClick={() => setSelectedId(isExpanded ? null : lay.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {customer ? `${customer.firstName} ${customer.lastName}` : "Unknown customer"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[lay.status]}`}>
                        {lay.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      Total: {formatCurrency(lay.grandTotal)} · Paid: {formatCurrency(lay.depositPaid)} · Due: {formatCurrency(lay.balanceDue)}
                      {lay.dueDate ? ` · Due: ${lay.dueDate}` : ""}
                    </p>
                  </div>
                  <span className="text-lg font-semibold">{formatCurrency(lay.balanceDue)}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-3 space-y-3">
                    <div className="text-xs text-zinc-500">
                      Created by {employee?.displayName ?? "?"} on {new Date(lay.createdAt).toLocaleDateString()}
                    </div>

                    {/* Payment history */}
                    {layPayments.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Payments</p>
                        {layPayments.map((p) => {
                          const pEmp = empMap.get(p.employeeId);
                          return (
                            <div key={p.id} className="flex items-center justify-between text-sm">
                              <span className="text-zinc-600">
                                {p.tenderType} · {pEmp?.displayName ?? "?"} · {new Date(p.createdAt).toLocaleDateString()}
                              </span>
                              <span className="font-medium text-emerald-700">{formatCurrency(p.amount)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2">
                      {(lay.status === "active" || lay.status === "partially_paid") && (
                        <form
                          onSubmit={async (e) => {
                            // R52-J: prompt for step-up password
                            // before recording layaway payment. Server
                            // gates unconditionally on
                            // bucketKey:'layaway-payment-stepup'.
                            e.preventDefault();
                            const form = e.currentTarget;
                            const fd = new FormData(form);
                            const amount = Number(fd.get("amount"));
                            if (!Number.isFinite(amount) || amount <= 0) return;
                            const pwd = await promptPassword({
                              title: `Record ${formatCurrency(amount)} layaway payment?`,
                              description:
                                "Confirm with your password — layaway payments move money and require step-up.",
                              confirmLabel: "Record payment",
                              confirmVariant: "default",
                            });
                            if (!pwd) return;
                            fd.set("actorPassword", pwd);
                            startTransition(async () => {
                              try {
                                await makeLayawayPaymentAction(fd);
                              } catch (err) {
                                window.alert(err instanceof Error ? err.message : "Failed to record payment");
                              }
                            });
                          }}
                          className="flex items-center gap-2"
                        >
                          <input type="hidden" name="layawayId" value={lay.id} />
                          <input name="amount" type="number" step="0.01" min="0.01" max={lay.balanceDue} placeholder="Amount $" className="w-24 rounded-lg border border-zinc-300 px-2 py-1 text-xs" />
                          <select name="tenderType" className="rounded-lg border border-zinc-300 px-2 py-1 text-xs">
                            <option value="cash">Cash</option>
                            <option value="card">Card</option>
                            <option value="store_credit">Store credit</option>
                          </select>
                          <button type="submit" disabled={isPending} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                            Pay
                          </button>
                        </form>
                      )}

                      {lay.status === "paid_in_full" && (
                        <button
                          onClick={() => {
                            // R75-F: surface Server Action errors. Prior
                            // shape swallowed throws into React's
                            // transition boundary — Mark collected did
                            // nothing visible on RBAC reject or
                            // inventory-missing errors.
                            startTransition(async () => {
                              try {
                                await collectLayawayAction(lay.id);
                              } catch (err) {
                                window.alert(
                                  `Collect failed: ${err instanceof Error ? err.message : String(err)}`,
                                );
                              }
                            });
                          }}
                          disabled={isPending}
                          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Mark collected
                        </button>
                      )}

                      {(lay.status === "active" || lay.status === "partially_paid") && (
                        cancelId === lay.id ? (
                          <div className="flex items-center gap-2">
                            {/* R10-M-1/R11-M-1: disposition required — the deposit
                                has to land somewhere. Defaults to cash refund (most
                                common). */}
                            <select
                              value={cancelDisposition}
                              onChange={(e) => setCancelDisposition(e.target.value as LayawayCancelDisposition)}
                              className="rounded-lg border border-zinc-300 px-2 py-1 text-xs"
                            >
                              <option value="refund_cash">Refund cash</option>
                              <option value="refund_store_credit">Store credit</option>
                              <option value="forfeit_with_approval">Forfeit (owner)</option>
                            </select>
                            <input
                              type="text"
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                              placeholder="Reason"
                              className="w-32 rounded-lg border border-zinc-300 px-2 py-1 text-xs"
                            />
                            <button
                              onClick={async () => {
                                // R52-J: server gates
                                // `refund_cash` and
                                // `refund_store_credit` on
                                // bucketKey:'layaway-cancel-stepup'
                                // (cancelLayawayAction takes
                                // actorPassword as 4th arg). The
                                // `forfeit_with_approval` branch
                                // skips step-up server-side (owner-
                                // only), so skip the prompt there.
                                let pwd: string | undefined;
                                if (cancelDisposition === "refund_cash" || cancelDisposition === "refund_store_credit") {
                                  const p = await promptPassword({
                                    title: "Cancel layaway with refund?",
                                    description:
                                      "This refunds the customer's deposit " +
                                      (cancelDisposition === "refund_cash" ? "in cash" : "as store credit") +
                                      " and cannot be undone. Confirm with your password.",
                                    confirmLabel: "Confirm cancel",
                                    confirmVariant: "destructive",
                                  });
                                  if (!p) return;
                                  pwd = p;
                                }
                                startTransition(async () => {
                                  try {
                                    await cancelLayawayAction(lay.id, cancelReason, cancelDisposition, pwd);
                                    setCancelId(null);
                                    setCancelReason("");
                                    setCancelDisposition("refund_cash");
                                  } catch (err) {
                                    window.alert(err instanceof Error ? err.message : "Failed to cancel layaway");
                                  }
                                });
                              }}
                              disabled={isPending}
                              className="rounded-lg bg-red-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              Confirm cancel
                            </button>
                            <button onClick={() => { setCancelId(null); setCancelReason(""); setCancelDisposition("refund_cash"); }} className="text-xs text-zinc-500">
                              Back
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setCancelId(lay.id)}
                            className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            Cancel layaway
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* R52-J: <PasswordGate> renders nothing when inactive. */}
      {passwordGate}
    </div>
  );
}
