'use client';

import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api/client';

interface OnlineOrder {
  externalOrderNumber: string | null;
  financialStatus: string | null;
  total: number | null;
  currency: string | null;
  decrementStatus: string;
  unresolvedCount: number;
  createdAt: string;
}
interface Report {
  days: number;
  summary: { orderCount: number; revenue: number; refundedCount: number; needsAttention: number; currency: string | null };
  orders: OnlineOrder[];
}

const money = (n: number | null, cur: string | null) =>
  n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n);

/**
 * Dedicated Online Sales report — fed from online_orders, kept separate from the
 * in-store transaction/shift reports (online sales have no cash drawer).
 */
export function OnlineSalesPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/channels/shopify/orders?days=${d}`);
      if (r.ok) setData((await r.json()) as Report);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const s = data?.summary;
  const cur = s?.currency ?? 'USD';

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Online sales</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="text-sm border border-gray-300 rounded px-2 py-1">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Revenue" value={money(s?.revenue ?? 0, cur)} />
        <Stat label="Orders" value={String(s?.orderCount ?? 0)} />
        <Stat label="Refunded" value={String(s?.refundedCount ?? 0)} />
        <Stat label="Needs attention" value={String(s?.needsAttention ?? 0)} warn={(s?.needsAttention ?? 0) > 0} />
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !data?.orders.length ? (
        <p className="text-sm text-gray-500">No online orders in this period yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-medium">Order</th>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium text-right">Total</th>
                <th className="py-2 pr-3 font-medium">Inventory</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-mono">{o.externalOrderNumber ?? '—'}</td>
                  <td className="py-2 pr-3 text-gray-600">{new Date(o.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 pr-3 capitalize">{o.financialStatus ?? '—'}</td>
                  <td className="py-2 pr-3 text-right">{money(o.total, o.currency)}</td>
                  <td className="py-2 pr-3"><InventoryBadge status={o.decrementStatus} unresolved={o.unresolvedCount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400">
        Online sales are reported here only — they do not affect register drawer counts or shift reports.
      </p>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${warn ? 'text-amber-700' : 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

function InventoryBadge({ status, unresolved }: { status: string; unresolved: number }) {
  if (unresolved > 0 || status === 'partial') {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">
        {unresolved > 0 ? `${unresolved} unmatched SKU${unresolved > 1 ? 's' : ''}` : 'partial'}
      </span>
    );
  }
  if (status === 'applied') return <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">applied</span>;
  return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">{status}</span>;
}
