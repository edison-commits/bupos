'use client';

import { useState, useRef, useCallback } from 'react';

interface Category {
  id: string;
  name: string;
}

interface LocalProduct {
  variant_id: string;
  product_id: string;
  sku: string;
  barcode: string;
  variant_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  cost: number | null;
  product_name: string;
  description: string | null;
  image_url: string | null;
  category_id: string | null;
  category_name: string | null;
  on_hand: number | null;
  reorder_point: number | null;
  location_name: string | null;
}

interface ExternalProduct {
  title: string;
  description: string;
  brand: string;
  category: string;
  image_url: string | null;
  upc: string;
  ean: string;
  msrp: number | null;
  lowest_price: number | null;
  highest_price: number | null;
}

type LookupResult =
  | { source: 'local'; found: true; product: LocalProduct }
  | { source: 'external'; found: true; product: ExternalProduct }
  | { source: 'none'; found: false; barcode: string; message: string };

export function BarcodeLookup({ categories }: { categories: Category[] }) {
  const [barcode, setBarcode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add product form state
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category_id: '',
    sku: '',
    price: '',
    cost: '',
    size_label: '',
    color_label: '',
    image_url: '',
    initial_stock: '0',
    reorder_point: '5',
  });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const handleLookup = useCallback(async () => {
    const trimmed = barcode.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setShowForm(false);
    setSaveMessage(null);

    try {
      const res = await fetch(`/api/barcode-lookup?barcode=${encodeURIComponent(trimmed)}`);
      if (!res.ok) throw new Error('Lookup failed');
      const data: LookupResult = await res.json();
      setResult(data);

      // If found externally, pre-fill form
      if (data.source === 'external' && data.found) {
        const ext = data.product;
        setFormData({
          name: ext.title || '',
          description: ext.description || '',
          category_id: '',
          sku: ext.upc || trimmed,
          price: ext.msrp ? String(ext.msrp) : '',
          cost: '',
          size_label: '',
          color_label: '',
          image_url: ext.image_url || '',
          initial_stock: '0',
          reorder_point: '5',
        });
        setShowForm(true);
      }

      // If not found anywhere, open empty form
      if (!data.found) {
        setFormData({
          name: '',
          description: '',
          category_id: '',
          sku: trimmed,
          price: '',
          cost: '',
          size_label: '',
          color_label: '',
          image_url: '',
          initial_stock: '0',
          reorder_point: '5',
        });
        setShowForm(true);
      }
    } catch {
      setError('Failed to look up barcode. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [barcode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLookup();
    }
  };

  const handleSave = async () => {
    if (!formData.name || !formData.category_id || !formData.sku || !formData.price) {
      setSaveMessage({ type: 'error', text: 'Please fill in all required fields: Name, Category, SKU, and Price.' });
      return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      const res = await fetch('/api/barcode-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          barcode: barcode.trim(),
          name: formData.name,
          description: formData.description,
          category_id: formData.category_id,
          sku: formData.sku,
          price: parseFloat(formData.price),
          cost: formData.cost ? parseFloat(formData.cost) : null,
          size_label: formData.size_label || null,
          color_label: formData.color_label || null,
          image_url: formData.image_url || null,
          initial_stock: parseInt(formData.initial_stock) || 0,
          reorder_point: parseInt(formData.reorder_point) || 5,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ type: 'error', text: data.error || 'Failed to save product' });
        return;
      }

      setSaveMessage({ type: 'success', text: data.message });
      setShowForm(false);
      setBarcode('');
      setResult(null);
      inputRef.current?.focus();
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save product. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-4">
      {/* Barcode input */}
      <div className="flex gap-3 items-start">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 8v8M10 8v8M14 8v8M18 8v8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Scan or type barcode / UPC number..."
            className="w-full rounded-lg border border-zinc-300 bg-white pl-11 pr-4 py-3 text-base text-zinc-800 placeholder-zinc-400 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            autoFocus
          />
        </div>
        <button
          onClick={handleLookup}
          disabled={loading || !barcode.trim()}
          className="touch-button px-6 py-3 rounded-lg bg-teal-700 text-white font-semibold text-base hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Looking up...
            </span>
          ) : 'Look Up'}
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        Scan a barcode with a USB/Bluetooth scanner or type the UPC number manually. We&apos;ll check your inventory first, then search online databases.
      </p>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
      )}

      {saveMessage && (
        <div className={`rounded-xl border p-3 text-sm ${saveMessage.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {saveMessage.text}
        </div>
      )}

      {/* Local product found */}
      {result?.source === 'local' && result.found && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-200 flex items-center justify-center">
              <svg className="h-5 w-5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-emerald-900 text-base">Found in your inventory</h4>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div><span className="text-emerald-700 font-medium">Product:</span> <span className="text-emerald-900">{result.product.product_name}</span></div>
                <div><span className="text-emerald-700 font-medium">Variant:</span> <span className="text-emerald-900">{result.product.variant_name}</span></div>
                <div><span className="text-emerald-700 font-medium">SKU:</span> <span className="text-emerald-900 font-mono">{result.product.sku}</span></div>
                <div><span className="text-emerald-700 font-medium">Barcode:</span> <span className="text-emerald-900 font-mono">{result.product.barcode}</span></div>
                <div><span className="text-emerald-700 font-medium">Price:</span> <span className="text-emerald-900">${Number(result.product.price).toFixed(2)}</span></div>
                <div><span className="text-emerald-700 font-medium">Cost:</span> <span className="text-emerald-900">{result.product.cost ? `$${Number(result.product.cost).toFixed(2)}` : '—'}</span></div>
                <div><span className="text-emerald-700 font-medium">On Hand:</span> <span className="text-emerald-900">{result.product.on_hand ?? 0}</span></div>
                <div><span className="text-emerald-700 font-medium">Category:</span> <span className="text-emerald-900">{result.product.category_name || '—'}</span></div>
                {result.product.size_label && <div><span className="text-emerald-700 font-medium">Size:</span> <span className="text-emerald-900">{result.product.size_label}</span></div>}
                {result.product.color_label && <div><span className="text-emerald-700 font-medium">Color:</span> <span className="text-emerald-900">{result.product.color_label}</span></div>}
                <div><span className="text-emerald-700 font-medium">Location:</span> <span className="text-emerald-900">{result.product.location_name || '—'}</span></div>
              </div>
            </div>
            {result.product.image_url && (
              <img src={result.product.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
            )}
          </div>
        </div>
      )}

      {/* External product found */}
      {result?.source === 'external' && result.found && (
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-200 flex items-center justify-center">
              <svg className="h-5 w-5 text-blue-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
              </svg>
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-blue-900 text-base">Found online — not yet in your inventory</h4>
              <p className="text-sm text-blue-700 mt-1">We found this product in the UPC database. Review the details below and add it to your inventory.</p>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div><span className="text-blue-700 font-medium">Name:</span> <span className="text-blue-900">{result.product.title}</span></div>
                {result.product.brand && <div><span className="text-blue-700 font-medium">Brand:</span> <span className="text-blue-900">{result.product.brand}</span></div>}
                {result.product.category && <div><span className="text-blue-700 font-medium">Category:</span> <span className="text-blue-900">{result.product.category}</span></div>}
                {result.product.msrp && <div><span className="text-blue-700 font-medium">MSRP:</span> <span className="text-blue-900">${result.product.msrp.toFixed(2)}</span></div>}
                <div><span className="text-blue-700 font-medium">UPC:</span> <span className="text-blue-900 font-mono">{result.product.upc}</span></div>
              </div>
            </div>
            {result.product.image_url && (
              <img src={result.product.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
            )}
          </div>
        </div>
      )}

      {/* Not found */}
      {result?.found === false && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center">
              <svg className="h-5 w-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h4 className="font-bold text-amber-900 text-base">Not found</h4>
              <p className="text-sm text-amber-700">Barcode <span className="font-mono">{result.barcode}</span> wasn&apos;t found in your inventory or online databases. You can add it manually below.</p>
            </div>
          </div>
        </div>
      )}

      {/* Add Product Form */}
      {showForm && (
        <div className="rounded-xl bg-white border-2 border-teal-300 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-zinc-900 mb-4">Add New Product</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Name */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1">Product Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="e.g. Classic Slim Fit Chino"
              />
            </div>

            {/* Description */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => updateField('description', e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="Product description..."
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Category <span className="text-red-500">*</span></label>
              <select
                value={formData.category_id}
                onChange={(e) => updateField('category_id', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700"
              >
                <option value="">Select category...</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* SKU */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">SKU <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={formData.sku}
                onChange={(e) => updateField('sku', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800 font-mono"
                placeholder="e.g. CHI-SF-32-KHK"
              />
            </div>

            {/* Price */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Price <span className="text-red-500">*</span></label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) => updateField('price', e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white pl-7 pr-3 py-2.5 text-sm text-zinc-800"
                  placeholder="0.00"
                />
              </div>
            </div>

            {/* Cost */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Cost</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  value={formData.cost}
                  onChange={(e) => updateField('cost', e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white pl-7 pr-3 py-2.5 text-sm text-zinc-800"
                  placeholder="0.00"
                />
              </div>
            </div>

            {/* Size Label */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Size</label>
              <input
                type="text"
                value={formData.size_label}
                onChange={(e) => updateField('size_label', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="e.g. 32, L, One Size"
              />
            </div>

            {/* Color Label */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Color</label>
              <input
                type="text"
                value={formData.color_label}
                onChange={(e) => updateField('color_label', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="e.g. Khaki, Navy, Black"
              />
            </div>

            {/* Image URL */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1">Image URL</label>
              <input
                type="url"
                value={formData.image_url}
                onChange={(e) => updateField('image_url', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="https://..."
              />
            </div>

            {/* Initial Stock */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Initial Stock</label>
              <input
                type="number"
                value={formData.initial_stock}
                onChange={(e) => updateField('initial_stock', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="0"
              />
            </div>

            {/* Reorder Point */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Reorder Point</label>
              <input
                type="number"
                value={formData.reorder_point}
                onChange={(e) => updateField('reorder_point', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800"
                placeholder="5"
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex gap-3 mt-5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Add to Inventory'}
            </button>
            <button
              onClick={() => { setShowForm(false); setSaveMessage(null); }}
              className="touch-button px-6 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Quick action to open form manually */}
      {!showForm && result?.source === 'local' && (
        <button
          onClick={() => {
            setFormData({
              name: '',
              description: '',
              category_id: '',
              sku: '',
              price: '',
              cost: '',
              size_label: '',
              color_label: '',
              image_url: '',
              initial_stock: '0',
              reorder_point: '5',
            });
            setShowForm(true);
          }}
          className="text-sm text-teal-700 hover:text-teal-900 font-medium underline underline-offset-2"
        >
          Add a different product with this barcode?
        </button>
      )}
    </div>
  );
}
