"use client";

import { useEffect, useState } from "react";
import { clockInAction } from "@/app/register/actions";

/**
 * "Tap your name" register sign-in: pick a store, then tap your name to
 * clock in. Cashiers clock in instantly (no PIN). Owner/manager names are
 * PIN-gated — tapping one opens a keypad and the PIN is posted alongside
 * {locationId, employeeId, deviceId} so a cashier can't assume manager
 * privileges just by tapping a manager's name. The deviceId comes from
 * localStorage (device-bind for the register session); the server also
 * synthesizes one if it's somehow empty.
 */

interface Employee {
  id: string;
  name: string;
  role: string;
}
interface Store {
  id: string;
  name: string;
  employees: Employee[];
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  cashier: "Cashier",
  inventory_clerk: "Inventory",
};

// Elevated roles must enter their PIN; cashiers tap straight through.
function requiresPin(role: string): boolean {
  return role === "owner" || role === "manager";
}

function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const stored = localStorage.getItem("pos_device_id");
  if (stored) return stored;
  const generated = crypto.randomUUID();
  localStorage.setItem("pos_device_id", generated);
  return generated;
}

export function StoreClockIn({ stores }: { stores: Store[] }) {
  const [deviceId, setDeviceId] = useState("");
  // Auto-select when there's only one store (skip the picker).
  const [selectedId, setSelectedId] = useState<string | null>(
    stores.length === 1 ? stores[0].id : null,
  );
  const [submitting, setSubmitting] = useState(false);
  // When a manager/owner is tapped, collect their PIN before submitting.
  const [pinFor, setPinFor] = useState<Employee | null>(null);
  const [pin, setPin] = useState("");

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  if (stores.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        No stores are set up yet. Add a location and employees in the admin
        area first.
      </p>
    );
  }

  const store = selectedId ? stores.find((s) => s.id === selectedId) ?? null : null;

  // ── Step 1: pick a store ──
  if (!store) {
    return (
      <div className="grid gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Choose your store</h2>
          <p className="mt-1 text-sm text-zinc-500">Pick where you&apos;re working today.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {stores.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedId(s.id)}
              className="touch-button rounded-2xl border border-zinc-200 bg-white px-5 py-6 text-left shadow-sm transition hover:border-[var(--surface-accent)] hover:shadow-md"
            >
              <span className="block text-lg font-semibold">{s.name}</span>
              <span className="mt-1 block text-sm text-zinc-500">
                {s.employees.length} {s.employees.length === 1 ? "person" : "people"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 2b: manager / owner PIN entry ──
  if (pinFor) {
    const press = (d: string) => setPin((p) => (p.length >= 12 ? p : p + d));
    const backspace = () => setPin((p) => p.slice(0, -1));
    const clearPin = () => setPin("");
    const keyClass =
      "touch-button rounded-xl border border-zinc-200 bg-white py-5 text-2xl font-semibold text-zinc-800 shadow-sm transition hover:border-[var(--surface-accent)] hover:shadow active:scale-[0.98] disabled:opacity-50";
    return (
      <div className="grid gap-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">{pinFor.name}</h2>
            <p className="mt-1 text-sm text-zinc-500">
              {ROLE_LABEL[pinFor.role] ?? pinFor.role} — enter your PIN to clock in.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPinFor(null);
              setPin("");
              setSubmitting(false);
            }}
            className="flex-shrink-0 text-sm font-medium text-[var(--surface-accent)] hover:underline"
          >
            ← Back
          </button>
        </div>

        {/* Masked PIN display */}
        <div className="flex min-h-[1.5rem] items-center justify-center gap-2.5" aria-hidden="true">
          {pin.length === 0 ? (
            <span className="text-sm text-zinc-400">Enter PIN</span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <span key={i} className="h-3.5 w-3.5 rounded-full bg-[var(--surface-accent)]" />
            ))
          )}
        </div>

        <form action={clockInAction} onSubmit={() => setSubmitting(true)} className="grid gap-4">
          <input type="hidden" name="locationId" value={store.id} />
          <input type="hidden" name="employeeId" value={pinFor.id} />
          <input type="hidden" name="deviceId" value={deviceId} />
          <input type="hidden" name="pin" value={pin} />

          <div className="grid grid-cols-3 gap-3">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" disabled={submitting} onClick={() => press(d)} className={keyClass}>
                {d}
              </button>
            ))}
            <button type="button" disabled={submitting || pin.length === 0} onClick={backspace} className={keyClass} aria-label="Backspace">
              ⌫
            </button>
            <button key="0" type="button" disabled={submitting} onClick={() => press("0")} className={keyClass}>
              0
            </button>
            <button type="button" disabled={submitting || pin.length === 0} onClick={clearPin} className={`${keyClass} text-base`}>
              Clear
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting || pin.length === 0}
            className="touch-button w-full rounded-xl bg-[var(--surface-accent)] py-4 text-base font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
                Clocking you in…
              </span>
            ) : (
              "Clock in"
            )}
          </button>
        </form>
      </div>
    );
  }

  // ── Step 2: tap your name ──
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Who&apos;s working?</h2>
          <p className="mt-1 text-sm text-zinc-500">{store.name} — tap your name to clock in.</p>
        </div>
        {stores.length > 1 ? (
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setSubmitting(false);
            }}
            className="flex-shrink-0 text-sm font-medium text-[var(--surface-accent)] hover:underline"
          >
            ← Change store
          </button>
        ) : null}
      </div>

      {store.employees.length === 0 ? (
        <p className="text-sm text-zinc-600">No one is assigned to this store yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {store.employees.map((e) =>
            requiresPin(e.role) ? (
              // Manager/owner — open the PIN keypad instead of submitting.
              <button
                key={e.id}
                type="button"
                disabled={submitting}
                onClick={() => {
                  setPin("");
                  setPinFor(e);
                }}
                className="touch-button w-full rounded-2xl border border-zinc-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-[var(--surface-accent)] hover:shadow-md disabled:opacity-50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="block text-lg font-semibold">{e.name}</span>
                  <span className="flex-shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-zinc-500">
                    PIN
                  </span>
                </span>
                <span className="mt-0.5 block text-sm text-zinc-500">{ROLE_LABEL[e.role] ?? e.role}</span>
              </button>
            ) : (
              // Cashier — tap to clock in, no PIN.
              <form key={e.id} action={clockInAction} onSubmit={() => setSubmitting(true)}>
                <input type="hidden" name="locationId" value={store.id} />
                <input type="hidden" name="employeeId" value={e.id} />
                <input type="hidden" name="deviceId" value={deviceId} />
                <button
                  type="submit"
                  disabled={submitting}
                  className="touch-button w-full rounded-2xl border border-zinc-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-[var(--surface-accent)] hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="block text-lg font-semibold">{e.name}</span>
                  <span className="mt-0.5 block text-sm text-zinc-500">{ROLE_LABEL[e.role] ?? e.role}</span>
                </button>
              </form>
            ),
          )}
        </div>
      )}

      {submitting ? (
        <p className="flex items-center gap-2 rounded-2xl bg-zinc-100 px-4 py-3 text-sm text-zinc-600">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
          Clocking you in…
        </p>
      ) : null}
    </div>
  );
}
