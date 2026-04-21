'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AdminTopNav } from "@/components/layout/admin-top-nav";
import { authFetch } from '@/lib/api/client';
import { formatCurrency } from '@/lib/format';

interface ProductVariant {
  variant_id: string | null;
  sku: string | null;
  size_label: string | null;
  color_label: string | null;
  price: number | null;
  cost: number | null;
  quantity: number;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  categoryId: string | null;
  productBrand: string;
  productType: string;
  variants: ProductVariant[];
}

interface Category {
  id: string;
  name: string;
}

interface InventorySummary {
  totalProducts: number;
  totalVariants: number;
  lowStockCount: number;
  outOfStockCount: number;
}

interface InventoryData {
  products: Product[];
  categories: Category[];
  types: string[];
  brands: string[];
  summary: InventorySummary;
}

export default function InventoryPage() {
  const [data, setData] = useState<InventoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());

  // Fetch inventory data
  const fetchInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (selectedCategory) params.append('category', selectedCategory);
      if (selectedType) params.append('type', selectedType);
      if (selectedBrand) params.append('brand', selectedBrand);
      if (stockFilter !== 'all') params.append('stock', stockFilter);

      const response = await authFetch(`/api/inventory?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch inventory');
      }

      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [search, selectedCategory, selectedType, selectedBrand, stockFilter]);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const toggleProduct = (productId: string) => {
    const newExpanded = new Set(expandedProducts);
    if (newExpanded.has(productId)) {
      newExpanded.delete(productId);
    } else {
      newExpanded.add(productId);
    }
    setExpandedProducts(newExpanded);
  };

  const getStockColor = (quantity: number): string => {
    if (quantity === 0) return 'text-red-600 bg-red-50';
    if (quantity <= 5) return 'text-amber-600 bg-amber-50';
    return 'text-emerald-600 bg-emerald-50';
  };

  const getStockBadgeColor = (quantity: number): string => {
    if (quantity === 0) return 'bg-red-100 text-red-800';
    if (quantity <= 5) return 'bg-amber-100 text-amber-800';
    return 'bg-emerald-100 text-emerald-800';
  };

  if (loading && !data) {
    return <LoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          <p className="font-semibold">Error: {error}</p>
          <button
            onClick={() => fetchInventory()}
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const summary = data?.summary || {
    totalProducts: 0,
    totalVariants: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
  };
  const products = data?.products || [];
  const categories = data?.categories || [];
  const types = data?.types || [];
  const brands = data?.brands || [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Top Navigation */}
      <AdminTopNav />
      <div className="max-w-7xl mx-auto px-8 pt-6 pb-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">
            Inventory Management
          </h1>
          <p className="text-slate-600">
            Track products, variants, and stock levels across locations
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <SummaryCard
            title="Total Products"
            value={summary.totalProducts}
            icon="📦"
            color="bg-teal-50 border-teal-200"
            textColor="text-teal-700"
          />
          <SummaryCard
            title="Total Variants"
            value={summary.totalVariants}
            icon="🎯"
            color="bg-cyan-50 border-cyan-200"
            textColor="text-cyan-700"
          />
          <SummaryCard
            title="Low Stock"
            value={summary.lowStockCount}
            icon="⚠️"
            color="bg-amber-50 border-amber-200"
            textColor="text-amber-700"
          />
          <SummaryCard
            title="Out of Stock"
            value={summary.outOfStockCount}
            icon="❌"
            color="bg-red-50 border-red-200"
            textColor="text-red-700"
          />
        </div>

        {/* Filters and Export */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8 border border-slate-200">
          <div className="space-y-6">
            {/* Search and Filters Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Search
                </label>
                <input
                  type="text"
                  placeholder="Product name or SKU..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Category
                </label>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
                >
                  <option value="">All Categories</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name || cat.id}
                    </option>
                  ))}
                </select>
              </div>

              {/* Type filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Type
                </label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
                >
                  <option value="">All Types</option>
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Brand filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Brand
                </label>
                <select
                  value={selectedBrand}
                  onChange={(e) => setSelectedBrand(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
                >
                  <option value="">All Brands</option>
                  {brands.map((b) => (
                    <option key={b} value={b}>
                      {b.charAt(0).toUpperCase() + b.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stock filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Stock Status
                </label>
                <select
                  value={stockFilter}
                  onChange={(e) =>
                    setStockFilter(e.target.value as 'all' | 'low' | 'out')
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
                >
                  <option value="all">All</option>
                  <option value="low">Low Stock (≤5)</option>
                  <option value="out">Out of Stock</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={() => fetchInventory()}
                  className="w-full px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition font-medium"
                >
                  Refresh
                </button>
              </div>
            </div>

            {/* Export Buttons */}
            <div className="flex gap-3 pt-4 border-t border-slate-200">
              <Link
                href="/api/export?type=inventory"
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium text-sm"
              >
                Export Inventory CSV
              </Link>
              <Link
                href="/api/export?type=products"
                className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition font-medium text-sm"
              >
                Export Products CSV
              </Link>
            </div>
          </div>
        </div>

        {/* Products List */}
        <div className="space-y-4">
          {products.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm p-12 text-center border border-slate-200">
              <p className="text-slate-500 text-lg">No products found</p>
            </div>
          ) : (
            products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                isExpanded={expandedProducts.has(product.id)}
                onToggle={() => toggleProduct(product.id)}
                getStockColor={getStockColor}
                getStockBadgeColor={getStockBadgeColor}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
  color,
  textColor,
}: {
  title: string;
  value: number;
  icon: string;
  color: string;
  textColor: string;
}) {
  return (
    <div
      className={`${color} border rounded-lg p-6 transition hover:shadow-md`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-slate-600 text-sm font-medium">{title}</p>
          <p className={`${textColor} text-3xl font-bold mt-2`}>{value}</p>
        </div>
        <div className="text-4xl opacity-30">{icon}</div>
      </div>
    </div>
  );
}

function ProductCard({
  product,
  isExpanded,
  onToggle,
  getStockColor,
  getStockBadgeColor,
}: {
  product: Product;
  isExpanded: boolean;
  onToggle: () => void;
  getStockColor: (qty: number) => string;
  getStockBadgeColor: (qty: number) => string;
}) {
  const totalStock = product.variants.reduce((sum, v) => sum + v.quantity, 0);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden transition hover:shadow-md">
      <button
        onClick={onToggle}
        className="w-full p-6 flex items-center justify-between hover:bg-slate-50 transition"
      >
        <div className="flex items-center gap-4 flex-1 text-left">
          <div
            className={`flex-shrink-0 text-xl transition transform ${
              isExpanded ? 'rotate-90' : ''
            }`}
          >
            ▶
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-lg">
              {product.name}
            </h3>
            <p className="text-sm text-slate-600">
              {product.productBrand && <span className="font-medium">{product.productBrand}</span>}
              {product.productBrand && product.productType && ' · '}
              {product.productType && <span>{product.productType}</span>}
              {!product.productBrand && !product.productType && product.slug}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-slate-600">
              {product.variants.length} variant
              {product.variants.length !== 1 ? 's' : ''}
            </p>
            <p className={`text-lg font-bold ${getStockColor(totalStock)}`}>
              {totalStock} units
            </p>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-slate-200 p-6 bg-slate-50">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="text-left py-3 px-4 font-semibold text-slate-700">
                    Size
                  </th>
                  <th className="text-left py-3 px-4 font-semibold text-slate-700">
                    Color
                  </th>
                  <th className="text-left py-3 px-4 font-semibold text-slate-700">
                    SKU
                  </th>
                  <th className="text-right py-3 px-4 font-semibold text-slate-700">
                    Price
                  </th>
                  <th className="text-right py-3 px-4 font-semibold text-slate-700">
                    Cost
                  </th>
                  <th className="text-right py-3 px-4 font-semibold text-slate-700">
                    Stock
                  </th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((variant, idx) => (
                  <tr
                    key={variant.variant_id || idx}
                    className="border-b border-slate-200 hover:bg-white transition"
                  >
                    <td className="py-3 px-4 text-slate-900">
                      {variant.size_label || '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-900">
                      {variant.color_label || '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-700 font-mono text-xs">
                      {variant.sku || '—'}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-900">
                      {formatCurrency(variant.price ?? 0)}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-700">
                      {formatCurrency(variant.cost ?? 0)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={`inline-block px-3 py-1 rounded-full font-semibold ${getStockBadgeColor(
                          variant.quantity
                        )}`}
                      >
                        {variant.quantity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="h-10 bg-slate-300 rounded w-64 mb-2 animate-pulse"></div>
          <div className="h-4 bg-slate-300 rounded w-96 animate-pulse"></div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-white rounded-lg p-6 border border-slate-200 animate-pulse"
            >
              <div className="h-4 bg-slate-300 rounded w-24 mb-3"></div>
              <div className="h-8 bg-slate-300 rounded w-16"></div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-lg p-6 mb-8 animate-pulse border border-slate-200">
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 bg-slate-300 rounded"></div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-white rounded-lg p-6 border border-slate-200 animate-pulse"
            >
              <div className="h-6 bg-slate-300 rounded w-48 mb-2"></div>
              <div className="h-4 bg-slate-300 rounded w-32"></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}