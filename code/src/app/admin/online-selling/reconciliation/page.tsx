'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';

interface ReconciliationItem {
  productVariantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  buposOnHand: number;
  shopifyOnHand: number | null;
  drift: number | null;
  status: 'in_sync' | 'needs_attention' | 'error';
  error?: string;
}
interface ReconciliationReport {
  summary: { total: number; inSync: number; needsAttention: number; errors: number; checkedAt: string };
  items: ReconciliationItem[];
}

export default function ShopifyReconciliationPage() {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/channels/shopify/reconciliation');
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? 'Failed to load reconciliation report');
      setReport(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pushToShopify = async () => {
    setRepairing(true);
    setError(null);
    try {
      const response = await authFetch('/api/channels/shopify/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'push_to_shopify' }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? 'Failed to push BUPOS counts to Shopify');
      setReport(json.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to push BUPOS counts to Shopify');
    } finally {
      setRepairing(false);
    }
  };

  const items = report?.items ?? [];
  const driftItems = items.filter((item) => item.status !== 'in_sync');

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">Online inventory</p>
            <h1 className="mt-2 text-3xl font-bold text-gray-900">Shopify Inventory Reconciliation</h1>
            <p className="mt-2 max-w-3xl text-gray-600">Compare live Shopify available quantity against BUPOS fulfillment-location stock and push BUPOS counts back to Shopify when drift appears.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={load} disabled={loading || repairing} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Refresh</button>
            <button onClick={pushToShopify} disabled={repairing || loading || items.length === 0} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:bg-gray-300">{repairing ? 'Pushing…' : 'Push BUPOS counts to Shopify'}</button>
            <Link href="/admin/online-selling" className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">Back to Online Selling</Link>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Summary label="Mapped SKUs" value={report?.summary.total ?? 0} />
          <Summary label="In sync" value={report?.summary.inSync ?? 0} tone="good" />
          <Summary label="Needs attention" value={report?.summary.needsAttention ?? 0} tone="warn" />
          <Summary label="Errors" value={report?.summary.errors ?? 0} tone="bad" />
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 px-5 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Drift report</h2>
            <p className="text-sm text-gray-500">Last checked {report?.summary.checkedAt ? new Date(report.summary.checkedAt).toLocaleString() : '—'}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 text-left text-xs uppercase tracking-wide text-gray-600"><tr><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Product</th><th className="px-4 py-3 text-right">BUPOS</th><th className="px-4 py-3 text-right">Shopify</th><th className="px-4 py-3 text-right">Drift</th><th className="px-4 py-3">Status</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Checking Shopify inventory…</td></tr> : items.length === 0 ? <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No mapped Shopify SKUs yet. Publish or sync products first.</td></tr> : (driftItems.length ? driftItems : items).map((item) => (
                  <tr key={item.productVariantId} className="border-t border-gray-100 hover:bg-gray-50"><td className="px-4 py-3 font-mono text-xs text-gray-800">{item.sku}</td><td className="px-4 py-3"><div className="font-semibold text-gray-900">{item.productName}</div><div className="text-xs text-gray-500">{item.variantName ?? 'Default variant'}</div></td><td className="px-4 py-3 text-right font-semibold text-gray-800">{item.buposOnHand}</td><td className="px-4 py-3 text-right font-semibold text-gray-800">{item.shopifyOnHand ?? '—'}</td><td className={`px-4 py-3 text-right font-bold ${item.drift === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{item.drift == null ? '—' : item.drift > 0 ? `+${item.drift}` : item.drift}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.status === 'in_sync' ? 'bg-emerald-100 text-emerald-800' : item.status === 'needs_attention' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>{item.status === 'needs_attention' ? 'Needs attention' : item.status === 'in_sync' ? 'In sync' : 'Error'}</span>{item.error && <div className="mt-1 text-xs text-red-700">{item.error}</div>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-gray-900';
  return <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"><div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div><div className={`mt-2 text-3xl font-bold ${color}`}>{value}</div></div>;
}
