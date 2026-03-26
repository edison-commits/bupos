'use client';

import { useState, useEffect, useCallback } from 'react';

interface Supplier { id: string; name: string; is_active: boolean; }

interface POSummary {
  id: string;
  po_number: string;
  status: string;
  supplier_name: string;
  location_name: string;
  line_count: number;
  total_units_ordered: number;
  total_units_received: number;
  total_cost: string;
  notes: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  received_at: string | null;
  created_at: string;
}

interface POLine {
  id: string;
  product_variant_id: string;
  variant_name: string;
  sku: string;
  size_label: string | null;
  color_label: string | null;
  product_name: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: string;
}

interface PODetail {
  id: string;
  po_number: string;
  status: string;
  supplier_name: string;
  supplier_contact: string | null;
  supplier_email: string | null;
  location_name: string;
  notes: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  received_at: string | null;
}

interface InventoryItem {
  variant_id: string;
  variant_name: string;
  sku: string;
  product_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  cost: number | null;
  on_hand: number;
  reorder_point: number;
}

type View = 'list' | 'detail' | 'create';

export function PurchaseOrderManager() {
  const [view, setView] = useState<View>('list');
  const [orders, setOrders] = useState<POSummary[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Detail view
  const [detail, setDetail] = useState<PODetail | null>(null);
  const [detailLines, setDetailLines] = useState<POLine[]>([]);
  const [receiving, setReceiving] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, number>>({});

  // Create form
  const [newSupplierId, setNewSupplierId] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newExpected, setNewExpected] = useState('');
  const [newLines, setNewLines] = useState<Array<{ product_variant_id: string; label: string; quantity_ordered: number; unit_cost: number }>>([]);
  const [variantSearch, setVariantSearch] = useState('');
  const [variantResults, setVariantResults] = useState<InventoryItem[]>([]);
  const [searchingVariants, setSearchingVariants] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/purchase-orders');
      const data = await res.json();
      setOrders(data.orders || []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  const fetchSuppliers = useCallback(async () => {
    try {
      const res = await fetch('/api/suppliers');
      const data = await res.json();
      setSuppliers((data.suppliers || []).filter((s: Supplier) => s.is_active));
    } catch { /* */ }
  }, []);

  useEffect(() => { fetchOrders(); fetchSuppliers(); }, [fetchOrders, fetchSuppliers]);

  const openDetail = async (poId: string) => {
    try {
      const res = await fetch(`/api/purchase-orders?id=${poId}`);
      const data = await res.json();
      setDetail(data.order);
      setDetailLines(data.lines || []);
      setReceiveQtys({});
      setView('detail');
    } catch {
      setMessage({ type: 'error', text: 'Failed to load PO details' });
    }
  };

  const openCreate = () => {
    setNewSupplierId(suppliers[0]?.id || '');
    setNewNotes('');
    setNewExpected('');
    setNewLines([]);
    setVariantSearch('');
    setVariantResults([]);
    setMessage(null);
    setView('create');
  };

  // Search products for adding lines
  const searchVariants = async () => {
    if (!variantSearch.trim()) return;
    setSearchingVariants(true);
    try {
      const res = await fetch(`/api/inventory?search=${encodeURIComponent(variantSearch)}&pageSize=20`);
      const data = await res.json();
      setVariantResults((data.items || []).map((i: Record<string, unknown>) => ({
        variant_id: i.variant_id,
        variant_name: i.variant_name,
        sku: i.sku,
        product_name: i.product_name,
        size_label: i.size_label,
        color_label: i.color_label,
        price: Number(i.price),
        cost: i.cost ? Number(i.cost) : null,
        on_hand: Number(i.on_hand),
        reorder_point: Number(i.reorder_point),
      })));
    } catch { /* */ } finally { setSearchingVariants(false); }
  };

  const addLine = (item: InventoryItem) => {
    if (newLines.some((l) => l.product_variant_id === item.variant_id)) return;
    const label = `${item.product_name} — ${item.variant_name} (${item.sku})`;
    const suggestedQty = Math.max(0, (item.reorder_point * 2) - item.on_hand);
    setNewLines([...newLines, {
      product_variant_id: item.variant_id,
      label,
      quantity_ordered: suggestedQty || 10,
      unit_cost: item.cost || 0,
    }]);
  };

  const updateLine = (idx: number, field: 'quantity_ordered' | 'unit_cost', value: number) => {
    setNewLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  const removeLine = (idx: number) => {
    setNewLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreate = async () => {
    if (!newSupplierId) { setMessage({ type: 'error', text: 'Select a supplier.' }); return; }
    if (newLines.length === 0) { setMessage({ type: 'error', text: 'Add at least one line item.' }); return; }

    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: newSupplierId,
          notes: newNotes || null,
          expected_at: newExpected || null,
          lines: newLines.map((l) => ({
            product_variant_id: l.product_variant_id,
            quantity_ordered: l.quantity_ordered,
            unit_cost: l.unit_cost,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: data.error }); return; }
      setMessage({ type: 'success', text: `Purchase order ${data.po_number} created.` });
      setView('list');
      fetchOrders();
    } catch {
      setMessage({ type: 'error', text: 'Failed to create PO.' });
    } finally { setSaving(false); }
  };

  const handleStatusChange = async (status: string) => {
    if (!detail) return;
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: detail.id, status }),
      });
      if (res.ok) {
        const data = await res.json();
        setDetail(data.order);
        fetchOrders();
      }
    } catch { /* */ }
  };

  const handleReceive = async () => {
    if (!detail) return;
    const receives = Object.entries(receiveQtys)
      .filter(([, qty]) => qty > 0)
      .map(([line_id, quantity_received]) => ({ line_id, quantity_received }));

    if (receives.length === 0) { setMessage({ type: 'error', text: 'Enter quantities to receive.' }); return; }

    setReceiving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: detail.id, receives }),
      });
      if (!res.ok) { const err = await res.json(); setMessage({ type: 'error', text: err.error }); return; }
      setMessage({ type: 'success', text: 'Items received and inventory updated.' });
      openDetail(detail.id);
      fetchOrders();
    } catch {
      setMessage({ type: 'error', text: 'Failed to receive items.' });
    } finally { setReceiving(false); }
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-zinc-100 text-zinc-600',
      submitted: 'bg-blue-100 text-blue-700',
      partial: 'bg-amber-100 text-amber-700',
      received: 'bg-emerald-100 text-emerald-700',
      cancelled: 'bg-red-100 text-red-600',
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${colors[status] || 'bg-zinc-100 text-zinc-600'}`}>{status}</span>;
  };

  const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : '—';
  const formatCurrency = (v: string | number) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ─── LIST VIEW ───
  if (view === 'list') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-600">{orders.length} purchase order{orders.length !== 1 ? 's' : ''}</span>
          <button onClick={openCreate} className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800">
            + New PO
          </button>
        </div>

        {message && (
          <div className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {message.text}
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-zinc-400">Loading...</div>
        ) : orders.length === 0 ? (
          <div className="text-center py-8 text-zinc-400">No purchase orders yet. Create your first PO above.</div>
        ) : (
          <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200">
                  <th className="text-left px-3 py-3 font-semibold text-zinc-700">PO #</th>
                  <th className="text-left px-3 py-3 font-semibold text-zinc-700">Supplier</th>
                  <th className="text-center px-3 py-3 font-semibold text-zinc-700">Status</th>
                  <th className="text-center px-3 py-3 font-semibold text-zinc-700">Items</th>
                  <th className="text-center px-3 py-3 font-semibold text-zinc-700">Received</th>
                  <th className="text-right px-3 py-3 font-semibold text-zinc-700">Total</th>
                  <th className="text-center px-3 py-3 font-semibold text-zinc-700">Expected</th>
                  <th className="text-center px-3 py-3 font-semibold text-zinc-700">Created</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-zinc-100 hover:bg-zinc-50/50 cursor-pointer" onClick={() => openDetail(o.id)}>
                    <td className="px-3 py-2.5 font-mono font-medium text-teal-700">{o.po_number}</td>
                    <td className="px-3 py-2.5 text-zinc-800">{o.supplier_name}</td>
                    <td className="px-3 py-2.5 text-center">{statusBadge(o.status)}</td>
                    <td className="px-3 py-2.5 text-center text-zinc-600">{o.line_count}</td>
                    <td className="px-3 py-2.5 text-center text-zinc-600">{o.total_units_received}/{o.total_units_ordered}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{formatCurrency(o.total_cost)}</td>
                    <td className="px-3 py-2.5 text-center text-zinc-500 text-xs">{formatDate(o.expected_at)}</td>
                    <td className="px-3 py-2.5 text-center text-zinc-500 text-xs">{formatDate(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ─── DETAIL VIEW ───
  if (view === 'detail' && detail) {
    const totalOrdered = detailLines.reduce((s, l) => s + l.quantity_ordered, 0);
    const totalReceived = detailLines.reduce((s, l) => s + l.quantity_received, 0);
    const totalCost = detailLines.reduce((s, l) => s + l.quantity_ordered * Number(l.unit_cost), 0);
    const isReceivable = detail.status === 'submitted' || detail.status === 'partial';

    return (
      <div className="space-y-4">
        <button onClick={() => { setView('list'); setMessage(null); }} className="text-sm text-teal-700 hover:text-teal-900 font-medium">
          &larr; Back to list
        </button>

        {message && (
          <div className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {message.text}
          </div>
        )}

        {/* PO Header */}
        <div className="rounded-xl bg-white border border-zinc-200 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-xl font-bold text-zinc-900">{detail.po_number}</h3>
              <p className="text-sm text-zinc-600 mt-1">{detail.supplier_name}{detail.supplier_contact ? ` — ${detail.supplier_contact}` : ''}</p>
              {detail.supplier_email && <p className="text-xs text-zinc-400">{detail.supplier_email}</p>}
            </div>
            <div className="text-right">
              {statusBadge(detail.status)}
              <div className="text-lg font-bold text-zinc-900 mt-2">{formatCurrency(totalCost)}</div>
              <div className="text-xs text-zinc-500">{totalReceived}/{totalOrdered} units received</div>
            </div>
          </div>
          <div className="flex gap-4 mt-3 text-xs text-zinc-500">
            <span>Location: {detail.location_name}</span>
            {detail.ordered_at && <span>Ordered: {formatDate(detail.ordered_at)}</span>}
            {detail.expected_at && <span>Expected: {formatDate(detail.expected_at)}</span>}
            {detail.received_at && <span>Received: {formatDate(detail.received_at)}</span>}
          </div>
          {detail.notes && <p className="mt-2 text-sm text-zinc-600 bg-zinc-50 rounded-lg p-2">{detail.notes}</p>}

          {/* Status actions */}
          <div className="flex gap-2 mt-4">
            {detail.status === 'draft' && (
              <button onClick={() => handleStatusChange('submitted')} className="touch-button px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
                Mark as Submitted
              </button>
            )}
            {(detail.status === 'draft' || detail.status === 'submitted') && (
              <button onClick={() => handleStatusChange('cancelled')} className="touch-button px-4 py-2 rounded-lg bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200">
                Cancel PO
              </button>
            )}
          </div>
        </div>

        {/* Line Items */}
        <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                <th className="text-left px-3 py-3 font-semibold text-zinc-700">Product</th>
                <th className="text-left px-3 py-3 font-semibold text-zinc-700">SKU</th>
                <th className="text-center px-3 py-3 font-semibold text-zinc-700">Ordered</th>
                <th className="text-center px-3 py-3 font-semibold text-zinc-700">Received</th>
                <th className="text-right px-3 py-3 font-semibold text-zinc-700">Unit Cost</th>
                <th className="text-right px-3 py-3 font-semibold text-zinc-700">Line Total</th>
                {isReceivable && <th className="text-center px-3 py-3 font-semibold text-zinc-700">Receive</th>}
              </tr>
            </thead>
            <tbody>
              {detailLines.map((line) => {
                const remaining = line.quantity_ordered - line.quantity_received;
                const isFull = remaining <= 0;
                return (
                  <tr key={line.id} className={`border-b border-zinc-100 ${isFull ? 'bg-emerald-50/30' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-zinc-900">{line.product_name}</div>
                      <div className="text-xs text-zinc-500">{line.variant_name}
                        {line.size_label && <span className="ml-1 px-1 bg-zinc-100 rounded">{line.size_label}</span>}
                        {line.color_label && <span className="ml-1 px-1 bg-zinc-100 rounded">{line.color_label}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-zinc-600">{line.sku}</td>
                    <td className="px-3 py-2.5 text-center text-zinc-800">{line.quantity_ordered}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={isFull ? 'text-emerald-700 font-bold' : 'text-zinc-800'}>
                        {line.quantity_received}
                      </span>
                      {isFull && <span className="ml-1 text-emerald-600 text-xs">&#10003;</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-zinc-600">{formatCurrency(line.unit_cost)}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{formatCurrency(line.quantity_ordered * Number(line.unit_cost))}</td>
                    {isReceivable && (
                      <td className="px-3 py-2.5 text-center">
                        {isFull ? (
                          <span className="text-xs text-emerald-600">Done</span>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            max={remaining}
                            value={receiveQtys[line.id] || ''}
                            onChange={(e) => setReceiveQtys((prev) => ({ ...prev, [line.id]: Math.min(remaining, parseInt(e.target.value) || 0) }))}
                            placeholder={String(remaining)}
                            className="w-16 text-center rounded-lg border border-zinc-300 px-1 py-1 text-sm"
                          />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Receive button */}
        {isReceivable && (
          <button onClick={handleReceive} disabled={receiving}
            className="touch-button px-6 py-2.5 rounded-lg bg-emerald-700 text-white font-semibold text-sm hover:bg-emerald-800 disabled:opacity-40">
            {receiving ? 'Receiving...' : 'Receive Items & Update Inventory'}
          </button>
        )}
      </div>
    );
  }

  // ─── CREATE VIEW ───
  if (view === 'create') {
    const lineTotal = newLines.reduce((s, l) => s + l.quantity_ordered * l.unit_cost, 0);

    return (
      <div className="space-y-4">
        <button onClick={() => { setView('list'); setMessage(null); }} className="text-sm text-teal-700 hover:text-teal-900 font-medium">
          &larr; Back to list
        </button>

        <h3 className="text-lg font-bold text-zinc-900">Create Purchase Order</h3>

        {message && (
          <div className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {message.text}
          </div>
        )}

        {/* PO Header */}
        <div className="rounded-xl bg-white border border-zinc-200 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Supplier <span className="text-red-500">*</span></label>
              <select value={newSupplierId} onChange={(e) => setNewSupplierId(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700">
                <option value="">Select supplier...</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Expected Delivery</label>
              <input type="date" value={newExpected} onChange={(e) => setNewExpected(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
              <input type="text" value={newNotes} onChange={(e) => setNewNotes(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="Rush order, special terms..." />
            </div>
          </div>
        </div>

        {/* Product Search */}
        <div className="rounded-xl bg-white border border-zinc-200 p-4">
          <label className="block text-sm font-medium text-zinc-700 mb-2">Add products to order</label>
          <div className="flex gap-2">
            <input type="text" value={variantSearch} onChange={(e) => setVariantSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchVariants()}
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
              placeholder="Search by product name, SKU, barcode..." />
            <button onClick={searchVariants} disabled={searchingVariants}
              className="touch-button px-4 py-2.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-sm font-medium">
              {searchingVariants ? 'Searching...' : 'Search'}
            </button>
          </div>

          {variantResults.length > 0 && (
            <div className="mt-3 max-h-48 overflow-y-auto border border-zinc-200 rounded-lg divide-y divide-zinc-100">
              {variantResults.map((item) => {
                const alreadyAdded = newLines.some((l) => l.product_variant_id === item.variant_id);
                return (
                  <div key={item.variant_id} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-50">
                    <div>
                      <span className="text-sm font-medium text-zinc-900">{item.product_name}</span>
                      <span className="text-sm text-zinc-500 ml-1">— {item.variant_name}</span>
                      <span className="text-xs text-zinc-400 ml-2 font-mono">{item.sku}</span>
                      <span className="text-xs ml-2 text-zinc-400">On hand: {item.on_hand} / Reorder: {item.reorder_point}</span>
                    </div>
                    <button onClick={() => addLine(item)} disabled={alreadyAdded}
                      className={`touch-button px-3 py-1 rounded-lg text-xs font-medium ${alreadyAdded ? 'bg-zinc-100 text-zinc-400' : 'bg-teal-100 hover:bg-teal-200 text-teal-700'}`}>
                      {alreadyAdded ? 'Added' : '+ Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Line Items */}
        {newLines.length > 0 && (
          <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200">
                  <th className="text-left px-3 py-2 font-semibold text-zinc-700">Product</th>
                  <th className="text-center px-3 py-2 font-semibold text-zinc-700 w-28">Quantity</th>
                  <th className="text-center px-3 py-2 font-semibold text-zinc-700 w-28">Unit Cost</th>
                  <th className="text-right px-3 py-2 font-semibold text-zinc-700 w-24">Total</th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {newLines.map((line, idx) => (
                  <tr key={line.product_variant_id} className="border-b border-zinc-100">
                    <td className="px-3 py-2 text-zinc-800">{line.label}</td>
                    <td className="px-3 py-2 text-center">
                      <input type="number" min={1} value={line.quantity_ordered}
                        onChange={(e) => updateLine(idx, 'quantity_ordered', parseInt(e.target.value) || 0)}
                        className="w-20 text-center rounded-lg border border-zinc-300 px-1 py-1 text-sm" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input type="number" min={0} step={0.01} value={line.unit_cost}
                        onChange={(e) => updateLine(idx, 'unit_cost', parseFloat(e.target.value) || 0)}
                        className="w-20 text-center rounded-lg border border-zinc-300 px-1 py-1 text-sm" />
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-zinc-900">{formatCurrency(line.quantity_ordered * line.unit_cost)}</td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => removeLine(idx)} className="text-red-400 hover:text-red-600 text-lg">&times;</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-zinc-50">
                  <td colSpan={3} className="px-3 py-2 text-right font-semibold text-zinc-700">Order Total:</td>
                  <td className="px-3 py-2 text-right font-bold text-zinc-900 text-base">{formatCurrency(lineTotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-3">
          <button onClick={handleCreate} disabled={saving || newLines.length === 0}
            className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40">
            {saving ? 'Creating...' : `Create PO (${newLines.length} items, ${formatCurrency(lineTotal)})`}
          </button>
          <button onClick={() => setView('list')}
            className="touch-button px-6 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return null;
}
