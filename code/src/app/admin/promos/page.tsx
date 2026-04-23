"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminTopNav } from "@/components/layout/admin-top-nav";
import { authFetch } from "@/lib/api/client";
import type { PromoCode, ProductVariant, Product } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";
// R53: step-up re-auth for high-risk promo creates. Server
// /api/promo-codes POST gates on bucketKey:'promo-code-create-stepup'
// for high-value-or-unbounded promos; prior UI didn't thread
// actorPassword so every high-risk create threw.
import { usePasswordGate } from "@/components/shared/password-gate";

type PromoType = "fixed" | "percent" | "bogo" | "free_item";

interface VariantLite {
  id: string;
  sku: string;
  name: string;
  price: number;
  productName: string;
  isActive: boolean;
}

interface NewPromoForm {
  code: string;
  description: string;
  type: PromoType;
  value: string;
  minimumPurchase: string;
  maxRedemptions: string;
  startsAt: string;
  expiresAt: string;
  freeVariantId: string;
}

const emptyForm: NewPromoForm = {
  code: "",
  description: "",
  type: "fixed",
  value: "",
  minimumPurchase: "0",
  maxRedemptions: "",
  startsAt: "",
  expiresAt: "",
  freeVariantId: "",
};

// Describe each promo type so the form's helper text is always consistent
// with how the server interprets `value`. Keeps the docstring + UI in sync.
const TYPE_META: Record<PromoType, { label: string; valueHint: string; valueLabel: string; showValue: boolean; showVariant: boolean }> = {
  fixed:     { label: "$ off cart",      valueLabel: "Discount amount ($)", valueHint: "Dollar amount deducted from the cart subtotal.", showValue: true,  showVariant: false },
  percent:   { label: "% off cart",      valueLabel: "Discount percent",    valueHint: "0–100, applied to cart subtotal.",               showValue: true,  showVariant: false },
  bogo:      { label: "BOGO (50% off)",  valueLabel: "",                    valueHint: "Currently a flat 50% off simplification.",       showValue: false, showVariant: false },
  free_item: { label: "Free item",       valueLabel: "",                    valueHint: "When the cart meets the minimum, the cashier adds the chosen variant at $0.", showValue: false, showVariant: true  },
};

