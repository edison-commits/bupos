"use client";

import { useState, useMemo } from "react";
import { NumpadInput } from "./numpad-input";
import { formatCurrency } from "@/lib/format";

interface DenominationRow {
  label: string;
  value: number;
  count: number;
}

const DENOMINATIONS: { label: string; value: number }[] = [
  { label: "$100", value: 100 },
  { label: "$50", value: 50 },
  { label: "$20", value: 20 },
  { label: "$10", value: 10 },
  { label: "$5", value: 5 },
  { label: "$1", value: 1 },
  { label: "Quarters", value: 0.25 },
  { label: "Dimes", value: 0.10 },
  { label: "Nickels", value: 0.05 },
  { label: "Pennies", value: 0.01 },
];

interface ShiftCloseModalProps {
  expectedCash: number;
  openingFloat: number;
  shiftOpenedAt: string;
  cashierName: string;
  transactionCount: number;
  salesTotal: number;
  tenderBreakdown: { type: string; total: number; count: number }[];
  onConfirm: (declaredCash: number, note: string, blind: boolean) => void;
  onCancel: () => void;
  // R78-FE-H1: processing flag from parent (register-console-client
  // closing state). Prior shape had no disabled state on the
  // "Close shift" button — a double-tap during the closeShift
  // server round-trip fired closeShiftEnhancedAction twice,
  // burning audit rows + rate-limit budget. Plumb through so
  // the button disables while the parent's mutation is in flight.
  processing?: boolean;
}

