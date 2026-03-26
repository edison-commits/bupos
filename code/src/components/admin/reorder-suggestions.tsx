'use client';

import { useState, useEffect, useCallback } from 'react';

interface ReorderItem {
  inventory_id: string;
  on_hand: number;
  reorder_point: number;
  variant_id: string;
  product_id: string;
  sku: string;
  variant_name: string;
  size_label: string | null;
  color_label: string | null;
  cost: number | null;
  product_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  location_name: string;
  suggested_qty: number;
}

interface SupplierGroup {
  supplier_id: string | null;
  supplier_name: string;
  items: ReorderItem[];
}

export function ReorderSuggestions() {
  const [groups, setGroups] = useState<SupplierGroup[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  // Editable quantities per variant_id
  const [qtys, setQtys] = useState<Record<string, number>>({});

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/reorder-suggestions');
      const data = await res.json();
      setGroups(data.groups || []);
      setTotalItems(data.totalItems || 0);
      // Initialize qtys from suggested
      const initial: Record<string, number> = {};
      for (const g of data.groups || []) {
        for (const item of g.items) {
          initial[item.variant_id] = item.suggested_qty;
        }
      }
      setQtys(initial);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load reorder suggestions.' });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSuggestions(); }, [fetchSuggestions]);

  const updateQty = (variantId: string, qty: number) => {
    setQtys((prev) => ({ ...prev, [variantId]: Math.max(0, qty) }));
  };

  const createPO = async (group: SupplierGroup) => {
    if (!group.supplier_id) {
      setMessage({ type: 'error', text: 'Cannot create PO for items with no supplier. Assign a supplier first.' });
      return;
    }

    const lines = group.items
      .filter((item) => (qtys[item.variant_id] || 0) > 0)
      .map((item) => ({
        product_variant_id: item.variant_id,
        quantity_ordered: qtys[item.variant_id] || item.suggested_qty,
        unit_cost: item.cost || 0,
      }));

    if (lines.length === 0) {
      setMessage({ type: 'error', text: 'No items with quantity > 0 to order.' });
      return;
    }

    setCreating(group.supplier_id);
    setMessage(null);

    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: group.supplier_id,
          notes: 'Auto-generated from low stock reorder suggestions',
          lines,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: data.error || 'Failed to create PO' }); return; }
      setMessage({ type: 'success', text: `Purchase order ${data.po_number} created with ${lines.length} items. Go to Purchase Orders to review and submit.` });
      // Remove this group from the list
      setGroups((prev) => prev.filter((g) => g.supplier_id !== group.supplier_id));
    } catch {
      setMessage({ type: 'error', text: 'Failed to create purchase order.' });
    } finally { setCreating(null); }
  };

  const formatCurrency = (v: number | null) => v != null ? `$${Number(v).toFixed(2)}` : '—';

  if (loading) return <div className="text-center py-8 text-zinc-400">Checking inventory levels...</div>;

  return (
    <div className="space-y-4">
      {totalItems === 0 ? (
        <div className="text-center py-8">
          <div className="text-2xl mb-2">&#10003;</div>
          <div className="text-zinc-600 font-medium">All stocked up!</div>
          <div className="text-sm text-zinc-400">No items are at or below their reorder point.</div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-100 text-amber-700">{totalItems}</span>
          <span className="text-sm text-zinc-600">item{totalItems !== 1 ? 's' : ''} at or below reorder point</span>
        </div>
      )}

      {message && (
        <div className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {groups.map((group) => {
        const groupTotal = group.items.reduce((s, item) => s + (qtys[item.variant_id] || 0) * (item.cost || 0), 0);
        const isUnassigned = !group.supplier_id;

        return (
          <div key={group.supplier_id || '_unassigned'} className={`rounded-xl border p-4 ${isUnassigned ? 'border-amber-200 bg-amber-50/50' : 'border-zinc-200 bg-white'}`}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="font-bold text-zinc-900">{group.supplier_name}</h4>
                <span className="text-xs text-zinc-500">{group.items.length} item{group.items.length !== 1 ? 's' : ''} need restocking</span>
              </div>
              {!isUnassigned && (
                <button
                  onClick={() => createPO(group)}
                  disabled={creating === group.supplier_id}
                  className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40"
                >
                  {creating === group.supplier_id ? 'Creating PO...' : `Create PO (${formatCurrency(groupTotal)})`}
                </button>
              )}
              {isUnassigned && (
                <span className="text-xs text-amber-600 font-medium">Assign a supplier to these products to auto-generate POs</span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left">
                    <th className="px-2 py-2 font-semibold text-zinc-700">Product</th>
                    <th className="px-2 py-2 font-semibold text-zinc-700">SKU</th>
                    <th className="px-2 py-2 text-center font-semibold text-zinc-700">On Hand</th>
                    <th className="px-2 py-2 text-center font-semibold text-zinc-700">Reorder Pt</th>
                    <th className="px-2 py-2 text-right font-semibold text-zinc-700">Unit Cost</th>
                    <th className="px-2 py-2 text-center font-semibold text-zinc-700 w-24">Order Qty</th>
                    <th className="px-2 py-2 text-right font-semibold text-zinc-700">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item) => {
                    const qty = qtys[item.variant_id] || 0;
                    const isOut = item.on_hand === 0;
                    return (
                      <tr key={item.variant_id} className={`border-b border-zinc-100 ${isOut ? 'bg-red-50/30' : ''}`}>
                        <td className="px-2 py-2">
                          <div className="font-medium text-zinc-900">{item.product_name}</div>
                          <div className="text-xs text-zinc-500">{item.variant_name}
                            {item.size_label && <span className="ml-1 px-1 bg-zinc-100 rounded">{item.size_label}</span>}
                            {item.color_label && <span className="ml-1 px-1 bg-zinc-100 rounded">{item.color_label}</span>}
                          </div>
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-zinc-600">{item.sku}</td>
                        <td className="px-2 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${isOut ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                            {item.on_hand}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center text-zinc-600">{item.reorder_point}</td>
                        <td className="px-2 py-2 text-right text-zinc-600">{formatCurrency(item.cost)}</td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="number"
                            min={0}
                            value={qty}
                            onChange={(e) => updateQty(item.variant_id, parseInt(e.target.value) || 0)}
                            className="w-16 text-center rounded-lg border border-zinc-300 px-1 py-1 text-sm"
                          />
                        </td>
                        <td className="px-2 py-2 text-right font-medium text-zinc-900">{formatCurrency(qty * (item.cost || 0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