export default function AdminPromosPage() {
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [variants, setVariants] = useState<VariantLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<NewPromoForm>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promptPassword, passwordGate] = usePasswordGate();

  // Search box for the free-variant picker. Long catalogs would otherwise
  // render thousands of <option>s and lag the modal.
  const [variantSearch, setVariantSearch] = useState("");

  // --- Load ---------------------------------------------------------

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [promosRes, productsRes] = await Promise.all([
        authFetch("/api/promo-codes", { cache: "no-store" }),
        authFetch("/api/products", { cache: "no-store" }),
      ]);
      if (!promosRes.ok) throw new Error(`promos HTTP ${promosRes.status}`);
      if (!productsRes.ok) throw new Error(`products HTTP ${productsRes.status}`);
      const promosBody = await promosRes.json() as { promoCodes: PromoCode[] };
      const productsBody = await productsRes.json() as {
        products: {
          id: string; name: string; variants: ProductVariant[];
        }[];
      };

      setPromos(promosBody.promoCodes ?? []);

      // Flatten to a variant catalog usable for the free-item picker.
      const flat: VariantLite[] = [];
      for (const p of productsBody.products ?? []) {
        const prod = p as Product & { variants?: ProductVariant[] };
        for (const v of prod.variants ?? []) {
          flat.push({
            id: v.id,
            sku: v.sku,
            name: v.name,
            price: Number(v.price),
            productName: p.name,
            isActive: v.isActive,
          });
        }
      }
      setVariants(flat);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // --- Create -------------------------------------------------------

  const typeMeta = TYPE_META[form.type];

  const resetForm = () => setForm(emptyForm);

  const filteredVariants = useMemo(() => {
    const q = variantSearch.trim().toLowerCase();
    const active = variants.filter((v) => v.isActive);
    if (!q) return active.slice(0, 50); // cap default list so the UI stays snappy
    return active.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.sku.toLowerCase().includes(q) ||
      v.productName.toLowerCase().includes(q),
    ).slice(0, 100);
  }, [variants, variantSearch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    // Client-side sanity checks. Server re-validates via Zod + DB checks.
    if (!form.code.trim()) {
      setSubmitError("Promo code is required");
      return;
    }
    if (!/^[A-Z0-9_-]+$/.test(form.code.trim().toUpperCase())) {
      setSubmitError("Code may only contain letters, digits, _ and -");
      return;
    }
    if (typeMeta.showVariant && !form.freeVariantId) {
      setSubmitError("Free-item promos require a variant");
      return;
    }
    let value = 0;
    if (typeMeta.showValue) {
      value = Number.parseFloat(form.value);
      if (!Number.isFinite(value) || value <= 0) {
        setSubmitError(`${typeMeta.valueLabel} must be > 0`);
        return;
      }
      if (form.type === "percent" && value > 100) {
        setSubmitError("Percent must be ≤ 100");
        return;
      }
    }
    const minimumPurchase = Number.parseFloat(form.minimumPurchase || "0");
    if (!Number.isFinite(minimumPurchase) || minimumPurchase < 0) {
      setSubmitError("Minimum purchase must be ≥ 0");
      return;
    }
    const maxRedemptions = form.maxRedemptions.trim() === "" ? 0 : Number.parseInt(form.maxRedemptions, 10);
    if (!Number.isFinite(maxRedemptions) || maxRedemptions < 0) {
      setSubmitError("Max redemptions must be ≥ 0 (use 0 for unlimited)");
      return;
    }

    // The API wants ISO timestamps. If the cashier left them blank, use
    // "now" for startsAt and omit expiresAt (no expiry).
    const startsAt = form.startsAt ? new Date(form.startsAt).toISOString() : new Date().toISOString();
    const expiresAt = form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined;

    // R53: step-up re-auth for high-risk promos. Server gates create on
    // bucketKey:'promo-code-create-stepup' for promos that either
    //   (a) carry a >= $50 fixed discount (big one-shot liability), or
    //   (b) are unbounded in redemptions (maxRedemptions = 0 / blank
    //       / the 10_000_000 sentinel) — one stolen code could be
    //       redeemed indefinitely.
    // Low-risk promos (percent-off, BOGO, capped small fixed) skip
    // the prompt so legitimate promo authoring stays quick.
    const isUnbounded = maxRedemptions === 0;
    const isHighValueFixed = form.type === "fixed" && value >= 50;
    const isHighRisk = isUnbounded || isHighValueFixed;
    let actorPassword: string | undefined;
    if (isHighRisk) {
      const reason = isUnbounded
        ? "This promo has no redemption cap — anyone with the code could use it indefinitely."
        : `This is a ${formatCurrency(value)} fixed discount — confirm you want to create a promo with this liability.`;
      const pwd = await promptPassword({
        title: `Create high-risk promo ${form.code.trim().toUpperCase()}?`,
        description: `${reason} Confirm with your password.`,
        confirmLabel: "Create promo",
        confirmVariant: "default",
      });
      if (!pwd) return;
      actorPassword = pwd;
    }

    setSubmitting(true);
    try {
      const res = await authFetch("/api/promo-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          code: form.code.trim().toUpperCase(),
          description: form.description.trim() || undefined,
          type: form.type,
          value,
          minimumPurchase,
          // The Zod schema enforces positive so 0 = unlimited is passed
          // as a big number. Use 10_000_000 as the "unlimited" sentinel.
          maxRedemptions: maxRedemptions === 0 ? 10_000_000 : maxRedemptions,
          startsAt,
          ...(expiresAt ? { expiresAt } : {}),
          ...(typeMeta.showVariant ? { freeVariantId: form.freeVariantId } : {}),
          ...(actorPassword ? { actorPassword } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setSubmitError(body.error ?? "Failed to create promo");
        return;
      }
      resetForm();
      setShowCreate(false);
      await load();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create promo");
    } finally {
      setSubmitting(false);
    }
  };

  // --- Disable ------------------------------------------------------

  const handleDisable = async (promoCodeId: string) => {
    if (!window.confirm("Disable this promo code? It will stop working at register immediately.")) return;
    try {
      const res = await authFetch("/api/promo-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable", promoCodeId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        alert(body.error ?? "Failed to disable promo");
        return;
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to disable promo");
    }
  };

  // --- Render -------------------------------------------------------

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <AdminTopNav />
      <div className="mx-auto max-w-7xl p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Promo codes</h1>
            <p className="mt-1 text-sm text-slate-600">
              Create cart-level discounts, BOGO, and free-with-purchase promotions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setShowCreate(true); setSubmitError(null); }}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            + New promo code
          </button>
        </div>

        {loadError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Couldn&apos;t load promo codes: {loadError}
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-3 text-left font-semibold text-slate-700">Code</th>
                <th className="px-6 py-3 text-left font-semibold text-slate-700">Type</th>
                <th className="px-6 py-3 text-right font-semibold text-slate-700">Value</th>
                <th className="px-6 py-3 text-right font-semibold text-slate-700">Min purchase</th>
                <th className="px-6 py-3 text-right font-semibold text-slate-700">Uses</th>
                <th className="px-6 py-3 text-left font-semibold text-slate-700">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && promos.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-slate-400">No promo codes yet.</td></tr>
              )}
              {!loading && promos.map((p) => {
                const meta = TYPE_META[p.type];
                let valueText = "";
                if (p.type === "fixed") valueText = formatCurrency(p.value);
                else if (p.type === "percent") valueText = `${p.value}%`;
                else if (p.type === "bogo") valueText = "—";
                else if (p.type === "free_item") {
                  // `variants` includes all variants in the org — active
                  // AND inactive (per /api/products). Distinguish three
                  // cases:
                  //  • variant found + active        → "Product — Name"
                  //  • variant found + inactive      → "… (inactive)"
                  //  • variant not found in listing  → likely hard-deleted
                  //    (rare — the FK is ON DELETE RESTRICT, but a
                  //    stale list after reload would look the same)
                  const v = variants.find((x) => x.id === p.freeVariantId);
                  if (!v) {
                    valueText = "(variant deleted)";
                  } else if (!v.isActive) {
                    valueText = `${v.productName} — ${v.name} (inactive)`;
                  } else {
                    valueText = `${v.productName} — ${v.name}`;
                  }
                }
                const usesText = p.maxRedemptions >= 10_000_000
                  ? `${p.currentRedemptions}`
                  : `${p.currentRedemptions} / ${p.maxRedemptions}`;
                return (
                  <tr key={p.id} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="px-6 py-4 font-mono font-semibold text-slate-900">{p.code}</td>
                    <td className="px-6 py-4 text-slate-700">{meta.label}</td>
                    <td className="px-6 py-4 text-right text-slate-900">{valueText}</td>
                    <td className="px-6 py-4 text-right text-slate-600">{p.minimumPurchase > 0 ? formatCurrency(p.minimumPurchase) : "—"}</td>
                    <td className="px-6 py-4 text-right text-slate-600">{usesText}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        p.status === "active" ? "bg-emerald-100 text-emerald-800"
                        : p.status === "depleted" ? "bg-amber-100 text-amber-800"
                        : p.status === "expired" ? "bg-zinc-100 text-zinc-700"
                        : "bg-red-100 text-red-800"
                      }`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {p.status === "active" && (
                        <button
                          type="button"
                          onClick={() => handleDisable(p.id)}
                          className="rounded bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
                        >
                          Disable
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* R53: shared password gate renders nothing until prompted. */}
      {passwordGate}

      {/* --- Create modal ------------------------------------------ */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-bold text-slate-900">Create promo code</h2>
              <button
                type="button"
                onClick={() => { setShowCreate(false); resetForm(); }}
                className="rounded p-1 text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >✕</button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto space-y-4 px-5 py-4">
              {submitError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <label className="block text-sm font-medium text-slate-700">
                Code
                <input
                  type="text"
                  required
                  maxLength={64}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="e.g., WELCOME10"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase tracking-wide focus:border-emerald-500 focus:outline-none"
                />
                <span className="mt-1 block text-xs text-slate-500">Shown to customers. Letters/digits/_/- only.</span>
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Description (optional)
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Displayed to cashier in the promo modal"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Type
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as PromoType, value: "", freeVariantId: "" })}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                >
                  {Object.entries(TYPE_META).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-500">{typeMeta.valueHint}</span>
              </label>

              {typeMeta.showValue && (
                <label className="block text-sm font-medium text-slate-700">
                  {typeMeta.valueLabel}
                  <input
                    type="number"
                    step={form.type === "percent" ? "1" : "0.01"}
                    min="0"
                    max={form.type === "percent" ? "100" : undefined}
                    required
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                    placeholder={form.type === "percent" ? "e.g., 15" : "e.g., 5.00"}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </label>
              )}

              {typeMeta.showVariant && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    Free variant
                    <input
                      type="text"
                      value={variantSearch}
                      onChange={(e) => setVariantSearch(e.target.value)}
                      placeholder="Search by product name, variant, or SKU…"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                    />
                  </label>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
                    {filteredVariants.length === 0 && (
                      <div className="px-3 py-4 text-center text-xs text-slate-400">
                        {variantSearch ? "No matching variants" : "No active variants"}
                      </div>
                    )}
                    {filteredVariants.map((v) => {
                      const selected = form.freeVariantId === v.id;
                      return (
                        <button
                          type="button"
                          key={v.id}
                          onClick={() => setForm({ ...form, freeVariantId: v.id })}
                          className={`flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 ${
                            selected ? "bg-emerald-50" : "hover:bg-slate-50"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-slate-900">
                              {v.productName} — {v.name}
                            </p>
                            <p className="truncate text-xs text-slate-500">{v.sku}</p>
                          </div>
                          <span className="shrink-0 font-mono text-xs text-slate-600">{formatCurrency(v.price)}</span>
                        </button>
                      );
                    })}
                  </div>
                  {form.freeVariantId && (
                    <p className="text-xs text-emerald-700">
                      Selected: {(() => {
                        const v = variants.find((x) => x.id === form.freeVariantId);
                        return v ? `${v.productName} — ${v.name}` : form.freeVariantId;
                      })()}
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium text-slate-700">
                  Minimum purchase ($)
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.minimumPurchase}
                    onChange={(e) => setForm({ ...form, minimumPurchase: e.target.value })}
                    placeholder="0"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Max redemptions
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={form.maxRedemptions}
                    onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
                    placeholder="unlimited"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs text-slate-500">Blank or 0 = unlimited</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium text-slate-700">
                  Starts at
                  <input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs text-slate-500">Blank = now</span>
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Expires at
                  <input
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs text-slate-500">Blank = never</span>
                </label>
              </div>

              {/* Action buttons must live INSIDE the <form> so pressing
                  Enter in an input submits (native browser behaviour).
                  The primary button is type="submit" and gets the
                  handleSubmit handler via onSubmit on the form above. */}
              <div className="-mx-5 -mb-4 mt-4 flex gap-3 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); resetForm(); }}
                  disabled={submitting}
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {submitting ? "Creating…" : "Create promo"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
