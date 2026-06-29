"use client";
import { S } from "./styles";
 

import { memo } from "react";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { Category, InventoryLevel, Product, ProductVariant } from "@/lib/domain/types";
import { VirtualKeyboard } from "@/components/ui/virtual-keyboard";

// Audio feedback imported from shared lib
import { playScanSuccess, playScanFail } from '@/lib/audio';
import { formatCurrency } from "@/lib/format";

export interface ProductGridItem {
  product: Product;
  variants: ProductVariant[];
  inventory: InventoryLevel[];
  category: Category | undefined;
}

interface ProductGridProps {
  items: ProductGridItem[];
  categories: Category[];
  onAddItem: (variant: ProductVariant, product: Product) => void;
}

// Category color palette - assigns colors based on position
const CATEGORY_COLORS = [
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-amber-100 text-amber-700 border-amber-200",
  "bg-pink-100 text-pink-700 border-pink-200",
  "bg-purple-100 text-purple-700 border-purple-200",
  "bg-cyan-100 text-cyan-700 border-cyan-200",
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-lime-100 text-lime-700 border-lime-200",
];

// Filled chip colors for active category pills
const CATEGORY_CHIP_ACTIVE = [
  "bg-blue-600 text-white",
  "bg-emerald-600 text-white",
  "bg-amber-600 text-white",
  "bg-pink-600 text-white",
  "bg-purple-600 text-white",
  "bg-cyan-600 text-white",
  "bg-rose-600 text-white",
  "bg-lime-600 text-white",
];

function getCategoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}

function getCategoryChipActive(index: number): string {
  return CATEGORY_CHIP_ACTIVE[index % CATEGORY_CHIP_ACTIVE.length];
}

