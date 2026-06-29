'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';

interface Supplier { id: string; name: string }
interface ReturnRow { id: string; rtv_number: string; supplier_name: string; status: string; reason: string; total_units: number; line_count: number; created_at: string }
interface Variant { id: string; sku: string; product_name: string; name: string; on_hand: number }

export default function SupplierReturnsPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [reason, setReason] = useState('damaged');
  const [notes, setNotes] = useState('');
  const [query, setQuery] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [selected, setSelected] = useState<Variant | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [supRes, retRes] = await Promise.all([authFetch('/api/suppliers'), authFetch('/api/supplier-returns')]);
    const supJson = await supRes.json().catch(() => ({}));
    const retJson = await retRes.json().catch(() => ({}));
    if (!supRes.ok) throw new Error(supJson.error ?? 'Failed to load suppliers');
    if (!retRes.ok) throw new Error(retJson.error ?? 'Failed to load return history');
    const supplierRows = supJson.suppliers ?? supJson.data ?? [];
    setSuppliers(supplierRows);
    if (!supplierId && supplierRows[0]) setSupplierId(supplierRows[0].id);
    setReturns(retJson.returns ?? []);
  }, [supplierId]);

  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : 'Failed to load RTV data')); }, [load]);

  const searchVariants = async () => {
    if (query.trim().length < 2) return;
    const res = await authFetch(`/api/receiving?type=search&q=${encodeURIComponent(query.trim())}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json.error ?? 'Search failed'); return; }
    setVariants(json.variants ?? []);
  };

  const createReturn = async () => {
    if (!supplierId || !selected) { setError('Select a supplier and SKU first'); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch('/api/supplier-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_id: supplierId, reason, notes, lines: [{ product_variant_id: selected.id, quantity, reason }] }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? 'Failed to create RTV');
      setSelected(null); setQuery(''); setVariants([]); setQuantity(1); setNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create RTV');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-6xl px-8 py-8 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div><p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">Return to vendor</p><h1 className="mt-2 text-4xl font-bold text-slate-900">RTV / Supplier Returns</h1><p className="mt-2 text-slate-600">Create auditable supplier returns that decrement stock through inventory adjustments.</p></div>
          <Link href="/admin/suppliers" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Back to Suppliers</Link>
        </div>
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Create RTV</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium text-slate-700">Supplier<select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">Return reason<select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2"><option value="damaged">Damaged</option><option value="incorrect_item">Incorrect item</option><option value="overstock">Overstock</option><option value="supplier_return">Supplier return</option></select></label>
            <label className="grid gap-2 text-sm font-medium text-slate-700 md:col-span-2">SKU search<div className="flex gap-2"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU/product" className="flex-1 rounded-lg border border-slate-300 px-3 py-2" /><button type="button" onClick={searchVariants} className="rounded-lg bg-slate-800 px-4 py-2 text-white">Search</button></div></label>
          </div>
          {variants.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{variants.map((v) => <button key={v.id} onClick={() => setSelected(v)} className={`rounded-full border px-3 py-1 text-sm ${selected?.id === v.id ? 'border-amber-600 bg-amber-50 text-amber-800' : 'border-slate-300 bg-white text-slate-700'}`}>{v.sku} · {v.product_name} · stock {v.on_hand}</button>)}</div>}
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3"><label className="grid gap-2 text-sm font-medium text-slate-700">Quantity<input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="rounded-lg border border-slate-300 px-3 py-2" /></label><label className="grid gap-2 text-sm font-medium text-slate-700 md:col-span-2">Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" /></label></div>
          <button onClick={createReturn} disabled={saving || !selected} className="mt-5 rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:bg-slate-300">{saving ? 'Creating…' : 'Create RTV'}</button>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Return history</h2></div><table className="w-full text-sm"><thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600"><tr><th className="px-4 py-3">RTV</th><th className="px-4 py-3">Supplier</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3 text-right">Units</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Created</th></tr></thead><tbody>{returns.length === 0 ? <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No supplier returns yet.</td></tr> : returns.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="px-4 py-3 font-mono text-xs">{r.rtv_number}</td><td className="px-4 py-3">{r.supplier_name}</td><td className="px-4 py-3">{r.reason}</td><td className="px-4 py-3 text-right font-semibold">{r.total_units}</td><td className="px-4 py-3">{r.status}</td><td className="px-4 py-3">{new Date(r.created_at).toLocaleString()}</td></tr>)}</tbody></table></section>
      </main>
    </div>
  );
}
