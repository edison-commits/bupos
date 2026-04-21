"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { NumpadInput } from "./numpad-input";
import { formatCurrency } from "@/lib/format";

interface EODWizardProps {
  expectedCash: number;
  openingFloat: number;
  shiftOpenedAt: string;
  cashierName: string;
  transactionCount: number;
  salesTotal: number;
  tenderBreakdown: { type: string; total: number; count: number }[];
  onCloseShift: (declaredCash: number, note: string, blind: boolean) => Promise<void>;
  onCancel: () => void;
  dailyReportUrl?: string;
}

type Step = 1 | 2 | 3 | 4;

const DENOMINATION_BUTTONS = [
  { label: "$100", value: 100 },
  { label: "$50", value: 50 },
  { label: "$20", value: 20 },
  { label: "$10", value: 10 },
  { label: "$5", value: 5 },
  { label: "$1", value: 1 },
  { label: "$0.25", value: 0.25 },
  { label: "$0.10", value: 0.1 },
  { label: "$0.05", value: 0.05 },
  { label: "$0.01", value: 0.01 },
];

export function EODWizard({
  expectedCash,
  openingFloat: _openingFloat,
  shiftOpenedAt,
  cashierName,
  transactionCount,
  salesTotal,
  tenderBreakdown,
  onCloseShift,
  onCancel,
  dailyReportUrl,
}: EODWizardProps) {
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [declaredCash, setDeclaredCash] = useState<number>(0);
  const [closingNote, setClosingNote] = useState<string>("");
  const [blindClose, setBlindClose] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const variance = declaredCash - expectedCash;
  const varianceColor =
    variance === 0 ? "text-emerald-600" : Math.abs(variance) < 1 ? "text-amber-600" : "text-red-600";

  const handleAddDenomination = (value: number) => {
    setDeclaredCash((prev) => parseFloat((prev + value).toFixed(2)));
  };

  const _handleDeclaredCashChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value ? parseFloat(e.target.value) : 0;
    setDeclaredCash(isNaN(val) ? 0 : val);
  };

  const handleCloseShiftClick = async () => {
    setLoading(true);
    setError(null);
    try {
      await onCloseShift(declaredCash, closingNote, blindClose);
      setCurrentStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close shift");
    } finally {
      setLoading(false);
    }
  };

  const handleSendDailyReport = async () => {
    if (!dailyReportUrl) return;
    try {
      const response = await fetch(dailyReportUrl, { method: "POST" });
      if (!response.ok) {
        throw new Error("Failed to send daily report");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send daily report");
    }
  };

  const formatDateTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString();
    } catch {
      return isoString;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
        {/* Header with progress bar */}
        <div className="border-b border-zinc-200 bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-6 text-white">
          <h2 className="text-2xl font-bold">End of Day Close</h2>
          <p className="mt-1 text-sm text-teal-100">Step {currentStep} of 4</p>

          {/* Progress bar */}
          <div className="mt-4 flex gap-2">
            {[1, 2, 3, 4].map((step) => (
              <div
                key={step}
                className={`h-2 flex-1 rounded-full transition-colors ${
                  step <= currentStep ? "bg-white" : "bg-teal-400"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Step 1: Review Summary */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                  <p className="text-sm text-zinc-500">Cashier</p>
                  <p className="mt-2 text-xl font-semibold">{cashierName}</p>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                  <p className="text-sm text-zinc-500">Shift opened</p>
                  <p className="mt-2 text-xl font-semibold">{formatDateTime(shiftOpenedAt)}</p>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                  <p className="text-sm text-zinc-500">Transactions</p>
                  <p className="mt-2 text-xl font-semibold">{transactionCount}</p>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                  <p className="text-sm text-zinc-500">Total sales</p>
                  <p className="mt-2 text-xl font-semibold">{formatCurrency(salesTotal)}</p>
                </div>
              </div>

              {/* Tender breakdown table */}
              <div className="rounded-2xl border border-zinc-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-zinc-50 border-b border-zinc-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-zinc-700">Tender type</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-zinc-700">Count</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-zinc-700">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenderBreakdown.map((tender, idx) => (
                      <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-zinc-50"}>
                        <td className="px-4 py-3 text-sm font-medium text-zinc-900 capitalize">{tender.type}</td>
                        <td className="px-4 py-3 text-right text-sm text-zinc-600">{tender.count}</td>
                        <td className="px-4 py-3 text-right text-sm font-semibold text-zinc-900">
                          {formatCurrency(tender.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            </div>
          )}

          {/* Step 2: Count Drawer */}
          {currentStep === 2 && (
            <div className="space-y-6">
              {/* Expected cash display */}
              <div className="rounded-2xl bg-teal-50 border-2 border-teal-200 px-6 py-6 text-center">
                {!blindClose && (
                  <>
                    <p className="text-sm text-teal-700">Expected cash</p>
                    <p className="mt-2 text-4xl font-bold text-teal-700">{formatCurrency(expectedCash)}</p>
                  </>
                )}
                {blindClose && (
                  <p className="text-sm text-teal-700 font-semibold">Blind close mode</p>
                )}
              </div>

              {/* Declared cash input */}
              <div className="space-y-2">
                <label className="block text-base font-semibold text-zinc-700">Declared cash</label>
                <NumpadInput
                  value={String(declaredCash || "")}
                  onChange={(v) => setDeclaredCash(Number(v) || 0)}
                  placeholder="0.00"
                  label="Declared cash"
                  prefix="$"
                />
              </div>

              {/* Quick-add denomination buttons */}
              <div className="space-y-2">
                <p className="text-sm font-semibold text-zinc-700">Quick add</p>
                <div className="grid grid-cols-5 gap-2">
                  {DENOMINATION_BUTTONS.map((denom) => (
                    <button
                      key={denom.value}
                      type="button"
                      onClick={() => handleAddDenomination(denom.value)}
                      className="touch-button rounded-2xl bg-zinc-100 px-2 py-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-200 active:bg-zinc-300"
                    >
                      {denom.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Running total */}
              <div className="space-y-1 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                <p className="text-sm text-zinc-500">Running total</p>
                <p className="text-3xl font-bold text-zinc-900">{formatCurrency(declaredCash)}</p>
              </div>

              {/* Variance display */}
              <div className="space-y-1 rounded-2xl border-2 border-zinc-200 px-4 py-4">
                <p className="text-sm text-zinc-500">Variance</p>
                <p className={`text-3xl font-bold ${varianceColor}`}>
                  {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                </p>
                <p className="mt-2 text-xs text-zinc-600">
                  {variance === 0 && "Perfect count"}
                  {variance > 0 && variance < 1 && "Minor overage"}
                  {variance >= 1 && "Significant overage"}
                  {variance < 0 && variance > -1 && "Minor shortage"}
                  {variance <= -1 && "Significant shortage"}
                </p>
              </div>

              {/* Blind close checkbox */}
              <label className="flex items-center gap-3 rounded-2xl border border-zinc-200 px-4 py-4 cursor-pointer hover:bg-zinc-50">
                <input
                  type="checkbox"
                  checked={blindClose}
                  onChange={(e) => setBlindClose(e.target.checked)}
                  className="h-5 w-5 rounded border-zinc-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm font-medium text-zinc-700">Blind close (hide expected amount)</span>
              </label>

              {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            </div>
          )}

          {/* Step 3: Close Notes */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
                <p className="text-sm font-semibold text-zinc-700">Closing summary</p>
                <div className="mt-3 space-y-2 text-sm text-zinc-600">
                  <p>Shift is ready to close</p>
                  <p>Expected cash: {formatCurrency(expectedCash)}</p>
                  <p>Declared cash: {formatCurrency(declaredCash)}</p>
                  <p className={`font-semibold ${varianceColor}`}>
                    Variance: {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-zinc-700">Closing notes (optional)</label>
                <textarea
                  value={closingNote}
                  onChange={(e) => setClosingNote(e.target.value)}
                  placeholder="Any notes about the close, drawer condition, or variance..."
                  className="min-h-32 w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm focus:border-teal-400 focus:outline-none"
                />
              </div>

              {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            </div>
          )}

          {/* Step 4: Confirmation */}
          {currentStep === 4 && (
            <div className="space-y-6 text-center">
              <div className="flex justify-center">
                <div className="rounded-full bg-emerald-50 p-6">
                  <CheckCircle2 className="h-16 w-16 text-emerald-600" />
                </div>
              </div>

              <div>
                <h3 className="text-2xl font-bold text-zinc-900">Shift closed successfully</h3>
                <p className="mt-2 text-zinc-600">The shift has been recorded with all variance details.</p>
              </div>

              <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4 text-left">
                <p className="text-sm text-zinc-500">Final variance</p>
                <p className={`mt-2 text-2xl font-bold ${varianceColor}`}>
                  {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="border-t border-zinc-200 bg-zinc-50 px-6 py-4 flex gap-3">
          {currentStep === 4 ? (
            <>
              {dailyReportUrl && (
                <button
                  type="button"
                  onClick={handleSendDailyReport}
                  className="touch-button flex-1 rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
                >
                  Send daily report
                </button>
              )}
              <button
                type="button"
                onClick={onCancel}
                className="touch-button flex-1 rounded-2xl bg-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-300"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                className="touch-button flex-1 rounded-2xl bg-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-300"
              >
                Cancel
              </button>
              {currentStep < 3 && (
                <button
                  type="button"
                  onClick={() => setCurrentStep((prev) => (prev + 1) as Step)}
                  className="touch-button flex-1 rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
                >
                  Next
                </button>
              )}
              {currentStep === 3 && (
                <button
                  type="button"
                  onClick={handleCloseShiftClick}
                  disabled={loading}
                  className="touch-button flex-1 rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                >
                  {loading ? "Closing…" : "Close shift"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
