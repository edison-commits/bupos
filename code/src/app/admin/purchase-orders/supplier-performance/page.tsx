'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { csvCell } from '@/lib/format/csv-sanitize';
import { formatCurrency } from '@/lib/format';

interface OpenPurchaseOrder {
  id: string;
  po_number: string;
  status: string;
  expected_at: string | null;
  ordered_at: string | null;
  created_at: string;
  supplier_id: string;
  supplier_name: string;
  location_name: string;
  units_ordered: number;
  units_received: number;
  total_cost: number;
  days_overdue: number;
  is_overdue: boolean;
}

interface SupplierPerformance {
  supplier_id: string;
  supplier_name: string;
  po_count: number;
  open_count: number;
  partial_count: number;
  overdue_count: number;
  fill_rate: number;
  avg_days_to_receive: number;
  last_received_at: string | null;
}

interface SupplierPerformanceResponse {
  openPurchaseOrders: OpenPurchaseOrder[];
  supplierPerformance: SupplierPerformance[];
  summary: {
    open_count: number;
    overdue_count: number;
    partial_count: number;
    total_open_cost: number;
  };
}

export default function SupplierPerformancePage() {
  const [data, setData] = useState<SupplierPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/purchase-orders/supplier-performance');
      if (!response.ok) throw new Error('Failed to load supplier performance');
      setData(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier performance');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openOrders = useMemo(() => data?.openPurchaseOrders ?? [], [data?.openPurchaseOrders]);
  const suppliers = data?.supplierPerformance ?? [];
  const summary = data?.summary ?? { open_count: 0, overdue_count: 0, partial_count: 0, total_open_cost: 0 };

  const worstAging = useMemo(() => openOrders.reduce((max, po) => Math.max(max, Number(po.days_overdue ?? 0)), 0), [openOrders]);

  const exportCsv = () => {
    const header = ['Supplier', 'PO #', 'Location', 'Status', 'Expected', 'Days overdue', 'Ordered', 'Received', 'Total cost'];
    const rows = openOrders.map((po) => [
      po.supplier_name,
      po.po_number,
      po.location_name,
      po.status,
      po.expected_at ? new Date(po.expected_at).toLocaleDateString() : '',
      String(po.days_overdue ?? 0),
      String(po.units_ordered),
      String(po.units_received),
      String(po.total_cost),
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `supplier-performance-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">Procurement controls</p>
            <h1 className="mt-2 text-4xl font-bold text-slate-900">Supplier Performance</h1>
            <p className="mt-2 text-slate-600">PO Aging, supplier fill rate, overdue deliveries, and partial shipments.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={fetchData} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Refresh</button>
            <button onClick={exportCsv} disabled={openOrders.length === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300">Export CSV</button>
            <Link href="/admin/purchase-orders" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">Back to POs</Link>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-5">
          <Metric label="Open POs" value={summary.open_count} />
          <Metric label="Overdue" value={summary.overdue_count} tone="alert" />
          <Metric label="Partial shipments" value={summary.partial_count} tone="warn" />
          <Metric label="Worst PO Aging" value={`${worstAging}d`} tone={worstAging > 0 ? 'alert' : 'neutral'} />
          <Metric label="Open cost" value={formatCurrency(summary.total_open_cost)} />
        </div>

        <div className="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-bold text-slate-900">Supplier scorecard</h2>
            <p className="text-sm text-slate-500">Fill rate is received units divided by ordered units across each supplier&apos;s PO history.</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3 text-right">POs</th>
                <th className="px-4 py-3 text-right">Open</th>
                <th className="px-4 py-3 text-right">Overdue</th>
                <th className="px-4 py-3 text-right">Partial</th>
                <th className="px-4 py-3 text-right">Fill rate</th>
                <th className="px-4 py-3 text-right">Avg days to receive</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={7}>Loading supplier performance…</td></tr>
              ) : suppliers.length === 0 ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={7}>No supplier PO history yet.</td></tr>
              ) : suppliers.map((supplier) => (
                <tr key={supplier.supplier_id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-semibold text-slate-900">{supplier.supplier_name}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{supplier.po_count}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{supplier.open_count}</td>
                  <td className="px-4 py-3 text-right font-semibold text-red-700">{supplier.overdue_count}</td>
                  <td className="px-4 py-3 text-right font-semibold text-amber-700">{supplier.partial_count}</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-900">{Number(supplier.fill_rate).toFixed(1)}%</td>
                  <td className="px-4 py-3 text-right text-slate-700">{Number(supplier.avg_days_to_receive).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-bold text-slate-900">Open PO Aging</h2>
            <p className="text-sm text-slate-500">Submitted and partial POs ordered by overdue risk.</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3">PO</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3 text-right">Aging</th>
                <th className="px-4 py-3 text-right">Units</th>
                <th className="px-4 py-3 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={7}>Loading PO aging…</td></tr>
              ) : openOrders.length === 0 ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={7}>No open purchase orders.</td></tr>
              ) : openOrders.map((po) => (
                <tr key={po.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3"><Link href={`/admin/receiving?mode=po&po_id=${po.id}`} className="font-semibold text-teal-700 hover:underline">{po.po_number}</Link><div className="text-xs text-slate-500">{po.status}</div></td>
                  <td className="px-4 py-3 text-slate-700">{po.supplier_name}</td>
                  <td className="px-4 py-3 text-slate-700">{po.location_name}</td>
                  <td className="px-4 py-3 text-slate-700">{po.expected_at ? new Date(po.expected_at).toLocaleDateString() : 'No date'}</td>
                  <td className={`px-4 py-3 text-right font-bold ${po.is_overdue ? 'text-red-700' : 'text-slate-700'}`}>{po.days_overdue > 0 ? `${po.days_overdue}d overdue` : 'On time'}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{po.units_received}/{po.units_ordered}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{formatCurrency(Number(po.total_cost))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: number | string; tone?: 'neutral' | 'warn' | 'alert' }) {
  const colors = {
    neutral: 'bg-white text-slate-900 border-slate-200',
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
