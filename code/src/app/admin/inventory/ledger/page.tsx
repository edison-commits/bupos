'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { csvCell } from '@/lib/format/csv-sanitize';
import { PaginationBar, type PaginationInfo } from '@/components/ui/pagination-bar';

interface LedgerMovement {
  id: string;
  product_variant_id: string;
  sku: string | null;
  variant_name: string | null;
  product_name: string;
  location_name: string;
  employee_name: string;
  reason: string;
  delta: number;
  previous_on_hand: number;
  resulting_on_hand: number;
  created_at: string;
}

interface LedgerResponse {
  movements: LedgerMovement[];
  pagination: PaginationInfo;
}

const REASONS = ['', 'manual_adjustment', 'received', 'stocktake_adjustment', 'transfer_in', 'transfer_out', 'online_sale', 'online_refund'];

export default function InventoryLedgerPage() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (search.trim()) params.set('search', search.trim());
    if (reason) params.set('reason', reason);
    return params.toString();
  }, [page, pageSize, reason, search]);

  const fetchLedger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/inventory/ledger?${query}`);
      if (!response.ok) throw new Error('Failed to load inventory ledger');
      setData(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory ledger');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { fetchLedger(); }, [fetchLedger]);
  useEffect(() => { setPage(1); }, [search, reason, pageSize]);

  const movements = data?.movements ?? [];
  const exportCsv = () => {
    const header = ['Date', 'SKU', 'Product', 'Location', 'Employee', 'Reason', 'Previous', 'Delta', 'Resulting'];
    const csv = [header, ...movements.map((m) => [formatDate(m.created_at), m.sku ?? '', `${m.product_name} ${m.variant_name ?? ''}`.trim(), m.location_name, m.employee_name, m.reason, String(m.previous_on_hand), String(m.delta), String(m.resulting_on_hand)])]
      .map((row) => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `inventory-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">SKU timeline</p>
            <h1 className="mt-2 text-4xl font-bold text-slate-900">Inventory Ledger</h1>
            <p className="mt-2 text-slate-600">Audit every stock movement by SKU: sale, receiving, manual adjustment, cycle count, transfer, and online sync.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={fetchLedger} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Refresh</button>
            <button onClick={exportCsv} disabled={movements.length === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300">Export CSV</button>
            <Link href="/admin/inventory" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">Back to Inventory</Link>
          </div>
        </div>

        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className="grid gap-2 text-sm font-medium text-slate-700 md:col-span-2">Search SKU timeline
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU, product, variant" className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">Movement type
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                {REASONS.map((r) => <option key={r || 'all'} value={r}>{r || 'All reasons'}</option>)}
              </select>
            </label>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">SKU / Product</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3 text-right">Previous</th><th className="px-4 py-3 text-right">Delta</th><th className="px-4 py-3 text-right">Resulting</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">Loading ledger…</td></tr> : movements.length === 0 ? <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No ledger movements match these filters.</td></tr> : movements.map((m) => (
                <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50"><td className="px-4 py-3 text-slate-600">{formatDate(m.created_at)}</td><td className="px-4 py-3"><div className="font-semibold text-slate-900">{m.sku || 'No SKU'}</div><div className="text-xs text-slate-500">{m.product_name}{m.variant_name ? ` · ${m.variant_name}` : ''}</div></td><td className="px-4 py-3 text-slate-700">{m.location_name}</td><td className="px-4 py-3 text-slate-700">{m.employee_name}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{m.reason}</span></td><td className="px-4 py-3 text-right text-slate-700">{m.previous_on_hand}</td><td className={`px-4 py-3 text-right font-bold ${m.delta < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td className="px-4 py-3 text-right text-slate-700">{m.resulting_on_hand}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.pagination && data.pagination.total > 0 && <div className="mt-4"><PaginationBar pagination={data.pagination} onPageChange={setPage} onPageSizeChange={setPageSize} /></div>}
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
