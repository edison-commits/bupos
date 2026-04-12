'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { SUCCESS_TOAST_MS } from '@/lib/config/timing';

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
  on_hand: number;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_name: string;
  status: string;
  total_units_ordered: number;
  total_units_received: number;
  line_count: number;
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

interface ReceivingItem {
  variant_id: string;
  sku: string;
  product_name: string;
  variant_name: string;
  quantity: number;
  po_line_id?: string;
  expected_quantity?: number;
}

export default function ReceivingPage() {
  const [mode, setMode] = useState<'quick' | 'po'>('quick');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProductVariant[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [poDetails, setPoDetails] = useState<PurchaseOrderLine[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [posLoading, setPosLoading] = useState(false);

  // Receiving batch state
  const [receivingItems, setReceivingItems] = useState<ReceivingItem[]>([]);
  const [quantity, setQuantity] = useState('');
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);

  // Review & submit state
  const [_showReview, _setShowReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Fetch open purchase orders
  const fetchPurchaseOrders = useCallback(async () => {
    if (mode !== 'po') return;
    setPosLoading(true);
    try {
      const response = await authFetch('/api/receiving?type=open_pos');
      if (!response.ok) throw new Error('Failed to fetch purchase orders');
      const json = await response.json();
      setPurchaseOrders(json.orders || []);
    } catch (err) {
      console.error(err);
    } finally {
      setPosLoading(false);
    }
  }, [mode]);

  // Fetch PO details
  const fetchPODetails = useCallback(async (poId: string) => {
    try {
      const response = await authFetch(`/api/receiving?type=po_details&id=${poId}`);
      if (!response.ok) throw new Error('Failed to fetch PO details');
      const json = await response.json();
      setPoDetails(json.lines || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  // Search products for quick receive
  const searchProducts = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const response = await authFetch(`/api/receiving?type=search&q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Search failed');
      const json = await response.json();
      setSearchResults(json.variants || []);
    } catch (err) {
      console.error(err);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (mode === 'quick' && searchQuery) {
        searchProducts(searchQuery);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, mode, searchProducts]);

  useEffect(() => {
    if (mode === 'po') {
      fetchPurchaseOrders();
    }
  }, [mode, fetchPurchaseOrders]);

  // Add item to receiving batch
  const handleAddItem = () => {
    if (!selectedVariant || !quantity) return;
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0) return;

    const newItem: ReceivingItem = {
      variant_id: selectedVariant.id,
      sku: selectedVariant.sku,
      product_name: selectedVariant.product_name,
      variant_name: selectedVariant.name,
      quantity: qty,
    };

    setReceivingItems([...receivingItems, newItem]);
    setSelectedVariant(null);
    setSearchQuery('');
    setQuantity('');
    setSearchResults([]);
  };

  // Add PO line to batch
  const handleAddPOItem = (line: PurchaseOrderLine, receivedQty: string) => {
    const qty = parseInt(receivedQty, 10);
    if (isNaN(qty) || qty <= 0) return;

    const existing = receivingItems.find(
      (item) => item.variant_id === line.product_variant_id
    );
    if (existing) {
      // Update quantity for PO items
      const updated = receivingItems.map((item) =>
        item.variant_id === line.product_variant_id
          ? {
              ...item,
              quantity: qty,
              po_line_id: line.id,
              expected_quantity: line.quantity_ordered,
            }
          : item
      );
      setReceivingItems(updated);
    } else {
      const newItem: ReceivingItem = {
        variant_id: line.product_variant_id,
        sku: line.sku,
        product_name: line.product_name,
        variant_name: line.variant_name,
        quantity: qty,
        po_line_id: line.id,
        expected_quantity: line.quantity_ordered,
      };
      setReceivingItems([...receivingItems, newItem]);
    }
  };

  // Remove item from batch
  const handleRemoveItem = (variantId: string) => {
    setReceivingItems(receivingItems.filter((item) => item.variant_id !== variantId));
  };

  // Submit receiving
  const handleSubmit = async () => {
    if (receivingItems.length === 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await authFetch('/api/receiving', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: receivingItems,
          mode,
          po_id: selectedPO?.id,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to process receiving');
      }

      setSubmitSuccess(true);
      setReceivingItems([]);
      setSelectedPO(null);
      setMode('quick');
      setTimeout(() => setSubmitSuccess(false), SUCCESS_TOAST_MS);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--surface-default)' }}>
        <AdminTopNav />
      {/* Header */}
      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="mx-auto max-w-6xl px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
                Inventory Receiving
              </h1>
              <p style={{ color: 'var(--text-secondary)' }} className="mt-1">
                Receive inventory from suppliers
              </p>
            </div>
            <Link
              href="/admin/inventory"
              style={{
                backgroundColor: 'var(--surface-secondary)',
                color: 'var(--text-primary)',
                borderColor: 'var(--border-default)',
              }}
              className="rounded-2xl border-2 px-5 py-4 text-lg font-bold transition hover:opacity-80"
            >
              Back to Inventory
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* Success Message */}
        {submitSuccess && (
          <div
            className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4"
            role="alert"
          >
            <p className="text-sm font-medium text-emerald-800">
              Receiving batch processed successfully!
            </p>
          </div>
        )}

        {/* Mode Selector */}
        <div className="mb-6 flex gap-4">
          <button
            onClick={() => {
              setMode('quick');
              setSelectedPO(null);
              setReceivingItems([]);
            }}
            style={{
              backgroundColor: mode === 'quick' ? '#14b8a6' : 'var(--surface-secondary)',
              color: mode === 'quick' ? 'white' : 'var(--text-primary)',
              borderColor: mode === 'quick' ? '#14b8a6' : 'var(--border-default)',
            }}
            className="rounded border px-6 py-2 font-medium transition"
          >
            Quick Receive
          </button>
          <button
            onClick={() => {
              setMode('po');
              setReceivingItems([]);
              setSearchQuery('');
            }}
            style={{
              backgroundColor: mode === 'po' ? '#14b8a6' : 'var(--surface-secondary)',
              color: mode === 'po' ? 'white' : 'var(--text-primary)',
              borderColor: mode === 'po' ? '#14b8a6' : 'var(--border-default)',
            }}
            className="rounded border px-6 py-2 font-medium transition"
          >
            Receive from PO
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left Panel - Input */}
          <div
            className="rounded-lg border p-6"
            style={{
              backgroundColor: 'var(--surface-panel)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              {mode === 'quick' ? 'Add Items' : 'Select Purchase Order'}
            </h2>

            {mode === 'quick' ? (
              <div className="space-y-4">
                {/* Product Search */}
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Search by SKU or Product Name
                  </label>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="e.g., SKU-123 or Dickies Shirt"
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="mt-1 w-full rounded border px-3 py-2"
                  />
                  {searchLoading && (
                    <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      Searching...
                    </p>
                  )}
                  {searchResults.length > 0 && (
                    <div
                      className="mt-2 max-h-48 overflow-y-auto rounded border"
                      style={{
                        backgroundColor: 'var(--surface-default)',
                        borderColor: 'var(--border-default)',
                      }}
                    >
                      {searchResults.map((variant) => (
                        <button
                          key={variant.id}
                          onClick={() => {
                            setSelectedVariant(variant);
                            setSearchQuery('');
                            setSearchResults([]);
                          }}
                          className="w-full border-b px-3 py-2 text-left text-sm transition hover:opacity-80"
                          style={{
                            backgroundColor:
                              selectedVariant?.id === variant.id
                                ? '#d1fae5'
                                : 'var(--surface-default)',
                            color: 'var(--text-primary)',
                            borderColor: 'var(--border-subtle)',
                          }}
                        >
                          <div className="font-medium">{variant.sku}</div>
                          <div style={{ color: 'var(--text-secondary)' }} className="text-xs">
                            {variant.product_name} - {variant.name}
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }} className="text-xs">
                            On hand: {variant.on_hand}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Selected Product */}
                {selectedVariant && (
                  <div
                    className="rounded border-l-4 p-3"
                    style={{
                      backgroundColor: '#d1fae5',
                      borderColor: '#14b8a6',
                    }}
                  >
                    <p className="text-sm font-medium" style={{ color: '#047857' }}>
                      {selectedVariant.sku}
                    </p>
                    <p className="text-xs" style={{ color: '#065f46' }}>
                      {selectedVariant.product_name}
                    </p>
                  </div>
                )}

                {/* Quantity Input */}
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Quantity Received
                  </label>
                  <input
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="0"
                    min="0"
                    style={{
                      backgroundColor: 'var(--surface-default)',
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    className="mt-1 w-full rounded border px-3 py-2"
                  />
                </div>

                {/* Add Button */}
                <button
                  onClick={handleAddItem}
                  disabled={!selectedVariant || !quantity}
                  style={{
                    backgroundColor:
                      !selectedVariant || !quantity ? '#d1d5db' : '#14b8a6',
                    color: 'white',
                  }}
                  className="w-full rounded px-4 py-2 font-medium transition disabled:cursor-not-allowed"
                >
                  Add to Batch
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* PO Selection */}
                {!selectedPO ? (
                  <div>
                    <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Open Purchase Orders
                    </label>
                    {posLoading ? (
                      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Loading...
                      </p>
                    ) : purchaseOrders.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {purchaseOrders.map((po) => (
                          <button
                            key={po.id}
                            onClick={() => {
                              setSelectedPO(po);
                              fetchPODetails(po.id);
                            }}
                            style={{
                              backgroundColor: 'var(--surface-default)',
                              borderColor: 'var(--border-default)',
                              color: 'var(--text-primary)',
                            }}
                            className="w-full rounded border p-3 text-left text-sm transition hover:opacity-80"
                          >
                            <div className="font-medium">{po.po_number}</div>
                            <div style={{ color: 'var(--text-secondary)' }} className="text-xs">
                              {po.supplier_name} • {po.total_units_ordered} units
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        No open purchase orders
                      </p>
                    )}
                  </div>
                ) : (
                  <div>
                    <button
                      onClick={() => {
                        setSelectedPO(null);
                        setPoDetails([]);
                        setReceivingItems([]);
                      }}
                      className="text-sm font-medium transition"
                      style={{ color: '#14b8a6' }}
                    >
                      ← Change PO
                    </button>
                    <div
                      className="mt-3 rounded border-l-4 p-3"
                      style={{
                        backgroundColor: '#d1fae5',
                        borderColor: '#14b8a6',
                      }}
                    >
                      <p className="font-medium" style={{ color: '#047857' }}>
                        {selectedPO.po_number}
                      </p>
                      <p className="text-xs" style={{ color: '#065f46' }}>
                        {selectedPO.supplier_name}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Middle Panel - PO Items or Batch Preview */}
          <div className="lg:col-span-2">
            {mode === 'po' && selectedPO && poDetails.length > 0 && (
              <div
                className="rounded-lg border p-6"
                style={{
                  backgroundColor: 'var(--surface-panel)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  Expected Items
                </h2>
                <div className="space-y-3">
                  {poDetails.map((line) => {
                    const isReceived = receivingItems.some(
                      (item) => item.variant_id === line.product_variant_id
                    );
                    const receivedQty = receivingItems.find(
                      (item) => item.variant_id === line.product_variant_id
                    )?.quantity || '';

                    return (
                      <div
                        key={line.id}
                        className="rounded border p-3"
                        style={{
                          backgroundColor: 'var(--surface-default)',
                          borderColor: 'var(--border-default)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {line.sku}
                            </p>
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                              {line.product_name} - {line.variant_name}
                            </p>
                            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                              Expected: {line.quantity_ordered} units
                              {line.quantity_received > 0 && (
                                <span className="ml-2 font-medium">
                                  Already received: {line.quantity_received}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="number"
                              value={receivedQty}
                              onChange={(e) => {
                                const newItems = receivingItems.map((item) =>
                                  item.variant_id === line.product_variant_id
                                    ? { ...item, quantity: parseInt(e.target.value) || 0 }
                                    : item
                                );
                                setReceivingItems(newItems);
                              }}
                              placeholder="Qty"
                              min="0"
                              className="w-20 rounded border px-2 py-1 text-sm"
                              style={{
                                backgroundColor: 'var(--surface-panel)',
                                borderColor: 'var(--border-default)',
                                color: 'var(--text-primary)',
                              }}
                            />
                            <button
                              onClick={() =>
                                handleAddPOItem(line, String(receivedQty))
                              }
                              style={{
                                backgroundColor: isReceived ? '#14b8a6' : '#e5e7eb',
                                color: isReceived ? 'white' : '#374151',
                              }}
                              className="rounded px-3 py-1 text-sm font-medium transition"
                            >
                              {isReceived ? '✓ Added' : 'Add'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {mode === 'quick' && (
              <div
                className="rounded-lg border p-6"
                style={{
                  backgroundColor: 'var(--surface-panel)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  Batch Items ({receivingItems.length})
                </h2>
                {receivingItems.length > 0 ? (
                  <div className="space-y-3">
                    {receivingItems.map((item) => (
                      <div
                        key={item.variant_id}
                        className="flex items-center justify-between rounded border p-3"
                        style={{
                          backgroundColor: 'var(--surface-default)',
                          borderColor: 'var(--border-default)',
                        }}
                      >
                        <div>
                          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {item.sku}
                          </p>
                          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {item.product_name}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold" style={{ color: '#14b8a6' }}>
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => handleRemoveItem(item.variant_id)}
                            className="text-sm font-medium transition"
                            style={{ color: '#ef4444' }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: 'var(--text-secondary)' }} className="text-sm">
                    Add items above to create a batch
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Summary & Submit */}
        {receivingItems.length > 0 && (
          <div
            className="mt-6 rounded-lg border p-6"
            style={{
              backgroundColor: 'var(--surface-panel)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              Review & Submit
            </h2>

            {/* Discrepancy Warnings */}
            {mode === 'po' &&
              receivingItems.some((item) => {
                const expected = item.expected_quantity || 0;
                return item.quantity !== expected && expected > 0;
              }) && (
                <div
                  className="mb-4 rounded border border-amber-200 bg-amber-50 p-3"
                  role="alert"
                >
                  <p className="text-sm font-medium text-amber-800">Quantity Discrepancies:</p>
                  {receivingItems
                    .filter((item) => {
                      const expected = item.expected_quantity || 0;
                      return item.quantity !== expected && expected > 0;
                    })
                    .map((item) => (
                      <p key={item.variant_id} className="text-xs text-amber-700">
                        {item.sku}: Expected {item.expected_quantity}, receiving {item.quantity}
                      </p>
                    ))}
                </div>
              )}

            <div className="space-y-2">
              <p style={{ color: 'var(--text-secondary)' }} className="text-sm">
                <span className="font-medium">Total Items:</span> {receivingItems.length}
              </p>
              <p style={{ color: 'var(--text-secondary)' }} className="text-sm">
                <span className="font-medium">Total Units:</span>{' '}
                {receivingItems.reduce((sum, item) => sum + item.quantity, 0)}
              </p>
            </div>

            {submitError && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 p-3">
                <p className="text-sm font-medium text-red-800">{submitError}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                backgroundColor: submitting ? '#d1d5db' : '#14b8a6',
                color: 'white',
              }}
              className="mt-4 w-full rounded px-4 py-3 font-bold transition disabled:cursor-not-allowed"
            >
              {submitting ? 'Processing...' : 'Confirm & Process Receiving'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