export function ShiftCloseModal({
  expectedCash,
  openingFloat,
  shiftOpenedAt,
  cashierName,
  transactionCount,
  salesTotal,
  tenderBreakdown,
  onConfirm,
  onCancel,
  processing = false,
}: ShiftCloseModalProps) {
  const [mode, setMode] = useState<"summary" | "count" | "confirm">("summary");
  const [denominations, setDenominations] = useState<DenominationRow[]>(
    DENOMINATIONS.map((d) => ({ ...d, count: 0 })),
  );
  const [manualTotal, setManualTotal] = useState<string>("");
  const [useManual, setUseManual] = useState(false);
  const [note, setNote] = useState("");
  const [blindClose, setBlindClose] = useState(false);

  const countedTotal = useMemo(() => {
    if (useManual) return Number(manualTotal) || 0;
    return Number(
      denominations.reduce((sum, d) => sum + d.value * d.count, 0).toFixed(2),
    );
  }, [denominations, useManual, manualTotal]);

  const variance = Number((countedTotal - expectedCash).toFixed(2));

  const updateDenomination = (index: number, count: number) => {
    setDenominations((prev) =>
      prev.map((d, i) => (i === index ? { ...d, count: Math.max(0, count) } : d)),
    );
  };

  const [shiftDuration] = useState(() => {
    const ms = new Date().getTime() - new Date(shiftOpenedAt).getTime();
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  });

  // ── Summary screen ──────────────────────────────────────
  if (mode === "summary") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-6 py-5">
            <h2 className="text-xl font-bold">Close shift</h2>
            <p className="mt-1 text-sm text-zinc-500">{cashierName} · opened {new Date(shiftOpenedAt).toLocaleTimeString()} · {shiftDuration}</p>
          </div>

          <div className="px-6 py-5">
            {/* Shift stats */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Transactions" value={String(transactionCount)} />
              <StatCard label="Sales total" value={`${formatCurrency(salesTotal)}`} />
              <StatCard label="Expected cash" value={`${formatCurrency(expectedCash)}`} />
            </div>

            {/* Tender breakdown */}
            {tenderBreakdown.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-semibold text-zinc-600">Tender breakdown</h3>
                <div className="space-y-1">
                  {tenderBreakdown.map((t) => (
                    <div key={t.type} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                      <span className="capitalize">{t.type === "store_credit" ? "Store credit" : t.type}</span>
                      <span className="font-semibold">{t.count} txn · {formatCurrency(t.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Opening float reminder */}
            <div className="mt-5 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
              Opening float: <span className="font-semibold">{formatCurrency(openingFloat)}</span>
            </div>
          </div>

          <div className="flex gap-3 border-t border-zinc-100 px-6 py-4">
            <button
              type="button"
              onClick={onCancel}
              className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setBlindClose(true);
                setMode("confirm");
              }}
              className="touch-button flex-1 rounded-xl bg-zinc-700 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              Blind close
            </button>
            <button
              type="button"
              onClick={() => setMode("count")}
              className="touch-button flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white hover:bg-amber-700"
            >
              Count drawer
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Drawer count screen ─────────────────────────────────
  if (mode === "count") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-6 py-5">
            <h2 className="text-xl font-bold">Count drawer</h2>
            <p className="mt-1 text-sm text-zinc-500">Count all cash in the drawer including the opening float.</p>
          </div>

          <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
            {/* Toggle: denomination vs manual */}
            <div className="mb-4 flex rounded-xl bg-zinc-100 p-1">
              <button
                type="button"
                onClick={() => setUseManual(false)}
                className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${!useManual ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
              >
                By denomination
              </button>
              <button
                type="button"
                onClick={() => setUseManual(true)}
                className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${useManual ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
              >
                Manual total
              </button>
            </div>

            {useManual ? (
              <label className="grid gap-1">
                <span className="text-base font-medium text-zinc-600">Total cash in drawer</span>
                <NumpadInput
                  value={manualTotal}
                  onChange={setManualTotal}
                  placeholder="0.00"
                  label="Cash total"
                  prefix="$"
                />
              </label>
            ) : (
              <div className="space-y-2">
                {denominations.map((d, i) => (
                  <div key={d.label} className="flex items-center gap-3">
                    <span className="w-20 text-sm font-medium text-zinc-600">{d.label}</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => updateDenomination(i, d.count - 1)}
                        className="touch-button h-10 w-10 rounded-lg bg-zinc-100 text-lg font-bold text-zinc-600 hover:bg-zinc-200"
                      >
                        −
                      </button>
                      <span className="w-10 text-center text-base font-bold tabular-nums">{d.count}</span>
                      <button
                        type="button"
                        onClick={() => updateDenomination(i, d.count + 1)}
                        className="touch-button h-10 w-10 rounded-lg bg-zinc-100 text-lg font-bold text-zinc-600 hover:bg-zinc-200"
                      >
                        +
                      </button>
                    </div>
                    <span className="ml-auto text-sm font-semibold text-zinc-700">
                      {formatCurrency((d.value * d.count))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Totals bar */}
          <div className="border-t border-zinc-100 px-6 py-4">
            <div className="mb-3 grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
                <p className="text-zinc-500">Counted</p>
                <p className="text-lg font-bold">{formatCurrency(countedTotal)}</p>
              </div>
              <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
                <p className="text-zinc-500">Expected</p>
                <p className="text-lg font-bold">{formatCurrency(expectedCash)}</p>
              </div>
              <div className={`rounded-xl px-3 py-2 text-center ${
                variance === 0
                  ? "bg-emerald-50"
                  : Math.abs(variance) <= 1
                    ? "bg-amber-50"
                    : "bg-red-50"
              }`}>
                <p className="text-zinc-500">Variance</p>
                <p className={`text-lg font-bold ${
                  variance === 0
                    ? "text-emerald-700"
                    : Math.abs(variance) <= 1
                      ? "text-amber-700"
                      : "text-red-700"
                }`}>
                  {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setMode("summary")}
                className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setBlindClose(false);
                  setMode("confirm");
                }}
                disabled={countedTotal === 0 && !useManual}
                className="touch-button flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Confirmation screen ─────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-6 py-5">
          <h2 className="text-xl font-bold">
            {blindClose ? "Confirm blind close" : "Confirm shift close"}
          </h2>
        </div>

        <div className="px-6 py-5 space-y-4">
          {blindClose ? (
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Blind close skips the drawer count. The expected cash amount (<span className="font-semibold">{formatCurrency(expectedCash)}</span>) will be recorded as the declared amount. Variance will be $0.00.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
                <p className="text-zinc-500">Counted</p>
                <p className="text-lg font-bold">{formatCurrency(countedTotal)}</p>
              </div>
              <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
                <p className="text-zinc-500">Expected</p>
                <p className="text-lg font-bold">{formatCurrency(expectedCash)}</p>
              </div>
              <div className={`rounded-xl px-3 py-2 text-center ${
                variance === 0 ? "bg-emerald-50" : Math.abs(variance) <= 1 ? "bg-amber-50" : "bg-red-50"
              }`}>
                <p className="text-zinc-500">Variance</p>
                <p className={`text-lg font-bold ${
                  variance === 0 ? "text-emerald-700" : Math.abs(variance) <= 1 ? "text-amber-700" : "text-red-700"
                }`}>
                  {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                </p>
              </div>
            </div>
          )}

          {Math.abs(variance) > 5 && !blindClose && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
              Large variance detected. Consider recounting. This will be logged and visible to managers.
            </div>
          )}

          <label className="grid gap-1">
            <span className="text-sm font-medium text-zinc-600">Closing note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Any notes about the drawer count or shift..."
              className="min-h-20 rounded-xl border border-zinc-300 px-4 py-3 text-sm"
            />
          </label>
        </div>

        <div className="flex gap-3 border-t border-zinc-100 px-6 py-4">
          <button
            type="button"
            onClick={() => setMode(blindClose ? "summary" : "count")}
            disabled={processing}
            className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Back
          </button>
          <button
            type="button"
            disabled={processing}
            onClick={() => {
              const declared = blindClose ? expectedCash : countedTotal;
              onConfirm(declared, note.trim(), blindClose);
            }}
            className="touch-button flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {processing ? "Closing…" : "Close shift"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-3 py-2 text-center">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}
