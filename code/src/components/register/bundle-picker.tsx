"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProductBundle, ProductVariant, InventoryLevel } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

interface BundlePickerProps {
  bundles: ProductBundle[];
  variants: ProductVariant[];
  inventory: InventoryLevel[];
  /** Current location (inventory is location-scoped). */
  locationId: string;
  onAddBundle: (bundle: ProductBundle) => void;
}

interface ServerAvailability {
  bundleId: string;
  bundleName: string;
  isActive: boolean;
  maxBuildable: number;
  oosComponents: string[];
}

/**
 * Renders a grid of active bundles with an "Add" action on each card.
 *
 * Initial render uses the `inventory` prop (already loaded for the POS).
 * Every 15s the picker re-queries `/api/bundles/availability` and merges
 * the server-authoritative stock count. This narrows the window where
 * cashier A sees "available" after cashier B just bought the last one —
 * it does NOT replace the server-side stock check at checkout. For true
 * stock reservation (hold inventory on cart-add) see the TODO in
 * bundle-picker doc.
 */
const POLL_MS = 15_000;
// Threshold for showing "only N left" hints on a bundle card. Kept just
// above "impending stockout" but below "plenty" so cashiers feel urgency
// without noise. Adjust if the register starts showing it too often.
const LOW_STOCK_THRESHOLD = 5;

export function BundlePicker({ bundles, variants, inventory, locationId, onAddBundle }: BundlePickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [serverAvail, setServerAvail] = useState<Record<string, ServerAvailability> | null>(null);

  // Filter by the SERVER's current is_active flag when we have a poll
  // response — catches admin deactivations within a single open register
  // session (the `bundles` prop is snapshotted at page load). Falls back
  // to the prop's isActive when the poll hasn't come back yet.
  const activeBundles = useMemo(
    () =>
      bundles.filter((b) => {
        const srv = serverAvail?.[b.id];
        const active = srv ? srv.isActive : b.isActive;
        return active && b.items.length > 0;
      }),
    [bundles, serverAvail],
  );

  const variantById = useMemo(() => {
    const m = new Map<string, ProductVariant>();
    for (const v of variants) m.set(v.id, v);
    return m;
  }, [variants]);

  // Seed local stock from the server-rendered inventory prop so the picker
  // has accurate counts on first paint before the first poll fires.
  const seedStockByVariant = useMemo(() => {
    const m = new Map<string, number>();
    for (const inv of inventory) {
      if (inv.locationId !== locationId) continue;
      m.set(inv.productVariantId, (m.get(inv.productVariantId) ?? 0) + inv.onHand);
    }
    return m;
  }, [inventory, locationId]);

  // Poll availability while the picker is MOUNTED (not just "expanded") so
  // the "Bundles (n)" chip count can update to reflect inactivations from
  // admin mid-session. Only fetches when we have at least one bundle.
  useEffect(() => {
    if (activeBundles.length === 0) return;
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/bundles/availability?locationId=${encodeURIComponent(locationId)}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = await res.json() as { availability: ServerAvailability[] };
        if (cancelled) return;
        const map: Record<string, ServerAvailability> = {};
        for (const a of body.availability ?? []) map[a.bundleId] = a;
        setServerAvail(map);
      } catch {
        // Non-fatal — stale cards stay visible; checkout still rejects oversells.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    // Also refresh when the tab regains visibility — e.g. cashier came
    // back from the back office.
    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeBundles.length, locationId]);

  /** OOS component names for a bundle — prefers server data, falls back to seed. */
  const oosComponents = (bundle: ProductBundle): string[] => {
    const srv = serverAvail?.[bundle.id];
    if (srv) return srv.oosComponents;
    const out: string[] = [];
    for (const item of bundle.items) {
      const have = seedStockByVariant.get(item.productVariantId) ?? 0;
      if (have < item.quantity) {
        const v = variantById.get(item.productVariantId);
        out.push(v?.name ?? item.productVariantId.slice(0, 8));
      }
    }
    return out;
  };

  if (activeBundles.length === 0) return null;

  return (
    <div className="rounded-2xl border bg-zinc-50 px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-sm font-semibold text-zinc-700 hover:text-zinc-900"
      >
        <span>Bundles ({activeBundles.length})</span>
        <span className="text-xs text-zinc-500">{expanded ? "Hide" : "Show"}</span>
      </button>

      {expanded && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {activeBundles.map((bundle) => {
            const oos = oosComponents(bundle);
            const maxBuildable = serverAvail?.[bundle.id]?.maxBuildable;
            const savings = (bundle.compareAtPrice ?? 0) - bundle.bundlePrice;
            return (
              <div
                key={bundle.id}
                className="rounded-xl border bg-white p-3 text-sm shadow-sm"
                style={{ borderColor: "var(--border-subtle)" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="font-semibold">{bundle.name}</p>
                    {bundle.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-zinc-600">{bundle.description}</p>
                    )}
                    <p className="mt-1 text-xs text-zinc-500">
                      {bundle.items.length} items
                      {typeof maxBuildable === "number" && oos.length === 0 && maxBuildable < LOW_STOCK_THRESHOLD
                        ? ` · only ${maxBuildable} left`
                        : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-teal-700">{formatCurrency(bundle.bundlePrice)}</p>
                    {savings > 0 && (
                      <p className="text-[10px] font-semibold text-emerald-700">save {formatCurrency(savings)}</p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={oos.length > 0}
                  onClick={() => onAddBundle(bundle)}
                  aria-label={`Add ${bundle.name} bundle`}
                  className="touch-button mt-2 w-full rounded-lg bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500"
                >
                  {oos.length > 0 ? `OOS: ${oos.slice(0, 2).join(", ")}${oos.length > 2 ? "…" : ""}` : "Add bundle"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
