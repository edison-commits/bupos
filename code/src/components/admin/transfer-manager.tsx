"use client";

import { useState, useTransition } from "react";
import { cancelTransferAction, createTransferAction, receiveTransferAction, shipTransferAction } from "@/app/admin/transfer-actions";
import type { Transfer, TransferLine, Location, ProductVariant, Product, Employee } from "@/lib/domain/types";
// R68-H2: step-up prompt on transfer create. Server now gates on
// bucketKey:'transfer-create-stepup' (R68-H2 server fix); UI must
// thread actorPassword through the FormData.
import { usePasswordGate } from "@/components/shared/password-gate";

const STATUS_COLORS: Record<string, string> = {
  requested: "bg-blue-100 text-blue-800",
  in_transit: "bg-amber-100 text-amber-800",
  received: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-red-100 text-red-800",
};

export function TransferManager({
  transfers, transferLines, locations, variants, products, employees,
}: {
  transfers: Transfer[];
  transferLines: TransferLine[];
  locations: Location[];
  variants: ProductVariant[];
  products: Product[];
  employees: Employee[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [promptPassword, passwordGate] = usePasswordGate();

  // Create form state
  const [sourceLocationId, setSourceLocationId] = useState(locations[0]?.id ?? "");
  const [destLocationId, setDestLocationId] = useState(locations[1]?.id ?? locations[0]?.id ?? "");
  const [createLines, setCreateLines] = useState<{ productVariantId: string; quantity: number }[]>([]);
  const [selectedVariant, setSelectedVariant] = useState("");
  const [selectedQty, setSelectedQty] = useState(1);

  const locMap = new Map(locations.map((l) => [l.id, l]));
  const varMap = new Map(variants.map((v) => [v.id, v]));
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const empMap = new Map(employees.map((e) => [e.id, e]));

  const pendingCount = transfers.filter((t) => t.status === "requested" || t.status === "in_transit").length;

  function addLine() {
    if (!selectedVariant || selectedQty < 1) return;
    setCreateLines([...createLines, { productVariantId: selectedVariant, quantity: selectedQty }]);
    setSelectedVariant("");
    setSelectedQty(1);
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total transfers</p>
          <p className="mt-1 text-2xl font-semibold">{transfers.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Pending</p>
          <p className="mt-1 text-2xl font-semibold">{pendingCount}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Completed</p>
          <p className="mt-1 text-2xl font-semibold">{transfers.filter((t) => t.status === "received").length}</p>
        </div>
      </div>

      <button
        onClick={() => {
          // R70-L5: full reset on cancel/open so partially-typed
          // line rows, selected variant, and src/dest locations
          // from a prior attempt don't carry into the next form
          // session. Previously only createLines was cleared —
          // reopening the form after cancel showed the previous
          // src/dest selection which could accidentally submit
          // the wrong transfer if the user didn't re-verify.
          setShowCreate(!showCreate);
          setCreateLines([]);
          setSourceLocationId(locations[0]?.id ?? "");
          setDestLocationId(locations[1]?.id ?? locations[0]?.id ?? "");
          setSelectedVariant("");
          setSelectedQty(1);
        }}
        className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
      >
        {showCreate ? "Cancel" : "Create transfer"}
      </button>

      {showCreate && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium">
              <span>From location</span>
              <select value={sourceLocationId} onChange={(e) => setSourceLocationId(e.target.value)} className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>To location</span>
              <select value={destLocationId} onChange={(e) => setDestLocationId(e.target.value)} className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                {locations.filter((l) => l.id !== sourceLocationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          </div>

          {/* Add items */}
          <div className="flex items-end gap-2">
            <label className="grid flex-1 gap-1 text-sm font-medium">
              <span>Product variant</span>
              <select value={selectedVariant} onChange={(e) => setSelectedVariant(e.target.value)} className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                <option value="">Select variant</option>
                {variants.map((v) => {
                  const prod = prodMap.get(v.productId);
                  return <option key={v.id} value={v.id}>{prod?.name ?? "?"} — {v.name}</option>;
                })}
              </select>
            </label>
            <label className="grid w-24 gap-1 text-sm font-medium">
              <span>Qty</span>
              <input type="number" min="1" value={selectedQty} onChange={(e) => setSelectedQty(Number(e.target.value))} className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" />
            </label>
            <button onClick={addLine} className="rounded-xl bg-zinc-200 px-3 py-2 text-sm font-medium">Add</button>
          </div>

          {createLines.length > 0 && (
            <div className="space-y-1">
              {createLines.map((line, i) => {
                const v = varMap.get(line.productVariantId);
                const p = v ? prodMap.get(v.productId) : null;
                return (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-1 text-sm">
                    <span>{p?.name} — {v?.name} x{line.quantity}</span>
                    <button onClick={() => setCreateLines(createLines.filter((_, j) => j !== i))} className="text-xs text-red-600">Remove</button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            disabled={isPending || createLines.length === 0}
            onClick={async () => {
              // R68-H2: prompt for step-up password before creating
              // the transfer. Inventory moves between locations —
              // stolen cookie shouldn't be able to drain source
              // stock to an accomplice-accessible location without
              // password re-auth.
              const pwd = await promptPassword({
                title: "Create transfer?",
                description:
                  "Transfers drain inventory at the source and credit it at the destination. Confirm with your password.",
                confirmLabel: "Create transfer",
                confirmVariant: "default",
              });
              if (!pwd) return;
              const fd = new FormData();
              fd.set("sourceLocationId", sourceLocationId);
              fd.set("destinationLocationId", destLocationId);
              fd.set("lines", JSON.stringify(createLines));
              fd.set("actorPassword", pwd);
              startTransition(async () => {
                try {
                  await createTransferAction(fd);
                  setShowCreate(false);
                  setCreateLines([]);
                } catch (err) {
                  window.alert(err instanceof Error ? err.message : "Failed to create transfer");
                }
              });
            }}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isPending ? "Creating..." : "Create transfer"}
          </button>
        </div>
      )}

      {/* Transfer list */}
      {transfers.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No transfers yet.</p>
      ) : (
        <div className="space-y-2">
          {transfers.map((tr) => {
            const from = locMap.get(tr.sourceLocationId);
            const to = locMap.get(tr.destinationLocationId);
            const reqBy = empMap.get(tr.requestedBy);
            const trLines = transferLines.filter((l) => l.transferId === tr.id);
            const isExpanded = selectedId === tr.id;

            return (
              <div key={tr.id} className="rounded-xl border border-zinc-200 bg-white">
                <button
                  onClick={() => setSelectedId(isExpanded ? null : tr.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{from?.name ?? "?"} → {to?.name ?? "?"}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[tr.status]}`}>{tr.status.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {reqBy?.displayName ?? "?"} · {new Date(tr.createdAt).toLocaleDateString()} · {trLines.length} items
                    </p>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-3 space-y-3">
                    {trLines.map((line) => {
                      const v = varMap.get(line.productVariantId);
                      const p = v ? prodMap.get(v.productId) : null;
                      return (
                        <div key={line.id} className="flex items-center justify-between text-sm">
                          <span>{p?.name} — {v?.name}</span>
                          <span>
                            Req: {line.quantityRequested}
                            {line.quantityShipped != null && ` · Ship: ${line.quantityShipped}`}
                            {line.quantityReceived != null && ` · Recv: ${line.quantityReceived}`}
                          </span>
                        </div>
                      );
                    })}

                    <div className="flex gap-2">
                      {tr.status === "requested" && (
                        <>
                          <button
                            onClick={async () => {
                              // R70-M1: step-up before draining source
                              // inventory via ship.
                              const pwd = await promptPassword({
                                title: "Ship transfer?",
                                description:
                                  "Shipping drains inventory at the source location. Confirm with your password.",
                                confirmLabel: "Mark shipped",
                                confirmVariant: "default",
                              });
                              if (!pwd) return;
                              startTransition(async () => {
                                try {
                                  await shipTransferAction(tr.id, pwd);
                                } catch (err) {
                                  window.alert(err instanceof Error ? err.message : "Failed to ship transfer");
                                }
                              });
                            }}
                            disabled={isPending}
                            className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                          >
                            Mark shipped
                          </button>
                          <button
                            onClick={() => { startTransition(() => cancelTransferAction(tr.id)); }}
                            disabled={isPending}
                            className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {tr.status === "in_transit" && (
                        <button
                          onClick={async () => {
                            // R72-C: step-up on receive — mirror of ship prompt.
                            const pwd = await promptPassword({
                              title: "Receive transfer?",
                              description:
                                "Receiving credits inventory to the destination location. Confirm with your password.",
                              confirmLabel: "Mark received",
                              confirmVariant: "default",
                            });
                            if (!pwd) return;
                            startTransition(async () => {
                              try {
                                await receiveTransferAction(tr.id, pwd);
                              } catch (err) {
                                window.alert(err instanceof Error ? err.message : "Failed to receive transfer");
                              }
                            });
                          }}
                          disabled={isPending}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Mark received
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* R68-H2: <PasswordGate> renders nothing when inactive. */}
      {passwordGate}
    </div>
  );
}
