"use client";

import { useState, useRef, useCallback } from "react";
import type { Product, ProductVariant } from "@/lib/domain/types";

interface BarcodeLabelPrinterProps {
  products: Product[];
  variants: ProductVariant[];
}

interface LabelItem {
  variant: ProductVariant;
  product: Product;
  quantity: number;
}

// Code128B barcode encoding
const CODE128_START_B = 104;
const CODE128_STOP = 106;
const CODE128_PATTERNS: number[][] = [
  [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],
  [1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],
  [2,2,1,3,1,2],[2,3,1,2,1,2],[1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],
  [1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
  [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],[3,1,1,2,2,2],
  [3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
  [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],
  [1,3,1,3,2,1],[1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
  [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
  [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[3,1,3,1,2,1],[2,1,1,3,3,1],
  [2,3,1,1,3,1],[2,1,3,1,1,3],[2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],
  [3,1,1,3,2,1],[3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
  [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],
  [1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],[1,4,1,2,2,1],[1,1,2,2,1,4],
  [1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],
  [2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
  [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],
  [1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],
  [2,1,4,1,2,1],[4,1,2,1,2,1],[1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],
  [1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
  [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],[2,1,1,2,1,4],
  [2,1,1,2,3,2],[2,3,3,1,1,1,2],
];

function encodeCode128B(text: string): number[][] {
  const codes: number[] = [CODE128_START_B];
  for (let i = 0; i < text.length; i++) {
    codes.push(text.charCodeAt(i) - 32);
  }
  // Checksum
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) {
    checksum += codes[i] * i;
  }
  codes.push(checksum % 103);
  codes.push(CODE128_STOP);
  return codes.map((c) => CODE128_PATTERNS[c]);
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function generateBarcodeSVG(text: string, width: number, height: number): string {
  const patterns = encodeCode128B(text);
  const bars: string[] = [];
  let x = 10; // quiet zone
  const barWidth = Math.max(1, (width - 20) / (patterns.length * 11 + 2));

  for (const pattern of patterns) {
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] * barWidth;
      if (i % 2 === 0) {
        bars.push(`<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="black"/>`);
      }
      x += w;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 20}" width="${width}" height="${height + 20}">
    <rect width="${width}" height="${height + 20}" fill="white"/>
    ${bars.join("\n    ")}
    <text x="${width / 2}" y="${height + 14}" text-anchor="middle" font-family="monospace" font-size="10">${escXml(text)}</text>
  </svg>`;
}

export function BarcodeLabelPrinter({ products, variants }: BarcodeLabelPrinterProps) {
  const [labelItems, setLabelItems] = useState<LabelItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [labelSize, setLabelSize] = useState<"small" | "medium" | "large">("medium");
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(true);
  const printRef = useRef<HTMLDivElement>(null);

  const filteredVariants = searchTerm.trim()
    ? variants.filter((v) => {
        const product = products.find((p) => p.id === v.productId);
        const term = searchTerm.toLowerCase();
        return (
          v.sku.toLowerCase().includes(term) ||
          v.name.toLowerCase().includes(term) ||
          v.barcode?.toLowerCase().includes(term) ||
          product?.name.toLowerCase().includes(term)
        );
      })
    : variants;

  const addToQueue = useCallback((variant: ProductVariant) => {
    const product = products.find((p) => p.id === variant.productId);
    if (!product) return;
    setLabelItems((prev) => {
      const existing = prev.find((item) => item.variant.id === variant.id);
      if (existing) {
        return prev.map((item) =>
          item.variant.id === variant.id ? { ...item, quantity: item.quantity + 1 } : item,
        );
      }
      return [...prev, { variant, product, quantity: 1 }];
    });
  }, [products]);

  const updateQuantity = useCallback((variantId: string, qty: number) => {
    if (qty <= 0) {
      setLabelItems((prev) => prev.filter((item) => item.variant.id !== variantId));
    } else {
      setLabelItems((prev) =>
        prev.map((item) => (item.variant.id === variantId ? { ...item, quantity: qty } : item)),
      );
    }
  }, []);

  const totalLabels = labelItems.reduce((sum, item) => sum + item.quantity, 0);

  const sizeConfig = {
    small: { w: 180, h: 50, bh: 30, cls: "w-[180px] h-[70px]" },
    medium: { w: 240, h: 60, bh: 40, cls: "w-[240px] h-[90px]" },
    large: { w: 300, h: 80, bh: 50, cls: "w-[300px] h-[110px]" },
  }[labelSize];

  const handlePrint = useCallback(() => {
    if (!printRef.current) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    // Safe print: extract label content as text and rebuild. Avoids innerHTML XSS.
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const labels = labelItems.map(({ variant, product, quantity }) => {
      const name = escapeHtml(product.name);
      const sku = escapeHtml(variant.sku || '');
      const price = `$${variant.price.toFixed(2)}`;
      const barcode = generateBarcodeSVG(variant.barcode || variant.sku || variant.id, sizeConfig.w - 16, sizeConfig.bh);
      return Array.from({ length: quantity }, () =>
        `<div class="label"><div class="label-name">${name}</div><div class="label-sku">${sku}</div>${barcode}<div class="label-price">${price}</div></div>`
      ).join('');
    }).join('');
    printWindow.document.write(`<!DOCTYPE html>
      <html><head><title>Barcode Labels</title>
      <style>
        body { margin: 0; font-family: system-ui, sans-serif; }
        .label-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
        .label { border: 1px dashed #ccc; padding: 4px; text-align: center; page-break-inside: avoid; }
        .label-name { font-size: 9px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: ${sizeConfig.w - 16}px; }
        .label-sku { font-size: 8px; color: #666; }
        .label-price { font-size: 11px; font-weight: 700; }
        @media print { .label { border: 1px dashed #ccc; } }
      </style></head><body>
      <div class="label-grid">${labels}</div>
      <script>window.onload=function(){window.print();window.close();}<\/script>
      </body></html>`);
    printWindow.document.close();
  }, [labelItems, sizeConfig.w, sizeConfig.bh]);

  return (
    <div className="space-y-4">
      {/* Search and add */}
      <div>
        <input
          type="text"
          placeholder="Search by name, SKU, or barcode..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm focus:border-teal-400 focus:outline-none"
        />
        {searchTerm.trim() && (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2">
            {filteredVariants.length === 0 ? (
              <p className="py-2 text-center text-sm text-zinc-400">No matches</p>
            ) : (
              filteredVariants.slice(0, 20).map((v) => {
                const product = products.find((p) => p.id === v.productId);
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => { addToQueue(v); setSearchTerm(""); }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-50"
                  >
                    <div>
                      <span className="font-medium">{product?.name}</span>
                      <span className="ml-2 text-zinc-500">{v.name}</span>
                    </div>
                    <span className="text-xs text-zinc-400">{v.sku}{v.barcode ? ` · ${v.barcode}` : ""}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="font-medium text-zinc-600">Size:</span>
          <select
            value={labelSize}
            onChange={(e) => setLabelSize(e.target.value as "small" | "medium" | "large")}
            className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm"
          >
            <option value="small">Small (1.8&quot;)</option>
            <option value="medium">Medium (2.4&quot;)</option>
            <option value="large">Large (3&quot;)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-zinc-600">
          <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
          Show price
        </label>
        <label className="flex items-center gap-2 text-zinc-600">
          <input type="checkbox" checked={showSku} onChange={(e) => setShowSku(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
          Show SKU
        </label>
      </div>

      {/* Queue */}
      {labelItems.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-zinc-700">Print queue ({totalLabels} labels)</h4>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLabelItems([])}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={handlePrint}
                className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
              >
                Print {totalLabels} label{totalLabels !== 1 ? "s" : ""}
              </button>
            </div>
          </div>

          {labelItems.map((item) => (
            <div key={item.variant.id} className="flex items-center justify-between rounded-xl border border-zinc-200 px-3 py-2">
              <div>
                <p className="text-sm font-medium">{item.product.name} — {item.variant.name}</p>
                <p className="text-xs text-zinc-500">{item.variant.sku}{item.variant.barcode ? ` · ${item.variant.barcode}` : ""}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => updateQuantity(item.variant.id, item.quantity - 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-sm font-bold hover:bg-zinc-200"
                >
                  −
                </button>
                <span className="w-8 text-center text-sm font-semibold">{item.quantity}</span>
                <button
                  type="button"
                  onClick={() => updateQuantity(item.variant.id, item.quantity + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-sm font-bold hover:bg-zinc-200"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Print preview */}
      {labelItems.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-zinc-700">Preview</h4>
          <div ref={printRef} className="flex flex-wrap gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-3">
            {labelItems.flatMap((item) =>
              Array.from({ length: Math.min(item.quantity, 8) }, (_, i) => {
                const barcodeText = item.variant.barcode || item.variant.sku;
                return (
                  <div
                    key={`${item.variant.id}-${i}`}
                    className={`${sizeConfig.cls} flex flex-col items-center justify-center rounded border border-zinc-200 bg-white p-1`}
                  >
                    <p className="max-w-full truncate text-[9px] font-semibold">{item.product.name} {item.variant.name}</p>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: generateBarcodeSVG(barcodeText, sizeConfig.w - 16, sizeConfig.bh),
                      }}
                    />
                    <div className="flex w-full items-center justify-between px-1">
                      {showSku && <span className="text-[7px] text-zinc-500">{item.variant.sku}</span>}
                      {showPrice && <span className="text-[10px] font-bold">${item.variant.price.toFixed(2)}</span>}
                    </div>
                  </div>
                );
              }),
            )}
            {totalLabels > labelItems.reduce((s, i) => s + Math.min(i.quantity, 8), 0) && (
              <p className="self-center text-xs text-zinc-400">
                + {totalLabels - labelItems.reduce((s, i) => s + Math.min(i.quantity, 8), 0)} more labels...
              </p>
            )}
          </div>
        </div>
      )}

      {labelItems.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-8 text-center">
          <p className="text-sm text-zinc-500">Search for products above to add barcode labels to the print queue.</p>
          <p className="mt-1 text-xs text-zinc-400">Labels use Code128 barcodes generated from the variant barcode or SKU.</p>
        </div>
      )}
    </div>
  );
}
