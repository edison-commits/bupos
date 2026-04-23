"use client";

import { useState, useTransition } from "react";
import { acceptStocktakeAction, cancelStocktakeAction, createStocktakeAction, recordCountAction } from "@/app/admin/stocktake-actions";
import type { Stocktake, StocktakeLine, Location, ProductVariant, Product, Category, Employee } from "@/lib/domain/types";
// R50/R51: step-up <PasswordGate> on stocktake Accept. Backend
// (stocktake-actions.ts `acceptStocktakeAction`) gates on
// requireStepUp with bucketKey 'stocktake-accept-stepup' — a
// compromised manager cookie could doctor counted_qty on every
// high-value SKU before Accept applies adjustments in ABSOLUTE mode.
import { usePasswordGate } from "@/components/shared/password-gate";

const STATUS_COLORS: Record<string, string> = {
  in_progress: "bg-blue-100 text-blue-800",
  pending_review: "bg-amber-100 text-amber-800",
  accepted: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-red-100 text-red-800",
};

export function StocktakeManager({
  stocktakes, lines, locations, variants, products, categories, employees,
}: {
  stocktakes: Stocktake[];
  lines: StocktakeLine[];
  locations: Location[];
  variants: ProductVariant[];
  products: Product[];
  categories: Category[];
  employees: Employee[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [promptPassword, passwordGate] = usePasswordGate();

  const locMap = new Map(locations.map((l) => [l.id, l]));
  const varMap = new Map(variants.map((v) => [v.id, v]));
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total stocktakes</p>
          <p className="mt-1 text-2xl font-semibold">{stocktakes.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">In progress</p>
          <p className="mt-1 text-2xl font-semibold">{stocktakes.filter((s) => s.status === "in_progress").length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Accepted</p>
          <p className="mt-1 text-2xl font-semibold">{stocktakes.filter((s) => s.status === "accepted").length}</p>
        </div>
      </div>

      {/* Create button */}
      <button
        onClick={() => setShowCreate(!showCreate)}
        className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
      >
        {showCreate ? "Cancel" : "Start new stocktake"}
      </button>

      {showCreate && (
        <form
          action={(fd) => {
            startTransition(async () => {
              await createStocktakeAction(fd);
              setShowCreate(false);
            });
          }}
          className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3"
        >
          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium">
              <span>Location</span>
              <select name="locationId" required className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Count type</span>
              <select name="countType" className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                <option value="full">Full count</option>
                <option value="cycle">Cycle count (by category)</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              <span>Category filter (cycle only)</span>
              <select name="categoryFilter" className="rounded-xl border border-zinc-300 px-3 py-2 text-sm">
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-sm font-medium">
            <span>Notes (optional)</span>
            <input name="notes" className="rounded-xl border border-zinc-300 px-3 py-2 text-sm" />
          </label>
          <button type="submit" disabled={isPending} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {isPending ? "Creating..." : "Create stocktake"}
          </button>
        </form>
      )}

      {/* Stocktake list */}
      {stocktakes.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No stocktakes yet.</p>
      ) : (
        <div className="space-y-2">
          {stocktakes.map((st) => {
            const loc = locMap.get(st.locationId);
            const emp = empMap.get(st.initiatedBy);
            const stLines = lines.filter((l) => l.stocktakeId === st.id);
            const countedCount = stLines.filter((l) => l.countedQty != null).length;
            const totalVariance = stLines.filter((l) => l.variance != null).reduce((s, l) => s + Math.abs(l.variance ?? 0), 0);
            const isExpanded = selectedId === st.id;

            return (
              <div key={st.id} className="rounded-xl border border-zinc-200 bg-white">
                <button
                  onClick={() => setSelectedId(isExpanded ? null : st.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{st.countType === "full" ? "Full" : "Cycle"} count — {loc?.name ?? "?"}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[st.status]}`}>{st.status.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {emp?.displayName ?? "?"} · {new Date(st.createdAt).toLocaleDateString()} · {countedCount}/{stLines.length} counted · {totalVariance} unit variance
                    </p>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-3 space-y-3">
                    {/* Line items */}
                    <div className="space-y-1">
                      <div className="grid grid-cols-5 gap-2 text-xs font-semibold uppercase text-zinc-500 px-2">
                        <span className="col-span-2">Product</span>
                        <span className="text-right">Expected</span>
                        <span className="text-right">Counted</span>
                        <span className="text-right">Variance</span>
                      </div>
                      {stLines.map((line) => {
                        const variant = varMap.get(line.productVariantId);
                        const product = variant ? prodMap.get(variant.productId) : null;
                        return (
                          <div key={line.id} className="grid grid-cols-5 gap-2 items-center rounded-lg bg-zinc-50 px-2 py-1.5 text-sm">
                            <span className="col-span-2 truncate">{product?.name ?? "?"} — {variant?.name ?? line.productVariantId.slice(0, 8)}</span>
                            <span className="text-right">{line.expectedQty}</span>
                            <span className="text-right">
                              {st.status === "in_progress" ? (
                                <form
                                  action={(fd) => { startTransition(() => recordCountAction(fd)); }}
                                  className="inline-flex items-center gap-1"
                                >
                                  <input type="hidden" name="lineId" value={line.id} />
                                  <input
                                    name="countedQty"
                                    type="number"
                                    min="0"
                                    defaultValue={line.countedQty ?? ""}
                                    className="w-16 rounded border border-zinc-300 px-1 py-0.5 text-right text-xs"
                                  />
                                  <button type="submit" disabled={isPending} className="text-xs text-emerald-600 font-semibold">
                                    Save
                                  </button>
                                </form>
                              ) : (
                                line.countedQty ?? "—"
                              )}
                            </span>
                            <span className={`text-right font-medium ${
                              line.variance == null ? "" : line.variance === 0 ? "text-emerald-700" : "text-red-700"
                            }`}>
                              {line.variance != null ? (line.variance >= 0 ? "+" : "") + line.variance : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Actions */}
                    {st.status === "in_progress" && (
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            // R51: prompt for step-up password before
                            // committing the counted_qty → absolute-
                            // mode adjustments. Cancellation returns
                            // null → bail without calling the action.
                            const pwd = await promptPassword({
                              title: `Accept stocktake and apply adjustments?`,
                              description:
                                "This writes every counted qty to inventory in absolute mode. Can't be undone. Confirm with your password.",
                              confirmLabel: "Accept & apply",
                              confirmVariant: "default",
                            });
                            if (!pwd) return;
                            startTransition(async () => {
                              try {
                                await acceptStocktakeAction(st.id, pwd);
                              } catch (err) {
                                window.alert(err instanceof Error ? err.message : "Failed to accept stocktake");
                              }
                            });
                          }}
                          disabled={isPending || countedCount === 0}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Accept &amp; apply adjustments
                        </button>
                        <button
                          onClick={() => {
                            // R74-F: surface server failures. Prior shape fired
                            // the Server Action inside startTransition with no
                            // error path — "cannot cancel accepted stocktake",
                            // RBAC reverts, or revalidation hiccups landed in
                            // the console silently. Wrap in async try/catch +
                            // alert so ops see the reason, parity with the
                            // transfer-manager cancel fix.
                            startTransition(async () => {
                              try {
                                await cancelStocktakeAction(st.id);
                              } catch (e) {
                                window.alert(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
                              }
                            });
                          }}
                          disabled={isPending}
                          className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* R51: <PasswordGate> renders nothing when inactive; safe at root. */}
      {passwordGate}
    </div>
  );
}
