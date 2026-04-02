'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { AdminTopNav } from "@/components/layout/admin-top-nav";
interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
}

interface Product {
  id: string;
  name: string;
}

interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  product_id: string;
  product_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  cost: number;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_name: string;
  location_name: string;
  status: string;
  total_units_ordered: number;
  total_units_received: number;
  total_cost: number;
  line_count: number;
  expected_at: string | null;
  ordered_at: string | null;
  received_at: string | null;
  created_at: string;
}

interface PurchaseOrderLine {
  id: string;
  product_variant_id: string;
  variant_name: string;
  sku: string;
  product_name: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
}

interface POWithLines extends PurchaseOrder {
  lines: PurchaseOrderLine[];
}

interface LineItemInput {
  product_variant_id: string;
  variant_name: string;
  sku: string;
  product_name: string;
  quantity_ordered: number;
  unit_cost: number;
  temp_id: string; // For UI tracking before save
}

const statusBadgeColor = (status: string) => {
  switch (status) {
    case 'draft': return '#e5e7eb'; // gray-200
    case 'pending': return '#3b82f6'; // blue-500
    case 'partial': return '#f59e0b'; // amber-500
    case 'received': return '#10b981'; // emerald-500
    case 'cancelled': return '#ef4444'; // red-500
    default: return '#9ca3af'; // gray-400
  }
};

