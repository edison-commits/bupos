"use client";

import { useEffect, useState } from "react";
import { clockInAction } from "@/app/register/actions";

/**
 * No-PIN register sign-in: pick a store, then tap your name to clock in.
 * Replaces the PIN pad. Each name is a tiny <form action={clockInAction}>
 * carrying {locationId, employeeId, deviceId}. The deviceId comes from
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
          {store.employees.map((e) => (
            <form key={e.id} action={clockInAction}>
              <input type="hidden" name="locationId" value={store.id} />
              <input type="hidden" name="employeeId" value={e.id} />
              <input type="hidden" name="deviceId" value={deviceId} />
              <button
                type="submit"
                disabled={submitting}
                onClick={() => setSubmitting(true)}
                className="touch-button w-full rounded-2xl border border-zinc-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-[var(--surface-accent)] hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="block text-lg font-semibold">{e.name}</span>
                <span className="mt-0.5 block text-sm text-zinc-500">{ROLE_LABEL[e.role] ?? e.role}</span>
              </button>
            </form>
          ))}
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
