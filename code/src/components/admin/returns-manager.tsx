'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from "@/lib/format";

interface ReturnRecord {
  id: string;
  return_number: string;
  customer_name: string | null;
  reason: string;
  refund_method: string;
  refund_amount: string;
  status: string;
  notes: string | null;
  processed_by: string | null;
  location_name: string;
  line_count: number;
  total_items: number;
  created_at: string;
}

interface InventoryItem {
  variant_id: string; variant_name: string; sku: string; product_name: string;
  price: number; size_label: string | null; color_label: string | null;
}

type View = 'list' | 'create';

const REASONS = [
  { value: 'defective', label: 'Defective / Damaged' },
  { value: 'wrong_size', label: 'Wrong Size' },
  { value: 'wrong_item', label: 'Wrong Item' },
  { value: 'changed_mind', label: 'Changed Mind' },
  { value: 'other', label: 'Other' },
];

const REFUND_METHODS = [
  { value: 'store_credit', label: 'Store Credit' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card Refund' },
  { value: 'exchange', label: 'Exchange' },
];

export function ReturnsManager() {
  const [view, setView] = useState<View>('list');
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create form
  const [customerName, setCustomerName] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [reason, setReason] = useState('changed_mind');
  const [refundMethod, setRefundMethod] = useState('store_credit');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ product_variant_id: string; label: string; quantity: number; unit_price: number; restock: boolean }>>([]);
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadedTxnId, setLoadedTxnId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchReturns = useCallback(async () => {
    try {
      const res = await fetch('/api/returns');
      if (!res.ok) throw new Error('Failed to load returns');
      const data = await res.json();
      setReturns(data.returns || []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchReturns(); }, [fetchReturns]);

  // Load the line items of the original transaction. The /api/returns POST
  // rejects any variant not in the original cart_snapshot, so the picker must
  // ONLY show items actually in that transaction.
  const loadTransactionLines = async () => {
    const id = transactionId.trim();
    if (!id) {
      setMessage({ type: 'error', text: 'Enter a transaction ID first.' });
      return;
    }
    setSearching(true);
    setSearchResults([]);
    try {
      const res = await fetch(`/api/transactions?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        setMessage({ type: 'error', text: 'Transaction not found' });
        return;
      }
      const data = await res.json();
      const cart = data.transaction?.cart_snapshot
        ?? data.transaction?.cartSnapshot
        ?? null;
      const items: Array<{ productVariantId?: string; variantId?: string; productName?: string; variantName?: string; sku?: string; unitPrice: number; quantity: number }> =
        (cart?.items ?? []) as Array<{ productVariantId?: string; variantId?: string; productName?: string; variantName?: string; sku?: string; unitPrice: number; quantity: number }>;
      setSearchResults(items.map((i) => ({
        variant_id: (i.productVariantId ?? i.variantId ?? '') as string,
        variant_name: (i.variantName ?? '') as string,
        sku: (i.sku ?? '') as string,
        product_name: (i.productName ?? 'Item') as string,
        price: Number(i.unitPrice) || 0,
      } as InventoryItem)));
      setLoadedTxnId(id);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load transaction items' });
    } finally { setSearching(false); }
  };

  const addLine = (item: InventoryItem) => {
    if (lines.some((l) => l.product_variant_id === item.variant_id)) return;
    setLines([...lines, {
      product_variant_id: item.variant_id,
      label: `${item.product_name} — ${item.variant_name} (${item.sku})`,
      quantity: 1, unit_price: item.price, restock: true,
    }]);
  };

  const handleCreate = async () => {
    if (!transactionId.trim()) {
      setMessage({ type: 'error', text: 'Original transaction ID is required.' });
      return;
    }
    if (lines.length === 0) { setMessage({ type: 'error', text: 'Add at least one item.' }); return; }
    setSaving(true); setMessage(null);
    try {
      const res = await fetch('/api/returns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId.trim(), customer_name: customerName || null, reason, refund_method: refundMethod, notes: notes || null, lines }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: data.error }); return; }
      setMessage({ type: 'success', text: `Return ${data.return_number} created.` });
      setView('list'); fetchReturns();
    } catch { setMessage({ type: 'error', text: 'Failed to create return.' }); }
    finally { setSaving(false); }
  };

  const handleStatus = async (id: string, status: string) => {
    try {
      await fetch('/api/returns', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      fetchReturns();
      if (status === 'completed') setMessage({ type: 'success', text: 'Return completed. Inventory restocked for eligible items.' });
    } catch { /* */ }
  };

  const statusBadge = (s: string) => {
    const c: Record<string, string> = { pending: 'bg-amber-100 text-amber-700', approved: 'bg-blue-100 text-blue-700', completed: 'bg-emerald-100 text-emerald-700', rejected: 'bg-red-100 text-red-600' };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${c[s] || 'bg-zinc-100 text-zinc-600'}`}>{s}</span>;
  };

  const refundTotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  if (view === 'create') {
    return (
      <div className="space-y-4">
        <button onClick={() => setView('list')} className="text-sm text-teal-700 hover:text-teal-900 font-medium">&larr; Back</button>
        <h3 className="text-lg font-bold text-zinc-900">Process Return</h3>

        {message && <div role="alert" className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>{message.text}</div>}

        <div className="rounded-xl bg-white border border-zinc-200 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-zinc-700 mb-1">Original Transaction ID <span className="text-red-500">*</span></label>
            <input type="text" value={transactionId} onChange={(e) => setTransactionId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm font-mono text-zinc-800" placeholder="UUID of the original sale" />
            <p className="mt-1 text-xs text-zinc-500">Required. Refund amount, tax, and eligible items are derived server-side from this transaction.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Customer Name</label>
            <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="Optional" />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700">
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Refund Method</label>
            <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700">
              {REFUND_METHODS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="Optional notes..." />
          </div>
        </div>

        {/* Load the original transaction's items and let the user pick from those.
            Picking an arbitrary item from global inventory used to produce a
            cryptic "variant was not in the original transaction" server error. */}
        <div className="rounded-xl bg-white border border-zinc-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-zinc-700">Items from original transaction</label>
            <button onClick={loadTransactionLines} disabled={searching || !transactionId.trim()} className="touch-button px-4 py-2 rounded-lg bg-teal-100 hover:bg-teal-200 text-teal-700 text-sm font-medium disabled:opacity-40">
              {searching ? 'Loading...' : (loadedTxnId === transactionId.trim() ? 'Reload' : 'Load items')}
            </button>
          </div>
          {searchResults.length > 0 ? (
            <div className="mt-1 max-h-56 overflow-y-auto border border-zinc-200 rounded-lg divide-y divide-zinc-100">
              {searchResults.map((item) => (
                <div key={item.variant_id} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-50">
                  <span className="text-sm text-zinc-800">{item.product_name}{item.variant_name ? ` — ${item.variant_name}` : ''} {item.sku ? <span className="text-xs text-zinc-400 font-mono">{item.sku}</span> : null}</span>
                  <button onClick={() => addLine(item)} disabled={lines.some((l) => l.product_variant_id === item.variant_id)}
                    className="touch-button px-3 py-1 rounded-lg text-xs font-medium bg-teal-100 hover:bg-teal-200 text-teal-700 disabled:opacity-40">+ Add</button>
                </div>
              ))}
            </div>
          ) : loadedTxnId ? (
            <p className="text-xs text-zinc-500">This transaction has no line items.</p>
          ) : (
            <p className="text-xs text-zinc-500">Enter a transaction ID above and click &ldquo;Load items&rdquo;.</p>
          )}
        </div>

        {/* Return lines */}
        {lines.length > 0 && (
          <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-zinc-50 border-b border-zinc-200">
                <th className="text-left px-3 py-2 font-semibold text-zinc-700">Item</th>
                <th className="text-center px-3 py-2 font-semibold text-zinc-700 w-20">Qty</th>
                <th className="text-right px-3 py-2 font-semibold text-zinc-700 w-24">Price</th>
                <th className="text-center px-3 py-2 font-semibold text-zinc-700 w-20">Restock</th>
                <th className="w-10"></th>
              </tr></thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.product_variant_id} className="border-b border-zinc-100">
                    <td className="px-3 py-2 text-zinc-800">{line.label}</td>
                    <td className="px-3 py-2 text-center">
                      <input type="number" min={1} value={line.quantity} onChange={(e) => {
                        const v = parseInt(e.target.value) || 1;
                        setLines((p) => p.map((l, i) => i === idx ? { ...l, quantity: v } : l));
                      }} className="w-14 text-center rounded-lg border border-zinc-300 px-1 py-1 text-sm" />
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-800">{formatCurrency((line.quantity * line.unit_price))}</td>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={line.restock} onChange={(e) => {
                        setLines((p) => p.map((l, i) => i === idx ? { ...l, restock: e.target.checked } : l));
                      }} className="rounded" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => setLines((p) => p.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600">&times;</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="bg-zinc-50">
                <td colSpan={2} className="px-3 py-2 text-right font-semibold text-zinc-700">Refund Total:</td>
                <td className="px-3 py-2 text-right font-bold text-zinc-900">{formatCurrency(refundTotal)}</td>
                <td colSpan={2}></td>
              </tr></tfoot>
            </table>
          </div>
        )}

        <button onClick={handleCreate} disabled={saving || lines.length === 0}
          className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40">
          {saving ? 'Processing...' : `Create Return (${formatCurrency(refundTotal)})`}
        </button>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-600">{returns.length} return{returns.length !== 1 ? 's' : ''}</span>
        <button onClick={() => { setView('create'); setLines([]); setCustomerName(''); setNotes(''); setMessage(null); setSearchResults([]); }}
          className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800">+ Process Return</button>
      </div>
      {message && <div role="alert" className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>{message.text}</div>}
      {loading ? <div className="text-center py-8 text-zinc-400">Loading...</div> : returns.length === 0 ? (
        <div className="text-center py-8 text-zinc-400">No returns yet.</div>
      ) : (
        <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Return #</th>
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Customer</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Reason</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Method</th>
              <th className="text-right px-3 py-3 font-semibold text-zinc-700">Refund</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Items</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Status</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Actions</th>
            </tr></thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id} className="border-b border-zinc-100 hover:bg-zinc-50/50">
                  <td className="px-3 py-2.5 font-mono font-medium text-teal-700">{r.return_number}</td>
                  <td className="px-3 py-2.5 text-zinc-800">{r.customer_name || '—'}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-zinc-600">{r.reason.replace('_', ' ')}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-zinc-600">{r.refund_method.replace('_', ' ')}</td>
                  <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{formatCurrency(Number(r.refund_amount))}</td>
                  <td className="px-3 py-2.5 text-center text-zinc-600">{r.total_items}</td>
                  <td className="px-3 py-2.5 text-center">{statusBadge(r.status)}</td>
                  <td className="px-3 py-2.5 text-center">
                    {r.status === 'pending' && (
                      <div className="flex gap-1 justify-center">
                        <button onClick={() => handleStatus(r.id, 'completed')} className="touch-button px-2 py-1 rounded text-xs font-medium bg-emerald-100 hover:bg-emerald-200 text-emerald-700">Complete</button>
                        <button onClick={() => handleStatus(r.id, 'rejected')} className="touch-button px-2 py-1 rounded text-xs font-medium bg-red-100 hover:bg-red-200 text-red-600">Reject</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