const statusTextColor = (status: string) => {
  switch (status) {
    case 'draft': return '#374151'; // gray-700
    case 'pending': return 'white';
    case 'partial': return 'white';
    case 'received': return 'white';
    case 'cancelled': return 'white';
    default: return 'white';
  }
};

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<POWithLines | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create PO modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    supplier_id: '',
    notes: '',
    expected_at: '',
    lines: [] as LineItemInput[],
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProductVariant[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Current line being added
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [lineQty, setLineQty] = useState('');
  const [lineUnitCost, setLineUnitCost] = useState('');

  // Filter state
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'pending' | 'partial' | 'received'>('all');

  // Loading states
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Fetch orders
  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/purchase-orders');
      if (!res.ok) throw new Error('Failed to fetch purchase orders');
      const data = await res.json();
      setOrders(data.orders || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch suppliers
  const fetchSuppliers = useCallback(async () => {
    try {
      const res = await fetch('/api/suppliers');
      if (!res.ok) throw new Error('Failed to fetch suppliers');
      const data = await res.json();
      setSuppliers(data.suppliers || []);
    } catch (err) {
      console.error('Failed to fetch suppliers:', err);
    }
  }, []);

  // Fetch single PO details
  const fetchPODetails = useCallback(async (poId: string) => {
    try {
      const res = await fetch(`/api/purchase-orders?id=${poId}`);
      if (!res.ok) throw new Error('Failed to fetch PO details');
      const data = await res.json();
      setSelectedOrder(data);
    } catch (err) {
      console.error('Failed to fetch PO details:', err);
    }
  }, []);

  // Search products
  const searchProducts = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/products?search=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      // Extract variants from products
      const variants: ProductVariant[] = [];
      data.products?.forEach((p: any) => {
        p.variants?.forEach((v: any) => {
          variants.push({
            id: v.id,
            sku: v.sku,
            name: v.variant_name,
            product_id: p.id,
            product_name: p.name,
            size_label: v.size_label,
            color_label: v.color_label,
            price: v.price,
            cost: v.cost,
          });
        });
      });
      setSearchResults(variants);
    } catch (err) {
      console.error('Search error:', err);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    fetchSuppliers();
  }, [fetchOrders, fetchSuppliers]);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      if (showCreateModal && searchQuery) {
        searchProducts(searchQuery);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, showCreateModal, searchProducts]);

  const handleAddLineItem = () => {
    if (!selectedVariant || !lineQty || !lineUnitCost) return;
    const qty = parseInt(lineQty, 10);
    const cost = parseFloat(lineUnitCost);
    if (isNaN(qty) || isNaN(cost) || qty <= 0 || cost < 0) return;

    const newLine: LineItemInput = {
      product_variant_id: selectedVariant.id,
      variant_name: selectedVariant.name,
      sku: selectedVariant.sku,
      product_name: selectedVariant.product_name,
      quantity_ordered: qty,
      unit_cost: cost,
      temp_id: Math.random().toString(36).substring(7),
    };

    setCreateForm({
      ...createForm,
      lines: [...createForm.lines, newLine],
    });

    setSelectedVariant(null);
    setLineQty('');
    setLineUnitCost('');
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleRemoveLine = (tempId: string) => {
    setCreateForm({
      ...createForm,
      lines: createForm.lines.filter((l) => l.temp_id !== tempId),
    });
  };

  const handleCreatePO = async () => {
    if (!createForm.supplier_id || createForm.lines.length === 0) {
      setError('Please select a supplier and add at least one line item');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: createForm.supplier_id,
          notes: createForm.notes || null,
          expected_at: createForm.expected_at || null,
          lines: createForm.lines.map(({ temp_id, ...rest }) => rest),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create PO');
      }

      // Reset form
      setCreateForm({
        supplier_id: '',
        notes: '',
        expected_at: '',
        lines: [],
      });
      setShowCreateModal(false);
      await fetchOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateStatus = async (poId: string, newStatus: string) => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: poId, status: newStatus }),
      });

      if (!res.ok) throw new Error('Failed to update PO');
      
      await fetchOrders();
      if (selectedOrder?.id === poId) {
        await fetchPODetails(poId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUpdating(false);
    }
  };

  const filteredOrders = orders.filter(
    (o) => statusFilter === 'all' || o.status === statusFilter
  );

  return (
    <div style={{ backgroundColor: 'var(--surface-default)' }} className="min-h-screen">
        <AdminTopNav />
      {/* Header */}
      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
                Purchase Orders
              </h1>
              <p style={{ color: 'var(--text-secondary)' }} className="mt-1">
                Manage supplier purchase orders and receiving
              </p>
            </div>
            <button
              onClick={() => {
                setShowCreateModal(true);
                setError(null);
              }}
              style={{ backgroundColor: '#14b8a6', color: 'white' }}
              className="rounded px-6 py-3 font-medium transition hover:opacity-90"
            >
              Create PO
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Error */}
        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
        )}

        {/* Summary Cards */}
        {!selectedOrder && (
          <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
            {[
              { label: 'Draft', count: orders.filter((o) => o.status === 'draft').length, color: '#e5e7eb' },
              { label: 'Pending', count: orders.filter((o) => o.status === 'pending').length, color: '#3b82f6' },
              { label: 'Open', count: orders.filter((o) => o.status === 'partial').length, color: '#f59e0b' },
              { label: 'Received', count: orders.filter((o) => o.status === 'received').length, color: '#10b981' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border p-4"
                style={{
                  backgroundColor: 'var(--surface-panel)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <p style={{ color: 'var(--text-secondary)' }} className="text-sm font-medium">
                  {stat.label}
                </p>
                <p
                  className="mt-2 text-3xl font-bold"
                  style={{
                    color: stat.color === '#e5e7eb' ? '#374151' : 'white',
                    backgroundColor: stat.color,
                    padding: '8px 12px',
                    borderRadius: '6px',
                    display: 'inline-block',
                  }}
                >
                  {stat.count}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* List Panel */}
          <div
            className="rounded-lg border p-6 lg:col-span-2"
            style={{
              backgroundColor: 'var(--surface-panel)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="mb-4 flex items-center gap-2">
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                All Purchase Orders
              </h2>
              {loading && (
                <span style={{ color: 'var(--text-secondary)' }} className="text-sm">
                  Loading...
                </span>
              )}
            </div>

            {/* Filters */}
            <div className="mb-4 flex flex-wrap gap-2">
              {(['all', 'draft', 'pending', 'partial', 'received'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  style={{
                    backgroundColor: statusFilter === status ? '#14b8a6' : 'var(--surface-default)',
                    color: statusFilter === status ? 'white' : 'var(--text-primary)',
                    borderColor: statusFilter === status ? '#14b8a6' : 'var(--border-default)',
                  }}
                  className="rounded border px-3 py-1 text-sm font-medium transition"
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </button>
              ))}
            </div>

            {/* Orders List */}
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {filteredOrders.map((po) => (
                <button
                  key={po.id}
                  onClick={() => fetchPODetails(po.id)}
                  style={{
                    backgroundColor: selectedOrder?.id === po.id ? '#d1fae5' : 'var(--surface-default)',
                    borderColor: 'var(--border-default)',
                  }}
                  className="w-full rounded border p-4 text-left transition hover:opacity-80"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <p className="font-bold" style={{ color: 'var(--text-primary)' }}>
                        {po.po_number}
                      </p>
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {po.supplier_name}
                      </p>
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {po.line_count} lines • {po.total_units_ordered} units •{' '}
                        <span className="font-medium">${po.total_cost.toFixed(2)}</span>
                      </p>
                    </div>
                    <div
                      className="rounded px-2 py-1 text-xs font-medium"
                      style={{
                        backgroundColor: statusBadgeColor(po.status),
                        color: statusTextColor(po.status),
                      }}
                    >
                      {po.status}
                    </div>
                  </div>
                </button>
              ))}
              {filteredOrders.length === 0 && (
                <p style={{ color: 'var(--text-secondary)' }} className="text-sm">
                  No purchase orders found
                </p>
              )}
            </div>
          </div>

          {/* Detail Panel */}
          <div
            className="rounded-lg border p-6"
            style={{
              backgroundColor: 'var(--surface-panel)',
              borderColor: 'var(--border-subtle)',
              maxHeight: '700px',
              overflowY: 'auto',
            }}
          >
            {selectedOrder ? (
              <div className="space-y-4">
                <div>
                  <button
                    onClick={() => setSelectedOrder(null)}
                    className="text-sm font-medium transition"
                    style={{ color: '#14b8a6' }}
                  >
                    ← Back to list
                  </button>
                </div>

                {/* PO Header */}
                <div className="border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
                  <p className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
                    {selectedOrder.po_number}
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {selectedOrder.supplier_name}
                  </p>
                  <div
                    className="mt-2 inline-block rounded px-2 py-1 text-xs font-medium"
                    style={{
                      backgroundColor: statusBadgeColor(selectedOrder.status),
                      color: statusTextColor(selectedOrder.status),
                    }}
                  >
                    {selectedOrder.status}
                  </div>
                </div>

                {/* Dates */}
                <div className="text-sm">
                  <p style={{ color: 'var(--text-secondary)' }} className="font-medium">
                    Created
                  </p>
                  <p style={{ color: 'var(--text-primary)' }}>
                    {new Date(selectedOrder.created_at).toLocaleDateString()}
                  </p>
                  {selectedOrder.expected_at && (
                    <>
                      <p style={{ color: 'var(--text-secondary)' }} className="mt-2 font-medium">
                        Expected
                      </p>
                      <p style={{ color: 'var(--text-primary)' }}>
                        {new Date(selectedOrder.expected_at).toLocaleDateString()}
                      </p>
                    </>
                  )}
                  {selectedOrder.ordered_at && (
                    <>
                      <p style={{ color: 'var(--text-secondary)' }} className="mt-2 font-medium">
                        Ordered
                      </p>
                      <p style={{ color: 'var(--text-primary)' }}>
                        {new Date(selectedOrder.ordered_at).toLocaleDateString()}
                      </p>
                    </>
                  )}
                </div>

                {/* Summary */}
                <div
                  className="rounded border p-3"
                  style={{
                    backgroundColor: 'var(--surface-default)',
                    borderColor: 'var(--border-default)',
                  }}
                >
                  <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {selectedOrder.total_units_ordered} ordered / {selectedOrder.total_units_received} received
                  </p>
                  <p className="mt-1 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    ${selectedOrder.total_cost.toFixed(2)}
                  </p>
                </div>

                {/* Lines */}
                <div>
                  <p className="mb-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                    Items ({selectedOrder.lines.length})
                  </p>
                  <div className="space-y-2">
                    {selectedOrder.lines.map((line) => (
                      <div
                        key={line.id}
                        className="rounded border p-2 text-xs"
                        style={{
                          backgroundColor: 'var(--surface-default)',
                          borderColor: 'var(--border-default)',
                        }}
                      >
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {line.sku}
                        </p>
                        <p style={{ color: 'var(--text-secondary)' }}>{line.product_name}</p>
                        <p style={{ color: 'var(--text-secondary)' }} className="mt-1">
                          {line.quantity_ordered} ordered, {line.quantity_received} received
                        </p>
                        <p style={{ color: 'var(--text-secondary)' }}>
                          ${(line.unit_cost * line.quantity_ordered).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                {selectedOrder.status === 'draft' && (
                  <button
                    onClick={() => handleUpdateStatus(selectedOrder.id, 'pending')}
                    disabled={updating}
                    style={{
                      backgroundColor: updating ? '#d1d5db' : '#14b8a6',
                      color: 'white',
                    }}
                    className="w-full rounded px-4 py-2 font-medium transition disabled:cursor-not-allowed"
                  >
                    {updating ? 'Submitting...' : 'Submit PO'}
                  </button>
                )}

                {(selectedOrder.status === 'pending' || selectedOrder.status === 'partial') && (
                  <button
                    onClick={() => handleUpdateStatus(selectedOrder.id, 'cancelled')}
                    disabled={updating}
                    style={{
                      backgroundColor: updating ? '#d1d5db' : '#ef4444',
                      color: 'white',
                    }}
                    className="w-full rounded px-4 py-2 font-medium transition disabled:cursor-not-allowed"
                  >
                    Cancel PO
                  </button>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--text-secondary)' }} className="text-sm">
                Select a purchase order to view details
              </p>
            )}
          </div>
        </div>

        {/* Create PO Modal */}
        {showCreateModal && (
          <div
            className="fixed inset-0 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 50 }}
          >
            <div
              className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border p-6"
              style={{
                backgroundColor: 'var(--surface-panel)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <h2 className="mb-4 text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                Create Purchase Order
              </h2>

              <div className="space-y-4">
                {/* Supplier Selection */}
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Supplier
                  </label>
                  <select
                    value={createForm.supplier_id}
                    onChange={(e) => setCreateForm({ ...createForm, supplier_id: e.target.value })}
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="mt-1 w-full rounded border px-3 py-2"
                  >
                    <option value="">Select a supplier...</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.contact_name ? `(${s.contact_name})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Notes */}
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Notes (optional)
                  </label>
                  <textarea
                    value={createForm.notes}
                    onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                    placeholder="Special instructions, delivery notes, etc."
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="mt-1 w-full rounded border px-3 py-2"
                    rows={3}
                  />
                </div>

                {/* Expected Date */}
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Expected Delivery Date
                  </label>
                  <input
                    type="date"
                    value={createForm.expected_at}
                    onChange={(e) => setCreateForm({ ...createForm, expected_at: e.target.value })}
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="mt-1 w-full rounded border px-3 py-2"
                  />
                </div>

                {/* Add Line Items */}
                <div
                  className="rounded border p-4"
                  style={{
                    backgroundColor: 'var(--surface-default)',
                    borderColor: 'var(--border-default)',
                  }}
                >
                  <p className="mb-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                    Add Line Items
                  </p>

                  {/* Search */}
                  <div className="mb-3">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by SKU or product name"
                      style={{
                        backgroundColor: 'var(--surface-panel)',
                        borderColor: 'var(--border-default)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full rounded border px-3 py-2 text-sm"
                    />
                    {searchLoading && (
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Searching...
                      </p>
                    )}
                    {searchResults.length > 0 && (
                      <div
                        className="mt-2 max-h-40 overflow-y-auto rounded border"
                        style={{
                          backgroundColor: 'var(--surface-panel)',
                          borderColor: 'var(--border-default)',
                        }}
                      >
                        {searchResults.map((v) => (
                          <button
                            key={v.id}
                            onClick={() => {
                              setSelectedVariant(v);
                              setSearchQuery('');
                              setSearchResults([]);
                            }}
                            className="w-full border-b px-3 py-2 text-left text-xs transition hover:opacity-70"
                            style={{
                              backgroundColor:
                                selectedVariant?.id === v.id ? '#d1fae5' : 'var(--surface-panel)',
                              color: 'var(--text-primary)',
                              borderColor: 'var(--border-subtle)',
                            }}
                          >
                            <div className="font-medium">{v.sku}</div>
                            <div style={{ color: 'var(--text-secondary)' }}>
                              {v.product_name}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Selected Variant */}
                  {selectedVariant && (
                    <div
                      className="mb-3 rounded border-l-4 p-2 text-xs"
                      style={{
                        backgroundColor: '#d1fae5',
                        borderColor: '#14b8a6',
                      }}
                    >
                      <p className="font-medium" style={{ color: '#047857' }}>
                        {selectedVariant.sku}
                      </p>
                      <p style={{ color: '#065f46' }}>{selectedVariant.product_name}</p>
                    </div>
                  )}

                  {/* Quantity & Cost */}
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        Quantity
                      </label>
                      <input
                        type="number"
                        value={lineQty}
                        onChange={(e) => setLineQty(e.target.value)}
                        placeholder="0"
                        min="1"
                        style={{
                          backgroundColor: 'var(--surface-panel)',
                          borderColor: 'var(--border-default)',
                          color: 'var(--text-primary)',
                        }}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        Unit Cost
                      </label>
                      <input
                        type="number"
                        value={lineUnitCost}
                        onChange={(e) => setLineUnitCost(e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        min="0"
                        style={{
                          backgroundColor: 'var(--surface-panel)',
                          borderColor: 'var(--border-default)',
                          color: 'var(--text-primary)',
                        }}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                      />
                    </div>
                  </div>

                  <button
                    onClick={handleAddLineItem}
                    disabled={!selectedVariant || !lineQty || !lineUnitCost}
                    style={{
                      backgroundColor:
                        !selectedVariant || !lineQty || !lineUnitCost ? '#d1d5db' : '#14b8a6',
                      color: 'white',
                    }}
                    className="w-full rounded px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed"
                  >
                    Add Line Item
                  </button>
                </div>

                {/* Line Items List */}
                {createForm.lines.length > 0 && (
                  <div>
                    <p className="mb-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                      Items ({createForm.lines.length})
                    </p>
                    <div className="space-y-2">
                      {createForm.lines.map((line) => (
                        <div
                          key={line.temp_id}
                          className="flex items-center justify-between rounded border p-2"
                          style={{
                            backgroundColor: 'var(--surface-default)',
                            borderColor: 'var(--border-default)',
                          }}
                        >
                          <div className="text-xs">
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {line.sku}
                            </p>
                            <p style={{ color: 'var(--text-secondary)' }}>
                              {line.quantity_ordered} @ ${line.unit_cost.toFixed(2)} each
                            </p>
                          </div>
                          <button
                            onClick={() => handleRemoveLine(line.temp_id)}
                            className="text-xs font-medium transition"
                            style={{ color: '#ef4444' }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Modal Actions */}
                <div className="flex gap-3 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
                  <button
                    onClick={() => {
                      setShowCreateModal(false);
                      setCreateForm({
                        supplier_id: '',
                        notes: '',
                        expected_at: '',
                        lines: [],
                      });
                      setSelectedVariant(null);
                      setLineQty('');
                      setLineUnitCost('');
                      setSearchQuery('');
                      setError(null);
                    }}
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 rounded border px-4 py-2 font-medium transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreatePO}
                    disabled={creating}
                    style={{
                      backgroundColor: creating ? '#d1d5db' : '#14b8a6',
                      color: 'white',
                    }}
                    className="flex-1 rounded px-4 py-2 font-medium transition disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creating...' : 'Create PO'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
