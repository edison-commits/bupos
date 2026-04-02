"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { openShiftAction } from "@/app/register/actions";

export default function ClockInPage() {
  const router = useRouter();
  const [openingFloat, setOpeningFloat] = useState("0.00");
  const [openedNote, setOpenedNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClockIn = async () => {
    setIsSubmitting(true);
    setError(null);

    const formData = new FormData();
    formData.set("openingFloat", openingFloat);
    formData.set("openedNote", openedNote);

    try {
      await openShiftAction(formData);
      // openShiftAction redirects on success — this line won't be reached
    } catch (e) {
      // If redirect throws, it means success (Next.js redirect throws)
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "var(--surface-app)" }}>
      <div
        className="w-full max-w-lg rounded-3xl p-10 shadow-2xl"
        style={{ backgroundColor: "var(--surface-panel)", border: "1px solid var(--border-subtle)" }}
      >
        {/* Logo */}
        <div className="text-center mb-10">
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ backgroundColor: "var(--surface-accent)" }}
          >
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Start Your Shift
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            Enter the opening cash float to begin.
          </p>
        </div>

        {/* Opening Float */}
        <div className="mb-6">
          <label className="block text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            Opening Float ($)
          </label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-2xl font-bold" style={{ color: "var(--text-secondary)" }}>$</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingFloat}
              onChange={(e) => setOpeningFloat(e.target.value)}
              className="w-full rounded-2xl border-2 py-5 pl-10 pr-6 text-3xl font-bold text-center focus:outline-none focus:ring-2"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <p className="mt-2 text-xs text-center" style={{ color: "var(--text-secondary)" }}>
            Amount of cash in the drawer at shift start. Enter 0 if no cash.
          </p>
        </div>

        {/* Note */}
        <div className="mb-8">
          <label className="block text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            Note (optional)
          </label>
          <textarea
            value={openedNote}
            onChange={(e) => setOpenedNote(e.target.value)}
            placeholder="e.g. Register A, starting float confirmed"
            rows={2}
            className="w-full rounded-2xl border-2 px-5 py-4 text-base focus:outline-none focus:ring-2 resize-none"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 rounded-2xl bg-red-50 border border-red-200 px-5 py-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex-1 rounded-2xl py-4 text-base font-semibold transition-all"
            style={{
              border: "2px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              backgroundColor: "transparent",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleClockIn}
            disabled={isSubmitting}
            className="flex-1 rounded-2xl py-4 text-xl font-bold text-white transition-all disabled:opacity-50"
            style={{ backgroundColor: "var(--surface-accent)" }}
          >
            {isSubmitting ? "Starting..." : "🕐  Start Shift"}
          </button>
        </div>
      </div>
    </div>
  );
}
