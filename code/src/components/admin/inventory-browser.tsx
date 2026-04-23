'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { formatCurrency } from "@/lib/format";

interface InventoryRow {
  inventory_id: string;
  on_hand: number;
  reserved: number;
  reorder_point: number;
  location_id: string;
  variant_id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  variant_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  cost: number | null;
  variant_active: boolean;
  product_name: string;
  image_url: string | null;
  product_active: boolean;
  category_id: string | null;
  category_name: string | null;
  location_name: string;
  received_at: string | null;
  days_on_shelf: number | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface MatrixData {
  product: Record<string, unknown>;
  variants: Array<Record<string, unknown>>;
  sizes: string[];
  colors: string[];
  matrix: Record<string, Record<string, unknown>>;
}

interface Category {
  id: string;
  name: string;
}

type StockStatus = 'all' | 'in_stock' | 'low_stock' | 'out_of_stock';
type AgingFilter = 'all' | '30' | '60' | '90' | '120' | '180';
type SortField = 'product_name' | 'variant_name' | 'sku' | 'price' | 'on_hand' | 'category' | 'days_on_shelf';

export function InventoryBrowser({ categories }: { categories: Category[] }) {
  const [items, setItems] = useState<InventoryRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stockStatus, setStockStatus] = useState<StockStatus>('all');
  const [agingFilter, setAgingFilter] = useState<AgingFilter>('all');
  const [sortField, setSortField] = useState<SortField>('product_name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [pageSize, setPageSize] = useState(50);

  // Matrix view
  const [matrixProductId, setMatrixProductId] = useState<string | null>(null);
  const [matrixData, setMatrixData] = useState<MatrixData | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // R76-FE-M: AbortController ref so rapid filter/sort/pageSize
  // changes don't race — older fetches resolve after newer ones
  // and overwrite the visible result. Mirror customer-database.tsx
  // R34-D11 pattern.
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Debounce search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search]);

  const fetchInventory = useCallback(async (page: number) => {
    // R76-FE-M: abort any prior in-flight fetch so newer queries win.
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (categoryFilter) params.set('category', categoryFilter);
      // API uses 'stock' param, component uses 'stockStatus' — translate
      if (stockStatus !== 'all') params.set('stock', stockStatus);

      const res = await fetch(`/api/inventory?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      if (controller.signal.aborted) return;

      // API returns { products: [{ variants: [{ variant_id, quantity, ... }] }] }.
      // There is no `variant.inventory` nested object — the on-hand value is
      // flattened to `variant.quantity`. Reading the wrong shape produced
      // "Out of stock" badges for every row.
      const flatItems: InventoryRow[] = [];
      for (const product of (data.products ?? [])) {
        for (const variant of (product.variants ?? [])) {
          flatItems.push({
            product_id: product.id,
            product_name: product.name,
            category_name: product.category?.name ?? product.category_name ?? '',
            // The API's identifier field is `variant_id` (not `id`)
            variant_id: variant.variant_id ?? variant.id,
            variant_name: variant.variant_name ?? variant.name ?? '',
            sku: variant.sku ?? '',
            size_label: variant.size_label ?? '',
            color_label: variant.color_label ?? '',
            price: Number(variant.price ?? 0),
            cost: variant.cost != null ? Number(variant.cost) : null,
            barcode: variant.barcode ?? null,
            on_hand: Number(variant.quantity ?? 0),
            reserved: Number(variant.reserved ?? 0),
            reorder_point: Number(variant.reorder_point ?? 0),
            location_name: variant.location_name ?? '',
            days_on_shelf: Number(variant.days_on_shelf ?? 0),
          } as InventoryRow);
        }
      }

      // Client-side sort & paginate
      const sorted = [...flatItems].sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[sortField] ?? '';
        const bv = (b as unknown as Record<string, unknown>)[sortField] ?? '';
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortOrder === 'asc' ? av - bv : bv - av;
        }
        return sortOrder === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      });

      const total = sorted.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const pageItems = sorted.slice((page - 1) * pageSize, page * pageSize);

      setItems(pageItems);
      setPagination({ page, pageSize, total, totalPages });
    } catch (e) {
      // Ignore AbortError — a newer fetch superseded us.
      if ((e as { name?: string })?.name === 'AbortError') return;
      setError('Failed to load inventory');
    } finally {
      // Only the winning request clears the spinner — aborted
      // requests leave setLoading alone (the newer one owns it).
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [debouncedSearch, categoryFilter, stockStatus, sortField, sortOrder, pageSize]);

  useEffect(() => {
    fetchInventory(1);
    // R77-FE-M: abort in-flight fetch on unmount so a pending
    // response doesn't call setState on torn-down component.
    return () => {
      fetchAbortRef.current?.abort();
    };
  }, [fetchInventory]);

  const handlePageChange = (newPage: number) => {
    fetchInventory(newPage);
  };

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  // Build the matrix locally from the inventory rows we already loaded —
  // the /api/inventory route does not honor `productId` and does not return
  // a {product, sizes, colors, matrix, variants} shape, so deriving in the
  // client is simpler and correct.
  const openMatrix = async (productId: string) => {
    setMatrixProductId(productId);
    setMatrixLoading(true);
    try {
      const productRows = items.filter((i) => i.product_id === productId);
      if (productRows.length === 0) {
        setMatrixData(null);
        return;
      }
      const sizes = Array.from(new Set(productRows.map((r) => r.size_label).filter((s): s is string => !!s)));
      const colors = Array.from(new Set(productRows.map((r) => r.color_label).filter((c): c is string => !!c)));
      const matrix: Record<string, Record<string, unknown>> = {};
      for (const r of productRows) {
        if (r.size_label && r.color_label) {
          matrix[`${r.size_label}|${r.color_label}`] = {
            sku: r.sku,
            on_hand: r.on_hand,
            reorder_point: r.reorder_point,
            price: r.price,
            days_on_shelf: r.days_on_shelf,
          };
        }
      }
      const variants = productRows.map((r) => ({
        variant_id: r.variant_id,
        sku: r.sku,
        variant_name: r.variant_name,
        size_label: r.size_label,
        color_label: r.color_label,
        on_hand: r.on_hand,
        reorder_point: r.reorder_point,
        price: r.price,
      }));
      setMatrixData({
        product: { id: productId, name: productRows[0].product_name },
        sizes, colors, matrix, variants,
      } as unknown as typeof matrixData);
    } catch {
      setMatrixData(null);
    } finally {
      setMatrixLoading(false);
    }
  };

  const closeMatrix = () => {
    setMatrixProductId(null);
    setMatrixData(null);
  };

  // Group items by product for the list view
  const _productGroups = items.reduce<Record<string, InventoryRow[]>>((acc, item) => {
    if (!acc[item.product_id]) acc[item.product_id] = [];
    acc[item.product_id].push(item);
    return acc;
  }, {});

  const sortIcon = (field: SortField) => {
    if (field !== sortField) return '↕';
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  const stockBadge = (onHand: number, reorderPoint: number) => {
    if (onHand === 0) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">Out</span>;
    if (onHand <= reorderPoint) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700">Low</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">{onHand}</span>;
  };

  const agingBadge = (days: number | null) => {
    if (days === null || days === undefined) return <span className="text-xs text-zinc-400">—</span>;
    if (days >= 180) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">{days}d</span>;
    if (days >= 90) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">{days}d</span>;
    if (days >= 60) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700">{days}d</span>;
    if (days >= 30) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-700">{days}d</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">{days}d</span>;
  };

  return (
    <div className="space-y-4">
      {/* Search & Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" strokeWidth="2" />
            <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products, SKUs, barcodes..."
            className="w-full rounded-lg border border-zinc-300 bg-white pl-10 pr-4 py-2.5 text-sm text-zinc-800 placeholder-zinc-400"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">✕</button>
          )}
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700"
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={stockStatus}
          onChange={(e) => setStockStatus(e.target.value as StockStatus)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700"
        >
          <option value="all">All Stock</option>
          <option value="in_stock">In Stock</option>
          <option value="low_stock">Low Stock</option>
          <option value="out_of_stock">Out of Stock</option>
        </select>
        <select
          value={agingFilter}
          onChange={(e) => setAgingFilter(e.target.value as AgingFilter)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700"
        >
          <option value="all">All Ages</option>
          <option value="30">30+ days</option>
          <option value="60">60+ days</option>
          <option value="90">90+ days</option>
          <option value="120">120+ days</option>
          <option value="180">180+ days</option>
        </select>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700"
        >
          <option value={25}>25 / page</option>
          <option value={50}>50 / page</option>
          <option value={100}>100 / page</option>
          <option value={200}>200 / page</option>
        </select>
      </div>

      {/* Results summary */}
      <div className="flex items-center justify-between text-sm text-zinc-600">
        <span>
          {loading ? 'Loading...' : `${pagination.total.toLocaleString()} items found`}
          {debouncedSearch && ` for "${debouncedSearch}"`}
        </span>
        {pagination.totalPages > 1 && (
          <span>Page {pagination.page} of {pagination.totalPages}</span>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Matrix View Overlay */}
      {matrixProductId && (
        <div className="rounded-2xl bg-white border-2 border-teal-300 p-5 shadow-md">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-zinc-900">
              {matrixData ? String(matrixData.product?.name || 'Product') : 'Loading...'}
              <span className="ml-2 text-sm font-normal text-zinc-500">Size × Color Matrix</span>
            </h3>
            <button onClick={closeMatrix} className="touch-button text-zinc-500 hover:text-zinc-800 font-bold text-lg">✕</button>
          </div>

          {matrixLoading ? (
            <div className="text-center py-8 text-zinc-400">Loading matrix...</div>
          ) : matrixData && matrixData.sizes.length > 0 && matrixData.colors.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50">
                    <th className="text-left px-3 py-2 font-semibold text-zinc-700 border border-zinc-200">Size ↓ / Color →</th>
                    {matrixData.colors.map((color) => (
                      <th key={color} className="text-center px-3 py-2 font-semibold text-zinc-700 border border-zinc-200 min-w-[100px]">
                        {color}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixData.sizes.map((size) => (
                    <tr key={size} className="hover:bg-zinc-50/50">
                      <td className="px-3 py-2 font-semibold text-zinc-800 border border-zinc-200 bg-zinc-50">{size}</td>
                      {matrixData.colors.map((color) => {
                        const key = `${size}|${color}`;
                        const variant = matrixData.matrix[key] as Record<string, unknown> | undefined;
                        if (!variant) {
                          return (
                            <td key={color} className="px-3 py-2 text-center border border-zinc-200 text-zinc-300">
                              —
                            </td>
                          );
                        }
                        const onHand = Number(variant.on_hand ?? 0);
                        const reorder = Number(variant.reorder_point ?? 0);
                        const price = Number(variant.price ?? 0);
                        const daysOnShelf = variant.days_on_shelf != null ? Number(variant.days_on_shelf) : null;
                        const isLow = onHand > 0 && onHand <= reorder;
                        const isOut = onHand === 0;
                        const isAging = daysOnShelf !== null && daysOnShelf >= 90;

                        return (
                          <td
                            key={color}
                            className={`px-3 py-2 text-center border border-zinc-200 ${isOut ? 'bg-red-50' : isLow ? 'bg-amber-50' : isAging ? 'bg-orange-50/50' : ''}`}
                          >
                            <div className={`text-lg font-bold ${isOut ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-zinc-900'}`}>
                              {onHand}
                            </div>
                            <div className="text-[10px] text-zinc-500">{String(variant.sku)}</div>
                            <div className="text-xs text-zinc-600">{formatCurrency(price)}</div>
                            {daysOnShelf !== null && (
                              <div className={`text-[10px] mt-0.5 font-medium ${daysOnShelf >= 180 ? 'text-red-600' : daysOnShelf >= 90 ? 'text-orange-600' : daysOnShelf >= 60 ? 'text-amber-600' : 'text-zinc-400'}`}>
                                {daysOnShelf}d
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Matrix summary */}
              <div className="mt-3 flex gap-4 text-xs text-zinc-500">
                <span>{matrixData.sizes.length} sizes × {matrixData.colors.length} colors = {matrixData.variants.length} variants</span>
                <span>Total on hand: {matrixData.variants.reduce((sum, v) => sum + Number((v as Record<string, unknown>).on_hand ?? 0), 0)}</span>
              </div>
            </div>
          ) : matrixData && matrixData.variants.length > 0 ? (
            /* Variants exist but no size/color labels — show flat list */
            <div className="space-y-2">
              <p className="text-xs text-zinc-500 mb-2">This product does not have size/color labels. Showing variant list instead.</p>
              {matrixData.variants.map((v) => {
                const variant = v as Record<string, unknown>;
                const onHand = Number(variant.on_hand ?? 0);
                const reorder = Number(variant.reorder_point ?? 0);
                return (
                  <div key={String(variant.id)} className="flex items-center justify-between p-2 rounded-lg border border-zinc-200">
                    <div>
                      <span className="font-medium text-zinc-900">{String(variant.name)}</span>
                      <span className="ml-2 text-xs text-zinc-500">{String(variant.sku)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-zinc-600">{formatCurrency(Number(variant.price))}</span>
                      {stockBadge(onHand, reorder)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-zinc-400">No variants found</div>
          )}
        </div>
      )}

      {/* Inventory Table */}
      <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                <th
                  className="text-left px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('product_name')}
                >
                  Product {sortIcon('product_name')}
                </th>
                <th
                  className="text-left px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('variant_name')}
                >
                  Variant {sortIcon('variant_name')}
                </th>
                <th
                  className="text-left px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('sku')}
                >
                  SKU {sortIcon('sku')}
                </th>
                <th
                  className="text-left px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('category')}
                >
                  Category {sortIcon('category')}
                </th>
                <th
                  className="text-right px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('price')}
                >
                  Price {sortIcon('price')}
                </th>
                <th className="text-right px-3 py-3 font-semibold text-zinc-700">Cost</th>
                <th
                  className="text-center px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('on_hand')}
                >
                  Stock {sortIcon('on_hand')}
                </th>
                <th className="text-center px-3 py-3 font-semibold text-zinc-700">Location</th>
                <th
                  className="text-center px-3 py-3 font-semibold text-zinc-700 cursor-pointer hover:bg-zinc-100"
                  onClick={() => handleSort('days_on_shelf')}
                >
                  Age {sortIcon('days_on_shelf')}
                </th>
                <th className="px-3 py-3 font-semibold text-zinc-700 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-zinc-400">Loading inventory...</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-zinc-400">
                    {debouncedSearch ? `No results for "${debouncedSearch}"` : 'No inventory items found'}
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const isLow = item.on_hand > 0 && item.on_hand <= item.reorder_point;
                  const isOut = item.on_hand === 0;

                  return (
                    <tr
                      key={item.inventory_id}
                      className={`border-b border-zinc-100 hover:bg-zinc-50/50 ${isOut ? 'bg-red-50/30' : isLow ? 'bg-amber-50/30' : ''}`}
                    >
                      <td className="px-3 py-2.5">
                        <span className="font-medium text-zinc-900">{item.product_name}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="text-zinc-800">{item.variant_name}</div>
                        {(item.size_label || item.color_label) && (
                          <div className="flex gap-1 mt-0.5">
                            {item.size_label && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{item.size_label}</span>}
                            {item.color_label && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{item.color_label}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600 font-mono text-xs">{item.sku}</td>
                      <td className="px-3 py-2.5 text-zinc-600">{item.category_name || '—'}</td>
                      <td className="px-3 py-2.5 text-right text-zinc-900 font-medium">{formatCurrency(Number(item.price))}</td>
                      <td className="px-3 py-2.5 text-right text-zinc-500">
                        {item.cost ? formatCurrency(Number(item.cost)) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center">{stockBadge(item.on_hand, item.reorder_point)}</td>
                      <td className="px-3 py-2.5 text-center text-xs text-zinc-500">{item.location_name}</td>
                      <td className="px-3 py-2.5 text-center">{agingBadge(item.days_on_shelf)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => openMatrix(item.product_id)}
                          className="touch-button px-2 py-1 rounded-lg text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-700"
                          title="View size/color matrix"
                        >
                          Matrix
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => handlePageChange(pagination.page - 1)}
            disabled={pagination.page <= 1}
            className="touch-button px-4 py-2 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
          >
            ← Previous
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(7, pagination.totalPages) }, (_, i) => {
              let pageNum: number;
              if (pagination.totalPages <= 7) {
                pageNum = i + 1;
              } else if (pagination.page <= 4) {
                pageNum = i + 1;
              } else if (pagination.page >= pagination.totalPages - 3) {
                pageNum = pagination.totalPages - 6 + i;
              } else {
                pageNum = pagination.page - 3 + i;
              }
              return (
                <button
                  key={pageNum}
                  onClick={() => handlePageChange(pageNum)}
                  className={`touch-button h-8 w-8 rounded-lg text-sm font-medium ${
                    pageNum === pagination.page
                      ? 'bg-teal-700 text-white'
                      : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => handlePageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages}
            className="touch-button px-4 py-2 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
