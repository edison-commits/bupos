'use client';

import { useCallback, useEffect, useState } from 'react';

interface ProductVariant {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  compare_at_price: number | null;
  cost: number;
  is_active: boolean;
  stock: number;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  category_id: string | null;
  category_name: string | null;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
  is_touch_favorite: boolean;
  supplier_id: string | null;
  supplier_name: string | null;
  variant_count: number;
  price_range: { min: number; max: number } | null;
  total_stock: number;
  variants: ProductVariant[];
}

interface Category {
  id: string;
  name: string;
  slug: string;
}

interface ProductsData {
  products: Product[];
  categories: Category[];
  summary: {
    total_products: number;
    active_products: number;
    total_variants: number;
    categories_count: number;
  };
}

interface ModalState {
  type: 'add-product' | 'edit-product' | 'add-variant' | 'edit-variant' | null;
  productId?: string;
  variantId?: string;
  data?: Partial<Product> | Partial<ProductVariant>;
}

export default function ProductsPage() {
  const [data, setData] = useState<ProductsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<ModalState>({ type: null });
  const [saving, setSaving] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [showCategoryForm, setShowCategoryForm] = useState(false);

  // Fetch products
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (selectedCategory) params.append('category', selectedCategory);
      if (activeFilter !== 'all') params.append('active', activeFilter === 'active' ? 'true' : 'false');

      const response = await fetch(`/api/products?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch products');
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [search, selectedCategory, activeFilter]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const toggleExpandProduct = (productId: string) => {
    const newExpanded = new Set(expandedProducts);
    if (newExpanded.has(productId)) {
      newExpanded.delete(productId);
    } else {
      newExpanded.add(productId);
    }
    setExpandedProducts(newExpanded);
  };

  const handleAddProduct = async (formData: Partial<Product>) => {
    setSaving(true);
    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!response.ok) throw new Error('Failed to create product');
      setModal({ type: null });
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setSaving(false);
    }
  };

  const handleEditProduct = async (productId: string, formData: Partial<Product>) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/products`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: productId, ...formData }),
      });
      if (!response.ok) throw new Error('Failed to update product');
      setModal({ type: null });
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update product');
    } finally {
      setSaving(false);
    }
  };

  const handleAddVariant = async (productId: string, formData: Partial<ProductVariant>) => {
    setSaving(true);
    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, variant: formData }),
      });
      if (!response.ok) throw new Error('Failed to add variant');
      setModal({ type: null });
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add variant');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async (productId: string) => {
    if (!window.confirm('Soft-delete this product? It will be marked inactive.')) return;
    try {
      const response = await fetch('/api/products', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: productId }),
      });
      if (!response.ok) throw new Error('Failed to delete product');
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete product');
    }
  };

  const handleAddCategory = async () => {
    if (!newCategory.trim()) return;
    setSaving(true);
    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: { name: newCategory, slug: newCategory.toLowerCase().replace(/\s+/g, '-') } }),
      });
      if (!response.ok) throw new Error('Failed to create category');
      setNewCategory('');
      setShowCategoryForm(false);
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create category');
    } finally {
      setSaving(false);
    }
  };

  const handleExportCSV = () => {
    if (!data?.products) return;
    const rows = [['Product', 'Category', 'SKU', 'Size', 'Color', 'Price', 'Cost', 'Stock', 'Active']];
    data.products.forEach(product => {
      if (product.variants.length === 0) {
        rows.push([product.name, product.category_name || '', '', '', '', '', '', '', product.is_active ? 'Yes' : 'No']);
      } else {
        product.variants.forEach(variant => {
          rows.push([
            product.name,
            product.category_name || '',
            variant.sku,
            variant.size_label || '',
            variant.color_label || '',
            variant.price.toFixed(2),
            variant.cost.toFixed(2),
            variant.stock.toString(),
            variant.is_active ? 'Yes' : 'No',
          ]);
        });
      }
    });
    const csv = rows.map(r => r.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `products-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-32 animate-pulse rounded-lg bg-emerald-100"></div>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-emerald-50"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
        Error loading products: {error}
      </div>
    );
  }

  const filteredProducts = data?.products || [];

  return (
    <div className="space-y-6 p-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'Total Products', value: data?.summary.total_products || 0 },
          { label: 'Active Products', value: data?.summary.active_products || 0 },
          { label: 'Total Variants', value: data?.summary.total_variants || 0 },
          { label: 'Categories', value: data?.summary.categories_count || 0 },
        ].map((card, i) => (
          <div key={i} className="rounded-lg border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4">
            <div className="text-xs font-medium text-emerald-600">{card.label}</div>
            <div className="text-2xl font-bold text-emerald-900">{card.value}</div>
          </div>
        ))}
      </div>

      {/* Search and Filters */}
      <div className="rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
        <div className="grid gap-4 md:grid-cols-4">
          <input
            type="text"
            placeholder="Search by product name or SKU..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          >
            <option value="">All Categories</option>
            {data?.categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <select
            value={activeFilter}
            onChange={e => setActiveFilter(e.target.value as any)}
            className="rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All Status</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>
          <button
            onClick={() => setModal({ type: 'add-product' })}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            + Add Product
          </button>
        </div>
      </div>

      {/* Products Table */}
      <div className="space-y-2">
        {filteredProducts.length === 0 ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-8 text-center text-emerald-700">
            No products found. {search || selectedCategory ? 'Try adjusting your filters.' : 'Add your first product!'}
          </div>
        ) : (
          filteredProducts.map(product => (
            <ProductRow
              key={product.id}
              product={product}
              expanded={expandedProducts.has(product.id)}
              onToggleExpand={() => toggleExpandProduct(product.id)}
              onEdit={() => setModal({ type: 'edit-product', productId: product.id, data: product })}
              onDelete={() => handleDeleteProduct(product.id)}
              onAddVariant={() => setModal({ type: 'add-variant', productId: product.id })}
              onEditVariant={(variant: any) => setModal({ type: 'edit-variant', productId: product.id, variantId: variant.id, data: variant })}
            />
          ))
        )}
      </div>

      {/* Category Management */}
      <div className="rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-emerald-900">Categories ({data?.categories.length || 0})</h3>
          <button
            onClick={() => setShowCategoryForm(!showCategoryForm)}
            className="rounded-lg bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-200"
          >
            {showCategoryForm ? 'Cancel' : '+ Add Category'}
          </button>
        </div>
        {showCategoryForm && (
          <div className="mt-4 flex gap-2">
            <input
              type="text"
              placeholder="Category name..."
              value={newCategory}
              onChange={e => setNewCategory(e.target.value)}
              className="flex-1 rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            <button
              onClick={handleAddCategory}
              disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {data?.categories.map(cat => (
            <div key={cat.id} className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm">
              <span className="font-medium text-emerald-900">{cat.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Export Button */}
      <button
        onClick={handleExportCSV}
        className="w-full rounded-lg bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-700"
      >
        Export to CSV
      </button>

      {/* Modals */}
      {modal.type === 'add-product' && (
        <AddProductModal
          categories={data?.categories || []}
          onSave={handleAddProduct}
          onClose={() => setModal({ type: null })}
          saving={saving}
        />
      )}
      {modal.type === 'edit-product' && modal.productId && (
        <EditProductModal
          product={modal.data as Product}
          categories={data?.categories || []}
          onSave={(formData) => handleEditProduct(modal.productId!, formData)}
          onClose={() => setModal({ type: null })}
          saving={saving}
        />
      )}
      {modal.type === 'add-variant' && modal.productId && (
        <AddVariantModal
          onSave={(formData) => handleAddVariant(modal.productId!, formData)}
          onClose={() => setModal({ type: null })}
          saving={saving}
        />
      )}
      {modal.type === 'edit-variant' && modal.variantId && (
        <EditVariantModal
          variant={modal.data as ProductVariant}
          onSave={() => {}}
          onClose={() => setModal({ type: null })}
          saving={saving}
        />
      )}
    </div>
  );
}

function ProductRow({ product, expanded, onToggleExpand, onEdit, onDelete, onAddVariant, onEditVariant }: any) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-emerald-100 p-4">
        <div className="flex-1">
          <button
            onClick={onToggleExpand}
            className="flex items-center gap-3 text-left"
          >
            <div className="text-emerald-600">
              {expanded ? '▼' : '▶'}
            </div>
            <div>
              <div className="font-semibold text-emerald-900">{product.name}</div>
              <div className="text-xs text-emerald-600">{product.category_name || 'Uncategorized'}</div>
            </div>
          </button>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="text-right">
            <div className="text-xs text-emerald-600">Variants</div>
            <div className="font-semibold text-emerald-900">{product.variant_count}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-emerald-600">Price Range</div>
            <div className="font-semibold text-emerald-900">
              {product.price_range ? `$${product.price_range.min.toFixed(2)}-$${product.price_range.max.toFixed(2)}` : 'N/A'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-emerald-600">Stock</div>
            <div className={`font-semibold ${product.total_stock === 0 ? 'text-red-600' : 'text-emerald-900'}`}>
              {product.total_stock}
            </div>
          </div>
          <button
            onClick={onEdit}
            className="rounded px-2 py-1 text-emerald-600 hover:bg-emerald-50"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded px-2 py-1 text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 bg-emerald-50 p-4">
          <div className="text-xs font-semibold text-emerald-700 uppercase">Variants</div>
          {product.variants.length === 0 ? (
            <div className="text-sm text-emerald-600">No variants yet</div>
          ) : (
            <div className="space-y-2">
              {product.variants.map((variant: any) => (
                <div key={variant.id} className="flex items-center justify-between rounded-lg bg-white p-3 text-sm">
                  <div>
                    <div className="font-medium text-emerald-900">{variant.sku}</div>
                    <div className="text-xs text-emerald-600">
                      {variant.size_label && `Size: ${variant.size_label}`}
                      {variant.color_label && ` | Color: ${variant.color_label}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <div className="text-xs text-emerald-600">Price</div>
                      <div className="font-semibold text-emerald-900">${variant.price.toFixed(2)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-emerald-600">Cost</div>
                      <div className="font-semibold text-emerald-900">${variant.cost.toFixed(2)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-emerald-600">Stock</div>
                      <div className={`font-semibold ${variant.stock === 0 ? 'text-red-600' : 'text-emerald-900'}`}>
                        {variant.stock}
                      </div>
                    </div>
                    <button
                      onClick={() => onEditVariant(variant)}
                      className="rounded px-2 py-1 text-emerald-600 hover:bg-emerald-100"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={onAddVariant}
            className="mt-2 rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-200"
          >
            + Add Variant
          </button>
        </div>
      )}
    </div>
  );
}

