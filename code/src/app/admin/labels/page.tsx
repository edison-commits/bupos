'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminTopNav } from "@/components/layout/admin-top-nav";
interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  product_id: string;
  product_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
}

interface SelectedLabel {
  variant_id: string;
  sku: string;
  product_name: string;
  variant_name: string;
  size_label: string | null;
  color_label: string | null;
  price: number;
  quantity: number;
}

/**
 * Code 128B barcode generator
 * Generates SVG path data for Code 128 barcodes
 */
function generateCode128Bars(text: string): string {
  // Code 128B character set
  const code128B: Record<string, number> = {};
  
  // ASCII 32-126
  for (let i = 32; i <= 126; i++) {
    code128B[String.fromCharCode(i)] = i - 32;
  }
  
  // Patterns for Code 128 (11 bars per character)
  const patterns = [
    '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
    '10001001100', '10011001000', '10011000100', '10001100100', '11100100100',
    '11001001000', '11010001000', '00110011000', '00110010100', '00110010010',
    '00101011000', '00101001100', '00101000110', '00100110100', '00100110010',
    '00100010110', '00101101000', '00101100100', '00100100110', '11000101000',
    '11000100100', '11000010100', '10110011000', '10110001100', '10110000110',
    '10101011000', '10101001100', '10100101100', '10100100110', '10010110000',
    '10010100110', '10010010110', '10000101100', '10000100110', '10010011100',
    '11001011000', '11001001100', '11001000110', '00110110100', '00110100110',
    '00110010110', '00101101100', '00101100110', '00100110110', '11010001100',
    '11010000110', '11000110100', '11000101100', '11000100110', '10110100100',
    '10110010100', '10110010010', '10101100100', '10100110100', '10100110010',
    '10010100110', '11010010100', '11010010010', '11010001010', '00101011100',
    '00100101110', '00100011110', '00101001110', '00101010110', '00100101011',
    '11010100100', '11010010010', '11010001001', '10101101000', '10101100010',
    '10101011000', '10100101010', '10010101000', '10001010100', '10010010010',
    '11000101010', '11010010001', '00011010010', '00011001010', '00011000110',
    '00100011010', '00010011010', '00001011010', '00010110010', '00010011001',
    '00010010110', '00110100010', '00011010001', '00011001001', '00011010100',
  ];

  if (text.length === 0) return '';

  let checksum = 104; // START_B
  let barcode = patterns[104]; // START_B

  for (const char of text) {
    const code = code128B[char];
    if (code === undefined) return '';
    checksum += code;
    barcode += patterns[code];
  }

  checksum %= 103;
  barcode += patterns[checksum];
  barcode += patterns[106]; // STOP

  // Convert binary string to SVG path - each bar is 1 unit wide
  let path = 'M 0 0';
  let x = 0;

  for (const bit of barcode) {
    const width = 1;
    if (bit === '1') {
      path += ` L ${x} 50 L ${x + width} 50 L ${x + width} 0`;
    }
    x += width;
  }

  return path;
}

