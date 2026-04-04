'use client';

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  role: string;
}

interface Location {
  id: string;
  name: string;
}

function ClockInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const notice = searchParams.get("notice");
  const urlError = searchParams.get("error");

  const [locations, setLocations] = useState<Location[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locationId, setLocationId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [openingFloat, setOpeningFloat] = useState("0.00");
  const [openedNote, setOpenedNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load locations and employees on mount
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const res = await fetch('/api/clock-in-data');
        if (res.status === 401) { window.location.href = '/?error=Please+sign+in'; return; }
        const data = res.ok ? await res.json() : { locations: [], employees: [] };
        setLocations(data.locations ?? []);
        setEmployees(data.employees ?? []);
        if (data.locations?.[0]?.id) setLocationId(data.locations[0].id);
      } catch {
        setError("Failed to load locations and employees — please refresh.");
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  const handleClockIn = async () => {
    if (!locationId || !employeeId) {
      setError("Please select both a location and an employee.");
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          locationId,
          openingFloat: parseFloat(openingFloat) || 0,
          openedNote,
        }),
      });
      const data = await res.json();
      setIsSubmitting(false);
      if (!res.ok) {
        setError(data.error || `Failed to open shift (${res.status})`);
      } else {
        setError(null);
        alert("Shift opened successfully!");
        setOpeningFloat("0.00");
        setOpenedNote("");
      }
    } catch (e: unknown) {
      setIsSubmitting(false);
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
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
            Select location and employee, then enter the opening float.
          </p>
        </div>

        {/* Notice banner */}
        {notice && (
          <div className="mb-6 rounded-2xl bg-green-50 border border-green-200 px-5 py-4 text-sm text-green-700 text-center font-medium">
            {notice.replace("+", " ")}
          </div>
        )}

        {/* Loading spinner */}
        {isLoading && (
          <div className="mb-6 flex items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-2" style={{ borderTopColor: "var(--surface-accent)" }} />
          </div>
        )}

        {/* Location selector */}
        <div className="mb-5">
          <label className="block text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            Location
          </label>
          <select
            value={locationId}
            onChange={e => setLocationId(e.target.value)}
            disabled={isLoading}
            className="w-full rounded-2xl border-2 px-5 py-4 text-base focus:outline-none focus:ring-2 disabled:opacity-50"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
              color: "var(--text-primary)",
            }}
          >
            <option value="">Select location...</option>
            {locations.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>

        {/* Employee selector */}
        <div className="mb-5">
          <label className="block text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            Employee
          </label>
          <select
            value={employeeId}
            onChange={e => setEmployeeId(e.target.value)}
            disabled={isLoading}
            className="w-full rounded-2xl border-2 px-5 py-4 text-base focus:outline-none focus:ring-2 disabled:opacity-50"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
              color: "var(--text-primary)",
            }}
          >
            <option value="">Select employee...</option>
            {employees.map(emp => (
              <option key={emp.id} value={emp.id}>{emp.displayName} ({emp.role})</option>
            ))}
          </select>
        </div>

        {/* Opening Float */}
        <div className="mb-5">
          <label className="block text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            Opening Float ($)
          </label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-2xl font-bold" style={{ color: "var(--text-secondary)" }}>$</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingFloat}
              onChange={e => setOpeningFloat(e.target.value)}
              disabled={isLoading}
              className="w-full rounded-2xl border-2 py-5 pl-10 pr-6 text-3xl font-bold text-center focus:outline-none focus:ring-2 disabled:opacity-50"
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
          <label className="block text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            Note (optional)
          </label>
          <textarea
            value={openedNote}
            onChange={e => setOpenedNote(e.target.value)}
            placeholder="e.g. Register A, starting float confirmed"
            rows={2}
            disabled={isLoading}
            className="w-full rounded-2xl border-2 px-5 py-4 text-base focus:outline-none focus:ring-2 resize-none disabled:opacity-50"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        {/* Error */}
        {(error || urlError) && (
          <div className="mb-6 rounded-2xl bg-red-50 border border-red-200 px-5 py-4 text-sm text-red-700">
            {error ?? urlError?.replace("+", " ")}
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

export default function ClockInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "var(--surface-app)" }}><div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-2" style={{ borderTopColor: "var(--surface-accent)" }} /></div>}>
      <ClockInContent />
    </Suspense>
  );
}
