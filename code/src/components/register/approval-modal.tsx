"use client";

import { useState, useEffect, useRef } from "react";
import { verifyManagerApproval, type ApprovalRequest, type ApprovalResult } from "@/app/register/approval-action";
import { formatCurrency } from "@/lib/format";

interface ApprovalModalProps {
  request: ApprovalRequest;
  onApproved: (result: ApprovalResult) => void;
  onDenied: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  discount_threshold: "Discount exceeds threshold",
  item_void: "Item void exceeds threshold",
  transaction_void: "Transaction void exceeds threshold",
  store_credit: "Store credit issuance exceeds threshold",
  price_override: "Price override exceeds threshold",
  return: "Return exceeds threshold",
};

const REASON_CODES = [
  { value: "customer_request", label: "Customer request" },
  { value: "pricing_correction", label: "Pricing correction" },
  { value: "manager_instruction", label: "Manager instruction" },
  { value: "damaged_item", label: "Damaged item" },
  { value: "loyalty_adjustment", label: "Loyalty adjustment" },
  { value: "other", label: "Other" },
];

export function ApprovalModal({ request, onApproved, onDenied }: ApprovalModalProps) {
  const [pin, setPin] = useState("");
  const [reasonCode, setReasonCode] = useState("customer_request");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R34-D7: ref-based re-entry guard prevents a rapid double-tap
  // from firing two concurrent verifyManagerApproval requests (each
  // burning a rate-limit attempt + potentially double-logging
  // audit events). React state updates are async so the first
  // `setProcessing(true)` hasn't committed when the second click
  // arrives — the ref short-circuits synchronously.
  const submitInFlightRef = useRef(false);
  // R34-D7: mount flag so async `verifyManagerApproval` completions
  // after unmount don't fire setState on an already-dismissed modal
  // (React warning + stale onApproved propagation).
  const mountedRef = useRef(true);

  // R43-M: Tab focus trap — keyboard can't escape into the background
  // while the modal is open. Prior shape only handled Escape.
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Escape key + backdrop click to dismiss
  useEffect(() => {
    mountedRef.current = true;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onDenied();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !modalRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !modalRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("keydown", onKey);
    };
  }, [onDenied]);

  async function handleSubmit() {
    // R32-X2: managers/owners may have 6-digit PINs (R27-H1 enforced
    // for privileged roles). Prior `length !== 4` hard-reject made
    // every 6-digit manager approval impossible — breaks discount,
    // price-override, and return threshold flows entirely.
    if (pin.length < 4 || pin.length > 6) {
      setError("Enter a 4-6 digit manager PIN.");
      return;
    }

    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setProcessing(true);
    setError(null);

    try {
      const result = await verifyManagerApproval(pin, { ...request, reasonCode });
      if (!mountedRef.current) return;

      if (result.approved) {
        onApproved(result);
      } else {
        setError(result.reason ?? "Approval denied.");
        setPin("");
      }
    } catch {
      if (mountedRef.current) {
        setError("Approval verification failed. Try again.");
      }
    } finally {
      submitInFlightRef.current = false;
      if (mountedRef.current) setProcessing(false);
    }
  }

  function handlePinPad(digit: string) {
    // R32-X2: accept 4-6 digits to match server-side pinString regex
    // and support privileged roles' 6-digit PINs.
    if (pin.length < 6) {
      setPin((prev) => prev + digit);
    }
  }

  function handleClear() {
    setPin("");
    setError(null);
  }

  function handleBackspace() {
    setPin((prev) => prev.slice(0, -1));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Manager approval required" onClick={onDenied}>
      <div ref={modalRef} className="w-full max-w-sm rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>

        {/* Header — amber warning style */}
        <div className="rounded-t-2xl bg-amber-600 px-5 py-4 text-white">
          <h2 className="text-lg font-bold">Manager approval required</h2>
          <p className="mt-1 text-sm text-amber-100">{ACTION_LABELS[request.actionType] ?? request.actionType}</p>
        </div>

        {/* Details */}
        <div className="border-b border-zinc-100 px-5 py-3">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Amount</span>
            <span className="font-semibold text-red-700">{formatCurrency(request.triggerAmount)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Threshold</span>
            <span className="font-medium">{formatCurrency(request.thresholdAmount)}</span>
          </div>
        </div>

        {/* Reason code */}
        <div className="border-b border-zinc-100 px-5 py-3">
          <label className="text-sm font-medium text-zinc-600">Reason code</label>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
          >
            {REASON_CODES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* PIN entry */}
        <div className="px-5 py-4">
          <p className="mb-2 text-center text-sm font-medium text-zinc-600">Manager PIN</p>

          {/* PIN dots — show 6 to match the new 4-6 digit range. R32-X2. */}
          <div className="mb-4 flex justify-center gap-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={`h-4 w-4 rounded-full border-2 ${
                  i < pin.length ? "border-amber-600 bg-amber-600" : "border-zinc-300 bg-white"
                }`}
              />
            ))}
          </div>

          {/* Numeric pad */}
          <div className="mx-auto grid max-w-[16rem] grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => handlePinPad(d)}
                disabled={processing}
                className="touch-button flex items-center justify-center rounded-xl bg-zinc-100 text-lg font-semibold hover:bg-zinc-200 active:bg-zinc-300"
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              onClick={handleClear}
              disabled={processing}
              className="touch-button flex items-center justify-center rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-500 hover:bg-zinc-200"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => handlePinPad("0")}
              disabled={processing}
              className="touch-button flex items-center justify-center rounded-xl bg-zinc-100 text-lg font-semibold hover:bg-zinc-200 active:bg-zinc-300"
            >
              0
            </button>
            <button
              type="button"
              onClick={handleBackspace}
              disabled={processing}
              className="touch-button flex items-center justify-center rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-500 hover:bg-zinc-200"
            >
              Del
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-center text-sm font-medium text-red-700">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 border-t border-zinc-100 p-4">
          <button
            type="button"
            onClick={onDenied}
            disabled={processing}
            className="touch-button flex-1 rounded-2xl border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={processing || pin.length < 4 || pin.length > 6}
            className={`touch-button flex-1 rounded-2xl px-4 text-sm font-bold transition-colors ${
              processing || pin.length < 4 || pin.length > 6
                ? "cursor-not-allowed bg-zinc-200 text-zinc-400"
                : "bg-amber-600 text-white hover:bg-amber-700 active:bg-amber-800"
            }`}
          >
            {processing ? "Verifying..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