export default function LabelsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProductVariant[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [selectedLabels, setSelectedLabels] = useState<SelectedLabel[]>([]);
  const [labelSize, setLabelSize] = useState<'standard' | 'shelf'>('standard');
  const [showPreview, setShowPreview] = useState(false);

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
    const timer = setTimeout(() => {
      if (searchQuery) {
        searchProducts(searchQuery);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchProducts]);

  const handleAddVariant = (variant: ProductVariant) => {
    const existing = selectedLabels.find((l) => l.variant_id === variant.id);
    if (existing) {
      setSelectedLabels(
        selectedLabels.map((l) =>
          l.variant_id === variant.id ? { ...l, quantity: l.quantity + 1 } : l
        )
      );
    } else {
      setSelectedLabels([
        ...selectedLabels,
        {
          variant_id: variant.id,
          sku: variant.sku,
          product_name: variant.product_name,
          variant_name: variant.name,
          size_label: variant.size_label,
          color_label: variant.color_label,
          price: variant.price,
          quantity: 1,
        },
      ]);
    }
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleUpdateQuantity = (variantId: string, qty: number) => {
    if (qty <= 0) {
      setSelectedLabels(selectedLabels.filter((l) => l.variant_id !== variantId));
    } else {
      setSelectedLabels(
        selectedLabels.map((l) =>
          l.variant_id === variantId ? { ...l, quantity: qty } : l
        )
      );
    }
  };

  const handleRemoveLabel = (variantId: string) => {
    setSelectedLabels(selectedLabels.filter((l) => l.variant_id !== variantId));
  };

  const totalLabels = selectedLabels.reduce((sum, l) => sum + l.quantity, 0);

  return (
    <div style={{ backgroundColor: 'var(--surface-default)' }} className="min-h-screen">
        <AdminTopNav />
      {/* Header */}
      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
                Barcode Label Printing
              </h1>
              <p style={{ color: 'var(--text-secondary)' }} className="mt-1">
                Generate and print product labels with barcodes
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left Panel - Search & Selection */}
          <div
            className="rounded-lg border p-6"
            style={{
              backgroundColor: 'var(--surface-panel)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              Select Products
            </h2>

            {/* Search */}
            <div className="mb-4">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                Search by SKU or Name
              </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g., SKU-123 or Dickies"
                style={{
                  backgroundColor: 'var(--surface-default)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                className="mt-2 w-full rounded border px-3 py-2"
              />
              {searchLoading && (
                <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Searching...
                </p>
              )}
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <div
                className="mb-4 max-h-64 overflow-y-auto rounded border"
                style={{
                  backgroundColor: 'var(--surface-default)',
                  borderColor: 'var(--border-default)',
                }}
              >
                {searchResults.map((variant) => (
                  <button
                    key={variant.id}
                    onClick={() => handleAddVariant(variant)}
                    className="w-full border-b px-3 py-3 text-left transition hover:opacity-80"
                    style={{
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {variant.sku}
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }} className="text-xs">
                      {variant.product_name}
                      {variant.size_label && ` - ${variant.size_label}`}
                      {variant.color_label && ` (${variant.color_label})`}
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }} className="text-xs">
                      ${variant.price.toFixed(2)}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Label Size Selection */}
            <div className="mb-4 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <p className="mb-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                Label Size
              </p>
              <div className="space-y-2">
                {[
                  { value: 'standard', label: 'Standard (2.25" x 1.25")', cols: 4 },
                  { value: 'shelf', label: 'Shelf Tag (3" x 2")', cols: 3 },
                ].map((size) => (
                  <button
                    key={size.value}
                    onClick={() => setLabelSize(size.value as 'standard' | 'shelf')}
                    style={{
                      backgroundColor:
                        labelSize === size.value ? '#14b8a6' : 'var(--surface-default)',
                      color:
                        labelSize === size.value ? 'white' : 'var(--text-primary)',
                      borderColor:
                        labelSize === size.value ? '#14b8a6' : 'var(--border-default)',
                    }}
                    className="w-full rounded border px-3 py-2 text-sm font-medium transition"
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <button
                onClick={() => setShowPreview(true)}
                disabled={selectedLabels.length === 0}
                style={{
                  backgroundColor:
                    selectedLabels.length === 0 ? '#d1d5db' : '#14b8a6',
                  color: 'white',
                }}
                className="w-full rounded px-4 py-2 font-medium transition disabled:cursor-not-allowed"
              >
                Preview & Print
              </button>
              {selectedLabels.length > 0 && (
                <button
                  onClick={() => setSelectedLabels([])}
                  style={{
                    backgroundColor: 'var(--surface-default)',
                    borderColor: 'var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full rounded border px-4 py-2 font-medium transition"
                >
                  Clear All
                </button>
              )}
            </div>
          </div>

          {/* Right Panel - Selected Labels */}
          <div className="lg:col-span-2">
            <div
              className="rounded-lg border p-6"
              style={{
                backgroundColor: 'var(--surface-panel)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Selected Labels ({totalLabels})
              </h2>

              {selectedLabels.length > 0 ? (
                <div className="space-y-3">
                  {selectedLabels.map((label) => (
                    <div
                      key={label.variant_id}
                      className="flex items-center justify-between rounded border p-4"
                      style={{
                        backgroundColor: 'var(--surface-default)',
                        borderColor: 'var(--border-default)',
                      }}
                    >
                      <div className="flex-1">
                        <p className="font-bold" style={{ color: 'var(--text-primary)' }}>
                          {label.sku}
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {label.product_name}
                          {label.size_label && ` - ${label.size_label}`}
                          {label.color_label && ` (${label.color_label})`}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          ${label.price.toFixed(2)}
                        </p>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              handleUpdateQuantity(label.variant_id, label.quantity - 1)
                            }
                            style={{
                              backgroundColor: 'var(--surface-panel)',
                              borderColor: 'var(--border-default)',
                              color: 'var(--text-primary)',
                            }}
                            className="rounded border px-2 py-1 font-medium"
                          >
                            -
                          </button>
                          <input
                            type="number"
                            value={label.quantity}
                            onChange={(e) =>
                              handleUpdateQuantity(label.variant_id, parseInt(e.target.value) || 0)
                            }
                            min="0"
                            style={{
                              backgroundColor: 'var(--surface-panel)',
                              borderColor: 'var(--border-default)',
                              color: 'var(--text-primary)',
                              width: '50px',
                              textAlign: 'center',
                            }}
                            className="rounded border px-2 py-1 text-sm"
                          />
                          <button
                            onClick={() =>
                              handleUpdateQuantity(label.variant_id, label.quantity + 1)
                            }
                            style={{
                              backgroundColor: 'var(--surface-panel)',
                              borderColor: 'var(--border-default)',
                              color: 'var(--text-primary)',
                            }}
                            className="rounded border px-2 py-1 font-medium"
                          >
                            +
                          </button>
                        </div>

                        <button
                          onClick={() => handleRemoveLabel(label.variant_id)}
                          className="font-medium transition"
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
                  Add products above to generate labels
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Print Preview Modal */}
        {showPreview && (
          <div
            className="fixed inset-0 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 50 }}
          >
            <div
              className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border p-6"
              style={{
                backgroundColor: 'var(--surface-panel)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  Label Preview
                </h2>
                <button
                  onClick={() => setShowPreview(false)}
                  className="text-lg font-bold transition"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  ×
                </button>
              </div>

              {/* Print Preview */}
              <div
                className="mb-6 rounded border p-4"
                style={{
                  backgroundColor: 'white',
                  borderColor: 'var(--border-default)',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      labelSize === 'standard'
                        ? 'repeat(4, minmax(0, 1fr))'
                        : 'repeat(3, minmax(0, 1fr))',
                    gap: '16px',
                    padding: '20px',
                  }}
                >
                  {selectedLabels.flatMap((label) =>
                    Array.from({ length: label.quantity }, (_, i) => (
                      <div
                        key={`${label.variant_id}-${i}`}
                        style={{
                          border: '1px solid #e5e7eb',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          fontSize: labelSize === 'standard' ? '11px' : '13px',
                          lineHeight: '1.2',
                          minHeight: labelSize === 'standard' ? '125px' : '200px',
                          backgroundColor: '#ffffff',
                        }}
                      >
                        {/* Product Name */}
                        <div>
                          <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                            {label.product_name}
                          </div>
                          {label.variant_name && (
                            <div style={{ fontSize: labelSize === 'standard' ? '9px' : '11px' }}>
                              {label.variant_name}
                            </div>
                          )}
                          {(label.size_label || label.color_label) && (
                            <div style={{ fontSize: labelSize === 'standard' ? '9px' : '11px', color: '#666' }}>
                              {label.size_label && `Size: ${label.size_label}`}
                              {label.size_label && label.color_label && ' / '}
                              {label.color_label && `Color: ${label.color_label}`}
                            </div>
                          )}
                        </div>

                        {/* SKU and Price */}
                        <div>
                          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
                            SKU: {label.sku}
                          </div>
                          <div style={{ fontWeight: 'bold', fontSize: labelSize === 'standard' ? '13px' : '16px' }}>
                            ${label.price.toFixed(2)}
                          </div>
                        </div>

                        {/* Barcode */}
                        <svg
                          viewBox={`0 0 ${label.sku.length * 11} 60`}
                          style={{
                            width: '100%',
                            height: labelSize === 'standard' ? '40px' : '60px',
                            marginTop: '8px',
                          }}
                        >
                          <path
                            d={generateCode128Bars(label.sku)}
                            stroke="black"
                            strokeWidth="0.5"
                            fill="none"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                        <div
                          style={{
                            textAlign: 'center',
                            fontSize: labelSize === 'standard' ? '8px' : '10px',
                            marginTop: '4px',
                            fontFamily: 'monospace',
                          }}
                        >
                          {label.sku}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Print Actions */}
              <div className="flex gap-3 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  onClick={() => setShowPreview(false)}
                  style={{
                    backgroundColor: 'var(--surface-default)',
                    borderColor: 'var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                  className="flex-1 rounded border px-4 py-2 font-medium transition"
                >
                  Back
                </button>
                <button
                  onClick={() => window.print()}
                  style={{
                    backgroundColor: '#14b8a6',
                    color: 'white',
                  }}
                  className="flex-1 rounded px-4 py-2 font-medium transition"
                >
                  Print Labels
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Print Styles */}
        <style>{`
          @media print {
            body {
              margin: 0;
              padding: 0;
              background-color: white;
            }
            
            @page {
              size: letter;
              margin: 0.5in;
            }
            
            div:not([style*="grid"]) {
              break-inside: avoid;
            }
            
            /* Hide all non-print content */
            h1, h2, p:not([style*="grid"]),
            button, input, label, .hidden-print {
              display: none !important;
            }
          }
        `}</style>
      </div>
    </div>
  );
}