interface ModalProps {
  categories?: Category[];
  onSave: (data: any) => void;
  onClose: () => void;
  saving: boolean;
  product?: Product;
  variant?: ProductVariant;
}

function AddProductModal({ categories = [], onSave, onClose, saving }: ModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    category_id: '',
    description: '',
    image_url: '',
    is_active: true,
    is_touch_favorite: false,
  });

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      alert('Product name is required');
      return;
    }
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-emerald-900">Add Product</h2>
        <div className="space-y-3">
          <input
            type="text"
            placeholder="Product Name"
            value={formData.name}
            onChange={e => setFormData({ ...formData, name: e.target.value, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
            className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Slug"
            value={formData.slug}
            onChange={e => setFormData({ ...formData, slug: e.target.value })}
            className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <select
            value={formData.category_id}
            onChange={e => setFormData({ ...formData, category_id: e.target.value })}
            className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          >
            <option value="">Select Category</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <textarea
            placeholder="Description"
            value={formData.description}
            onChange={e => setFormData({ ...formData, description: e.target.value })}
            className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            rows={3}
          />
          <input
            type="text"
            placeholder="Image URL"
            value={formData.image_url}
            onChange={e => setFormData({ ...formData, image_url: e.target.value })}
            className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={formData.is_active}
                onChange={e => setFormData({ ...formData, is_active: e.target.checked })}
              />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={formData.is_touch_favorite}
                onChange={e => setFormData({ ...formData, is_touch_favorite: e.target.checked })}
              />
              Touch Favorite
            </label>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditProductModal({ product, categories = [], onSave, onClose, saving }: ModalProps) {
  const [formData, setFormData] = useState<any>(product || {});

  const handleSubmit = () => {
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-emerald-900">Edit Product</h2>
        <div className="space-y-3">
          <input type="text" placeholder="Product Name" value={formData.name || ''} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="text" placeholder="Slug" value={formData.slug || ''} onChange={e => setFormData({ ...formData, slug: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <select value={formData.category_id || ''} onChange={e => setFormData({ ...formData, category_id: e.target.value || null })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none">
            <option value="">Select Category</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <textarea placeholder="Description" value={formData.description || ''} onChange={e => setFormData({ ...formData, description: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" rows={3} />
          <input type="text" placeholder="Image URL" value={formData.image_url || ''} onChange={e => setFormData({ ...formData, image_url: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <div className="flex gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={formData.is_active || false} onChange={e => setFormData({ ...formData, is_active: e.target.checked })} />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={formData.is_touch_favorite || false} onChange={e => setFormData({ ...formData, is_touch_favorite: e.target.checked })} />
              Touch Favorite
            </label>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function AddVariantModal({ onSave, onClose, saving }: ModalProps) {
  const [formData, setFormData] = useState({
    sku: '',
    barcode: '',
    name: '',
    size_label: '',
    color_label: '',
    price: 0,
    compare_at_price: null as number | null,
    cost: 0,
  });

  const handleSubmit = () => {
    if (!formData.sku.trim()) {
      alert('SKU is required');
      return;
    }
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-emerald-900">Add Variant</h2>
        <div className="space-y-3">
          <input type="text" placeholder="SKU" value={formData.sku} onChange={e => setFormData({ ...formData, sku: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="text" placeholder="Barcode" value={formData.barcode} onChange={e => setFormData({ ...formData, barcode: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="text" placeholder="Variant Name" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="text" placeholder="Size" value={formData.size_label} onChange={e => setFormData({ ...formData, size_label: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="text" placeholder="Color" value={formData.color_label} onChange={e => setFormData({ ...formData, color_label: e.target.value })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="number" placeholder="Price" step="0.01" value={formData.price} onChange={e => setFormData({ ...formData, price: parseFloat(e.target.value) })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="number" placeholder="Compare at Price" step="0.01" value={formData.compare_at_price || ''} onChange={e => setFormData({ ...formData, compare_at_price: e.target.value ? parseFloat(e.target.value) : null })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="number" placeholder="Cost" step="0.01" value={formData.cost} onChange={e => setFormData({ ...formData, cost: parseFloat(e.target.value) })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function EditVariantModal({ variant, onSave, onClose, saving }: ModalProps) {
  const [formData, setFormData] = useState<any>(variant || {});

  const handleSubmit = () => {
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-emerald-900">Edit Variant</h2>
        <div className="space-y-3">
          <input type="number" placeholder="Price" step="0.01" value={formData.price || 0} onChange={e => setFormData({ ...formData, price: parseFloat(e.target.value) })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="number" placeholder="Cost" step="0.01" value={formData.cost || 0} onChange={e => setFormData({ ...formData, cost: parseFloat(e.target.value) })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          <input type="number" placeholder="Stock" value={formData.stock || 0} onChange={e => setFormData({ ...formData, stock: parseInt(e.target.value) })} className="w-full rounded-lg border border-emerald-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
