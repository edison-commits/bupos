'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { formatCurrency } from '@/lib/format';

interface SpecialOrder {
  id: string;
  status: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  supplier_name?: string | null;
  po_number?: string | null;
  deposit_due: string | number;
  deposit_paid: string | number;
  needed_by?: string | null;
  request_notes?: string | null;
  line_count: number;
  total_units: number;
  estimated_total: string | number;
  created_at: string;
}

interface SpecialOrderLine {
  id: string;
  special_order_id: string;
  sku: string;
  product_name: string;
  variant_name: string;
  size_label?: string | null;
  color_label?: string | null;
  quantity: number;
  unit_price: string | number;
  notes?: string | null;
}

const statuses = ['requested', 'ordered', 'received', 'ready', 'fulfilled', 'cancelled'];

export default function SpecialOrdersPage() {
  const [orders, setOrders] = useState<SpecialOrder[]>([]);
  const [lines, setLines] = useState<SpecialOrderLine[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    customer_id: '',
    supplier_id: '',
    product_variant_id: '',
    quantity: '1',
    unit_price: '0',
    deposit_due: '0',
    deposit_paid: '0',
    needed_by: '',
    request_notes: '',
    line_notes: '',
  });

  const lineMap = useMemo(() => {
    const map = new Map<string, SpecialOrderLine[]>();
    for (const line of lines) {
      const current = map.get(line.special_order_id) ?? [];
      current.push(line);
      map.set(line.special_order_id, current);
    }
    return map;
  }, [lines]);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const res = await authFetch(`/api/special-orders?${params}`);
      if (!res.ok) throw new Error('Failed to load special orders');
      const data = await res.json();
      setOrders(data.orders ?? []);
      setLines(data.lines ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load special orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const submitOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setError(null);
    try {
      const res = await authFetch('/api/special-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: form.customer_id,
          supplier_id: form.supplier_id || undefined,
          request_notes: form.request_notes || undefined,
          deposit_due: Number(form.deposit_due || 0),
          deposit_paid: Number(form.deposit_paid || 0),
          needed_by: form.needed_by || undefined,
          lines: [{
            product_variant_id: form.product_variant_id,
            quantity: Number(form.quantity || 1),
            unit_price: Number(form.unit_price || 0),
            notes: form.line_notes || undefined,
          }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to create special order');
      setMessage('Special order created. Track it here until ordered, received, ready, and fulfilled.');
      setForm((prev) => ({ ...prev, product_variant_id: '', quantity: '1', unit_price: '0', line_notes: '', request_notes: '' }));
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create special order');
    }
  };

  const updateStatus = async (id: string, nextStatus: string) => {
    setMessage(null);
    setError(null);
    try {
      const res = await authFetch('/api/special-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'update_status', status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to update status');
      setMessage(nextStatus === 'ready' ? 'Ready for pickup — notify the customer.' : 'Special order updated.');
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const generatePo = async (order: SpecialOrder) => {
    setMessage(null);
    setError(null);
    try {
      const res = await authFetch('/api/special-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: order.id, action: 'generate_po' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate draft PO');
      setMessage('Generate draft PO complete. Review it in Purchase Orders before submitting to the supplier.');
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate draft PO');
    }
  };

  const requested = orders.filter((order) => order.status === 'requested').length;
  const ordered = orders.filter((order) => order.status === 'ordered').length;
  const ready = orders.filter((order) => order.status === 'ready').length;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-950">Special Orders & Backorders</h1>
            <p className="mt-1 text-sm text-slate-600">Customer request intake, deposit tracking, supplier PO handoff, and pickup readiness.</p>
          </div>
          <Link href="/admin/purchase-orders" className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
            Purchase Orders
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">Requested</p><p className="mt-1 text-3xl font-bold text-slate-950">{requested}</p></div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">On supplier order</p><p className="mt-1 text-3xl font-bold text-blue-700">{ordered}</p></div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">Ready for pickup</p><p className="mt-1 text-3xl font-bold text-emerald-700">{ready}</p></div>
        </div>

        {(message || error) && (
          <div className={`rounded-xl border p-4 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
            {error ?? message}
          </div>
        )}

        <form onSubmit={submitOrder} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-slate-950">Customer request intake</h2>
          <p className="mt-1 text-sm text-slate-500">Enter customer, supplier, and variant IDs from the admin records. The queue keeps the request tied to the customer until it is fulfilled.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <input required value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} placeholder="Customer ID" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })} placeholder="Supplier ID for PO" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input required value={form.product_variant_id} onChange={(e) => setForm({ ...form, product_variant_id: e.target.value })} placeholder="Product variant ID" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Qty" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input type="number" min="0" step="0.01" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} placeholder="Unit price" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input type="number" min="0" step="0.01" value={form.deposit_due} onChange={(e) => setForm({ ...form, deposit_due: e.target.value })} placeholder="Deposit due" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input type="number" min="0" step="0.01" value={form.deposit_paid} onChange={(e) => setForm({ ...form, deposit_paid: e.target.value })} placeholder="Deposit paid" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <input type="date" value={form.needed_by} onChange={(e) => setForm({ ...form, needed_by: e.target.value })} className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <textarea value={form.request_notes} onChange={(e) => setForm({ ...form, request_notes: e.target.value })} placeholder="Customer request notes" className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <textarea value={form.line_notes} onChange={(e) => setForm({ ...form, line_notes: e.target.value })} placeholder="Line notes: size, color, embroidery, account, etc." className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <button className="mt-4 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Create special order</button>
        </form>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-bold text-slate-950">Backorder queue</h2>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
              <option value="">All statuses</option>
              {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>

          {loading ? <p className="py-8 text-sm text-slate-500">Loading special orders…</p> : orders.length === 0 ? (
            <p className="py-8 text-sm text-slate-500">No special orders yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {orders.map((order) => (
                <div key={order.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">{order.first_name} {order.last_name}</p>
                      <p className="text-xs text-slate-500">{order.email || order.phone || 'No contact'} · {order.total_units} units · {formatCurrency(order.estimated_total)}</p>
                      <p className="mt-1 text-xs text-slate-500">Deposit due {formatCurrency(order.deposit_due)} · paid {formatCurrency(order.deposit_paid)} {order.needed_by ? `· Needed by ${order.needed_by}` : ''}</p>
                      {order.po_number && <p className="mt-1 text-xs font-semibold text-blue-700">PO {order.po_number}</p>}
                      {order.request_notes && <p className="mt-2 text-sm text-slate-700">{order.request_notes}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <select value={order.status} onChange={(e) => updateStatus(order.id, e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs">
                        {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                      {!order.po_number && <button onClick={() => generatePo(order)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700">Generate draft PO</button>}
                      <button onClick={() => updateStatus(order.id, 'ready')} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700">Ready for pickup</button>
                    </div>
                  </div>
                  <div className="mt-3 divide-y divide-slate-100 rounded-lg bg-slate-50 px-3">
                    {(lineMap.get(order.id) ?? []).map((line) => (
                      <div key={line.id} className="flex justify-between gap-3 py-2 text-sm">
                        <span>{line.product_name} {line.variant_name} <span className="text-xs text-slate-500">{line.sku}</span></span>
                        <span className="font-semibold">× {line.quantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
