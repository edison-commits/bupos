'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { csvCell } from '@/lib/format/csv-sanitize';
import { PaginationBar, type PaginationInfo } from '@/components/ui/pagination-bar';

interface AdjustmentRow {
  id: string;
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
  is_large_negative: boolean;
  is_after_hours: boolean;
  is_repeat_pattern: boolean;
}

interface AdjustmentSummary {
  total_adjustments: number;
  units_removed: number;
  units_added: number;
  large_negative_count: number;
  after_hours_count: number;
  repeated_negative_count: number;
}

interface PatternRow {
  employee_name?: string;
  sku?: string | null;
  product_name?: string;
  adjustment_count: number;
  units_removed: number;
  latest_at: string;
}

interface AdjustmentResponse {
  adjustments: AdjustmentRow[];
  summary: AdjustmentSummary;
  employeePatterns: PatternRow[];
  skuPatterns: PatternRow[];
  pagination: PaginationInfo;
}

const REASON_OPTIONS = [
  { value: '', label: 'All reasons' },
  { value: 'manual_adjustment', label: 'Manual adjustment' },
  { value: 'received', label: 'Receiving' },
  { value: 'stocktake_adjustment', label: 'Stocktake' },
  { value: 'transfer_out', label: 'Transfer out' },
  { value: 'transfer_in', label: 'Transfer in' },
  { value: 'online_sale', label: 'Online sale' },
  { value: 'online_refund', label: 'Online refund' },
];

export default function InventoryAdjustmentReviewPage() {
  const [data, setData] = useState<AdjustmentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [risk, setRisk] = useState<'all' | 'large_negative' | 'after_hours'>('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (reason) params.set('reason', reason);
    if (risk !== 'all') params.set('risk', risk);
    if (search.trim()) params.set('search', search.trim());
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [from, page, pageSize, reason, risk, search, to]);

  const fetchAdjustments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/inventory/adjustments?${query}`);
      if (!response.ok) throw new Error('Failed to fetch inventory adjustments');
      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load adjustment review');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchAdjustments();
  }, [fetchAdjustments]);

  useEffect(() => {
    setPage(1);
  }, [from, pageSize, reason, risk, search, to]);

  const rows = data?.adjustments ?? [];
  const summary = data?.summary ?? {
    total_adjustments: 0,
    units_removed: 0,
    units_added: 0,
    large_negative_count: 0,
    after_hours_count: 0,
    repeated_negative_count: 0,
  };

  const exportCsv = () => {
    const header = ['Date', 'Location', 'Employee', 'SKU', 'Product', 'Reason', 'Previous', 'Delta', 'Resulting', 'Flags'];
    const lines = rows.map((row) => [
      formatDate(row.created_at),
      row.location_name,
      row.employee_name,
      row.sku ?? '',
      `${row.product_name} ${row.variant_name ?? ''}`.trim(),
      row.reason,
      String(row.previous_on_hand),
      String(row.delta),
      String(row.resulting_on_hand),
      [row.is_large_negative ? 'Large negative' : '', row.is_after_hours ? 'After hours' : '', row.is_repeat_pattern ? 'Repeat pattern' : ''].filter(Boolean).join('; '),
    ]);
    const csv = [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `inventory-adjustments-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">Shrink controls</p>
            <h1 className="mt-2 text-4xl font-bold text-slate-900">Inventory Adjustment Review</h1>
            <p className="mt-2 text-slate-600">Audit manual stock changes, receiving deltas, transfer movements, and suspicious inventory variance.</p>
          </div>
          <Link href="/admin/inventory" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
            Back to Inventory
          </Link>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-6">
          <Metric label="Adjustments" value={summary.total_adjustments} />
          <Metric label="Units removed" value={summary.units_removed} tone="alert" />
          <Metric label="Units added" value={summary.units_added} tone="good" />
          <Metric label="Large negative" value={summary.large_negative_count} tone="warn" />
          <Metric label="After hours" value={summary.after_hours_count} tone="warn" />
          <Metric label="Repeat pattern" value={summary.repeated_negative_count} tone="alert" />
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PatternPanel title="Suspicious patterns by employee" rows={data?.employeePatterns ?? []} kind="employee" />
          <PatternPanel title="Suspicious patterns by SKU" rows={data?.skuPatterns ?? []} kind="sku" />
        </div>

        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
            <label className="grid gap-2 text-sm font-medium text-slate-700 md:col-span-2">
              Search SKU/product
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU or product" className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Reason
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                {REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Risk
              <select value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)} className="rounded-lg border border-slate-300 px-3 py-2">
                <option value="all">All</option>
                <option value="large_negative">Large negative</option>
                <option value="after_hours">After hours</option>
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              To
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-200 pt-4">
            <button onClick={() => fetchAdjustments()} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Refresh</button>
            <button onClick={exportCsv} disabled={rows.length === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300">Export CSV</button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Before</th>
                <th className="px-4 py-3 text-right">Delta</th>
                <th className="px-4 py-3 text-right">After</th>
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={9}>Loading adjustments…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={9}>No inventory adjustments match these filters.</td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(row.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-900">{row.sku || 'No SKU'}</div>
                    <div className="text-xs text-slate-500">{row.product_name}{row.variant_name ? ` · ${row.variant_name}` : ''}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{row.location_name}</td>
                  <td className="px-4 py-3 text-slate-700">{row.employee_name}</td>
                  <td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{row.reason}</span></td>
                  <td className="px-4 py-3 text-right text-slate-700">{row.previous_on_hand}</td>
                  <td className={`px-4 py-3 text-right font-bold ${row.delta < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{row.resulting_on_hand}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.is_large_negative && <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">Large negative</span>}
                      {row.is_after_hours && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">After hours</span>}
                      {row.is_repeat_pattern && <span className="rounded-full bg-purple-100 px-2 py-1 text-xs font-semibold text-purple-800">Repeat pattern</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data?.pagination && data.pagination.total > 0 && (
          <div className="mt-4">
            <PaginationBar pagination={data.pagination} onPageChange={setPage} onPageSizeChange={setPageSize} />
          </div>
        )}
      </div>
    </div>
  );
}

function PatternPanel({ title, rows, kind }: { title: string; rows: PatternRow[]; kind: 'employee' | 'sku' }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <p className="text-xs text-slate-500">Three or more negative adjustments in the current filter set.</p>
        </div>
        <span className="rounded-full bg-purple-100 px-2 py-1 text-xs font-semibold text-purple-800">Repeat pattern</span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-4 text-sm text-slate-500">No repeat shrink patterns found.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={`${kind}-${index}`} className="rounded-lg border border-slate-100 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">
                    {kind === 'employee' ? row.employee_name : `${row.sku || 'No SKU'} · ${row.product_name ?? 'Unknown product'}`}
                  </p>
                  <p className="text-xs text-slate-500">Latest: {formatDate(row.latest_at)}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-bold text-red-700">-{row.units_removed} units</p>
                  <p className="text-xs text-slate-500">{row.adjustment_count} adjustments</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'good' | 'warn' | 'alert' }) {
  const colors = {
    neutral: 'bg-white text-slate-900 border-slate-200',
    good: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    warn: 'bg-amber-50 text-amber-900 border-amber-200',
    alert: 'bg-red-50 text-red-900 border-red-200',
  }[tone];
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${colors}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