export const ProductGrid = memo(function ProductGrid({ items, categories, onAddItem }: ProductGridProps) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | "all" | "favorites">("all");
  // R47-M: avoid hydration mismatch entirely — SSR renders 'md',
  // client's first render also renders 'md', and the `useEffect`
  // below upgrades to 'lg' for high-contrast users on the next
  // render. One extra render on HC is cheaper than the React #418
  // that R44-FE7 caught for the sibling theme-toggle (same shape:
  // lazy-init DOM read diverges SSR from client). Prior R36-FE4
  // rationale ("get 'lg' immediately, no layout shift") was
  // optimizing for a UX nit that was never actually reported, at
  // the cost of hydration-warning noise on every HC user's
  // register page load.
  const [tileSize, setTileSize] = useState<'sm' | 'md' | 'lg'>('md');
  const [variantPickerProduct, setVariantPickerProduct] = useState<ProductGridItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(false);

  // Auto-switch to large tiles when high-contrast mode is enabled.
  // R47-M: this effect now ALSO handles the mount-time upgrade (the
  // lazy init was dropped to fix hydration mismatch). On initial
  // mount the effect runs, reads the actual `data-theme` value, and
  // flips tileSize to 'lg' if appropriate — one extra render for
  // high-contrast users, zero hydration warnings.
  useEffect(() => {
    // Initial reconcile at mount.
    const isHighContrastInitial = document.documentElement.getAttribute('data-theme') === 'high-contrast';
    if (isHighContrastInitial) setTileSize('lg');
    const observer = new MutationObserver(() => {
      const isHighContrast = document.documentElement.getAttribute('data-theme') === 'high-contrast';
      // Always reconcile — flip up to 'lg' on high-contrast, flip back
      // to 'md' if the user leaves high-contrast. Prior shape only
      // upgraded; leaving HC kept the 'lg' tiles stuck.
      setTileSize((prev) => {
        if (isHighContrast) return 'lg';
        // Don't stomp 'sm' when user has manually zoomed out.
        return prev === 'lg' ? 'md' : prev;
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build a flat lookup of SKU/barcode → variant+product for instant scan matching.
  // Keep stock in a one-pass map so scanner setup stays O(products + variants + inventory),
  // not O(products × variants × inventory-per-product).
  const scanLookup = useMemo(() => {
    const stockByVariantId = new Map<string, number>();
    for (const item of items) {
      for (const inv of item.inventory) {
        stockByVariantId.set(inv.productVariantId, (stockByVariantId.get(inv.productVariantId) ?? 0) + inv.onHand);
      }
    }

    const map = new Map<string, { variant: ProductVariant; product: Product; stock: number }>();
    for (const item of items) {
      for (const v of item.variants) {
        const stock = stockByVariantId.get(v.id) ?? 0;
        if (v.sku) map.set(v.sku.toLowerCase(), { variant: v, product: item.product, stock });
        if (v.barcode) map.set(v.barcode.toLowerCase(), { variant: v, product: item.product, stock });
      }
    }
    return map;
  }, [items]);

  // Scanner auto-detect: when a query exactly matches a SKU/barcode, auto-add and clear
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setScanFeedback(null);

    // Clear previous scan timeout
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);

    if (!value.trim()) return;

    const q = value.trim().toLowerCase();
    const match = scanLookup.get(q);
    if (match) {
      if (match.stock <= 0) {
        playScanFail();
        setScanFeedback(`${match.product.name} — out of stock`);
        return;
      }
      // Delay slightly to let barcode scanners finish (they type fast then press Enter)
      scanTimeoutRef.current = setTimeout(() => {
        playScanSuccess();
        onAddItem(match.variant, match.product);
        setSearchQuery("");
        setScanFeedback(`Added: ${match.product.name} — ${match.variant.name}`);
        setTimeout(() => setScanFeedback(null), 2000);
        searchRef.current?.focus();
      }, 100);
    }
  }, [scanLookup, onAddItem]);

  // Handle Enter key for manual SKU/barcode entry
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !searchQuery.trim()) return;
    const q = searchQuery.trim().toLowerCase();
    const match = scanLookup.get(q);
    if (match) {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      if (match.stock <= 0) {
        playScanFail();
        setScanFeedback(`${match.product.name} — out of stock`);
        return;
      }
      playScanSuccess();
      onAddItem(match.variant, match.product);
      setSearchQuery("");
      setScanFeedback(`Added: ${match.product.name} — ${match.variant.name}`);
      setTimeout(() => setScanFeedback(null), 2000);
    }
  }, [searchQuery, scanLookup, onAddItem]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => { if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current); };
  }, []);

  const filtered = useMemo(() => {
    let result = items;

    // Category filter
    if (activeCategoryId === "favorites") {
      result = result.filter((i) => i.product.isTouchFavorite);
    } else if (activeCategoryId !== "all") {
      result = result.filter((i) => i.product.categoryId === activeCategoryId);
    }

    // Search filter — match product name, variant name, or SKU
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((i) =>
        i.product.name.toLowerCase().includes(q)
        || i.variants.some((v) => v.name.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q) || v.barcode?.toLowerCase().includes(q)),
      );
    }

    return result;
  }, [items, activeCategoryId, searchQuery]);

  function handleProductTap(item: ProductGridItem) {
    if (item.variants.length === 1) {
      onAddItem(item.variants[0], item.product);
    } else {
      setVariantPickerProduct(item);
    }
  }

  function handleVariantSelect(variant: ProductVariant, product: Product) {
    onAddItem(variant, product);
    setVariantPickerProduct(null);
  }

  // R82-FE-H1: Esc closes the variant picker. R81 added role=dialog
  // so keyboard-shortcuts global Esc yielded — but this component
  // had no own Esc handler, so Esc did nothing. Cashiers hit Esc
  // reflexively to dismiss the picker.
  useEffect(() => {
    if (!variantPickerProduct) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVariantPickerProduct(null);
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [variantPickerProduct]);

  return (
    <div className="flex h-full flex-col">
      {/* Search bar with barcode scanner support and integrated icons */}
      <div className="pb-3">
        <div className="relative">
          {/* Magnifying glass icon (SVG) on the left */}
          <svg
            className="absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-zinc-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>

          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search, scan or SKU..."
            className="search-bar w-full rounded-2xl border px-12 py-4 text-xl focus:ring-2 focus:outline-none transition-all"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-panel)',
              color: 'var(--text-primary)',
            }}
          />

          {/* Keyboard toggle + barcode icon on the right */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowKeyboard((v) => !v)}
              className={`rounded-lg p-1.5 transition-colors ${showKeyboard ? 'text-teal-600 bg-teal-50' : 'text-zinc-400 hover:text-teal-600 hover:bg-teal-50'}`}
              title="On-screen keyboard"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <line x1="6" y1="8" x2="6" y2="8.01" /><line x1="10" y1="8" x2="10" y2="8.01" /><line x1="14" y1="8" x2="14" y2="8.01" /><line x1="18" y1="8" x2="18" y2="8.01" />
                <line x1="6" y1="12" x2="6" y2="12.01" /><line x1="10" y1="12" x2="10" y2="12.01" /><line x1="14" y1="12" x2="14" y2="12.01" /><line x1="18" y1="12" x2="18" y2="12.01" />
                <line x1="8" y1="16" x2="16" y2="16" />
              </svg>
            </button>
            <svg
              className="h-6 w-6 text-zinc-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
            >
              <path d="M3 6v12M7 3v18M11 6v12M15 3v18M19 6v12M21 6v12" />
            </svg>
          </div>
        </div>
        {scanFeedback && (
          <p className={`mt-2 rounded-full px-3 py-1 text-base font-medium inline-block scan-feedback-fade ${
            scanFeedback.includes("out of stock")
              ? "bg-red-100 text-red-700"
              : "bg-emerald-100 text-emerald-700"
          }`}>{scanFeedback}</p>
        )}

        {/* Tile size control */}
        <div className="flex items-center gap-1 mt-3">
          <span className="text-base font-medium text-zinc-600 mr-1">Tiles:</span>
          {([['sm', 'S'], ['md', 'M'], ['lg', 'L']] as const).map(([size, label]) => (
            <button
              key={size}
              type="button"
              onClick={() => setTileSize(size)}
              className="touch-button rounded-xl px-4 py-2 text-base font-semibold transition-all"
              style={{
                backgroundColor: tileSize === size ? 'var(--surface-accent)' : 'var(--surface-panel-muted, #f4f4f5)',
                color: tileSize === size ? '#ffffff' : 'var(--text-secondary)',
                minHeight: '44px',
                minWidth: '44px',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Virtual keyboard for search */}
      <VirtualKeyboard
        visible={showKeyboard}
        value={searchQuery}
        onChange={(v) => handleSearchChange(v)}
        onEnter={() => {
          setShowKeyboard(false);
          if (searchQuery.trim()) {
            handleSearchKeyDown({ key: "Enter", preventDefault: () => {} } as React.KeyboardEvent<HTMLInputElement>);
          }
        }}
        onClose={() => setShowKeyboard(false)}
        label="Search products"
      />

      {/* Category chips — colored pills */}
      <div className="flex gap-2 overflow-x-auto pb-3">
        <CategoryChip
          label="All"
          active={activeCategoryId === "all"}
          colorClass="bg-blue-100 text-blue-700"
          activeClass="bg-blue-600 text-white"
          onTap={() => setActiveCategoryId("all")}
        />
        <CategoryChip
          label="⭐ Favorites"
          active={activeCategoryId === "favorites"}
          colorClass="bg-emerald-100 text-emerald-700"
          activeClass="bg-emerald-600 text-white"
          onTap={() => setActiveCategoryId("favorites")}
        />
        {categories.map((cat, idx) => (
          <CategoryChip
            key={cat.id}
            label={cat.name}
            active={activeCategoryId === cat.id}
            colorClass={getCategoryColor(idx + 2)}
            activeClass={getCategoryChipActive(idx + 2)}
            onTap={() => setActiveCategoryId(cat.id)}
          />
        ))}
      </div>

      {/* Product grid with larger tiles */}
      <div className={`product-grid-inner grid flex-1 auto-rows-min gap-4 overflow-y-auto ${
        tileSize === 'sm' ? 'grid-cols-3 md:grid-cols-4 lg:grid-cols-5' :
        tileSize === 'md' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4' :
        'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
      }`}>
        {filtered.map((item) => {
          const defaultVariant = item.variants.find((v) => v.id === item.product.defaultVariantId) ?? item.variants[0];
          const totalStock = item.inventory.reduce((sum, inv) => sum + inv.onHand, 0);
          const outOfStock = totalStock <= 0;
          const firstLetter = item.product.name.charAt(0).toUpperCase();
          const catIdx = categories.findIndex((c) => c.id === item.product.categoryId);
          const catColor = catIdx >= 0 ? getCategoryColor(catIdx + 2) : "";

          return (
            <button
              key={item.product.id}
              type="button"
              disabled={outOfStock}
              onClick={() => handleProductTap(item)}
              className={`product-tile relative flex flex-col overflow-hidden rounded-2xl text-left transition-all ${
                outOfStock
                  ? "cursor-not-allowed opacity-50"
                  : "hover:scale-[1.02] active:scale-[0.98] hover:shadow-xl"
              }`}
              style={{
                background: 'var(--surface-panel)',
                boxShadow: 'var(--shadow-card)',
                borderRadius: 'var(--radius-card)',
                minHeight: '11rem',
              }}
            >
              {/* Hero image area — 60%+ of card */}
              <div className="relative w-full" style={S.aspect4x3}>
                {item.product.imageUrl ? (
                  // Product image URLs are tenant-managed and may be remote; keep
                  // a plain img so the POS grid does not depend on Next image
                  // remote-pattern configuration for checkout-critical tiles.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.product.imageUrl}
                    alt={item.product.name}
                    className="h-full w-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-teal-600/20 to-teal-800/30">
                    <span className="text-4xl font-bold" style={S.surfaceAccent}>{firstLetter}</span>
                  </div>
                )}

                {/* Stock badge - top right over image */}
                <div className="absolute top-2 right-2">
                  {outOfStock ? (
                    <span className="inline-block rounded-full bg-red-500 px-3 py-1 text-sm font-bold text-white shadow">Out</span>
                  ) : totalStock <= 5 ? (
                    <span className="inline-block rounded-full bg-amber-500 px-3 py-1 text-sm font-bold text-white shadow">{totalStock}</span>
                  ) : (
                    <span className="inline-block rounded-full bg-black/50 px-3 py-1 text-sm font-bold text-white backdrop-blur-sm">{totalStock}</span>
                  )}
                </div>

                {/* Category badge - top left */}
                {item.category && catColor && (
                  <div className="absolute top-2 left-2">
                    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold shadow ${catColor}`}>
                      {item.category.name}
                    </span>
                  </div>
                )}
              </div>

              {/* Product info overlay below image */}
              <div className="flex flex-1 flex-col justify-between px-3 py-2.5">
                <div>
                  <p className="text-base font-bold leading-snug line-clamp-2" style={S.textPrimary}>{item.product.name}</p>
                  {item.variants.length > 1 && (
                    <p className="mt-0.5 text-sm" style={S.textSecondary}>{item.variants.length} variants</p>
                  )}
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-xl font-bold" style={S.surfaceAccent}>
                    {formatCurrency(defaultVariant?.price ?? 0)}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center py-16">
            <svg className="h-16 w-16 text-zinc-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
            <p className="text-lg font-medium text-zinc-500">
              {searchQuery.trim() ? `No results for "${searchQuery}"` : "No products in this category"}
            </p>
          </div>
        )}
      </div>

      {/* Variant picker overlay with cleaner card design */}
      {variantPickerProduct && (
        // R81-FE-H1: role=dialog so the R80 keyboard-shortcuts Esc
        // yield matches this overlay (prior shape let Esc fall
        // through to the global void-cart handler).
        <div role="dialog" aria-modal="true" aria-label="Pick variant" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl p-7 shadow-2xl" style={S.surfacePanel}>
            {/* Header with product info */}
            <div className="flex items-start justify-between gap-4 mb-6">
              <div className="flex items-center gap-4 flex-1">
                {variantPickerProduct.product.imageUrl ? (
                  // See product-tile image note above.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={variantPickerProduct.product.imageUrl}
                    alt={variantPickerProduct.product.name}
                    className="h-16 w-16 rounded-xl object-cover shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-teal-100 to-teal-200 shrink-0">
                    <span className="text-xl font-bold text-teal-700">{variantPickerProduct.product.name.charAt(0).toUpperCase()}</span>
                  </div>
                )}
                <h3 className="text-xl font-bold text-zinc-900">{variantPickerProduct.product.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setVariantPickerProduct(null)}
                className="touch-button rounded-lg bg-zinc-100 p-3 text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Subtitle */}
            <p className="text-base font-medium text-zinc-600 mb-5">Choose a variant</p>

            {/* Variant list with better spacing */}
            <div className="grid gap-3">
              {variantPickerProduct.variants.map((v) => {
                const inv = variantPickerProduct.inventory.find((i) => i.productVariantId === v.id);
                const stock = inv?.onHand ?? 0;
                return (
                  <button
                    key={v.id}
                    type="button"
                    disabled={stock <= 0}
                    onClick={() => handleVariantSelect(v, variantPickerProduct.product)}
                    className={`touch-button flex items-center justify-between rounded-xl border-2 px-5 py-4 transition-all ${
                      stock <= 0
                        ? "cursor-not-allowed border-zinc-200 bg-zinc-50 opacity-50"
                        : "border-zinc-200 bg-white hover:border-teal-300 hover:bg-teal-50 active:border-teal-400"
                    }`}
                  >
                    <div className="text-left min-w-0 flex-1">
                      <p className="text-lg font-semibold text-zinc-900">{v.name}</p>
                      {(v.sizeLabel || v.colorLabel) && (
                        <p className="text-sm text-zinc-700 mt-0.5">
                          {[v.sizeLabel, v.colorLabel].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-4 ml-3 shrink-0">
                      <div className="text-right">
                        <span className="text-base text-zinc-700">{stock > 0 ? `${stock} in stock` : "Out"}</span>
                      </div>
                      <span className="text-2xl font-bold text-teal-600">{formatCurrency(v.price)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function CategoryChip({
  label,
  active,
  colorClass,
  activeClass,
  onTap,
}: {
  label: string;
  active: boolean;
  colorClass: string;
  activeClass: string;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className={`category-chip shrink-0 rounded-full px-5 py-2.5 text-base font-bold transition-all whitespace-nowrap ${
        active
          ? `${activeClass} shadow-md scale-105`
          : `${colorClass} opacity-80 hover:opacity-100 hover:scale-105`
      }`}
    >
      {label}
    </button>
  );
}
