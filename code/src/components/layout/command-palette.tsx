"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/api/client";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { NAV_GROUPS } from "./admin-nav";
import { CornerDownLeft, Package, Search, User } from "lucide-react";

/**
 * Cmd/Ctrl+K command palette: quick-jump to any admin page, plus live
 * product (name/SKU) and customer (name/email/phone) search via the
 * existing APIs. Controlled by AdminShell (sidebar Search button + the
 * global shortcut both open it). Sources that 403 for the current role
 * simply contribute no results.
 */

type IconType = ComponentType<{ className?: string }>;
interface PaletteItem {
  kind: "page" | "product" | "customer";
  label: string;
  sub?: string;
  href: string;
  icon: IconType;
}

const ALL_PAGES: PaletteItem[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ kind: "page" as const, label: i.label, sub: g.label ?? undefined, href: i.href, icon: i.icon })),
);

interface ProductHit {
  id: string;
  name: string;
  category_name: string | null;
  variants: { sku: string }[];
}
interface CustomerHit {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

export function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const [remote, setRemote] = useState<PaletteItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global shortcut: Cmd/Ctrl+K toggles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRemote([]);
      setActiveIdx(0);
    }
  }, [open]);

  // Remote search (products + customers) once the query is meaningful.
  useEffect(() => {
    if (!open || debounced.trim().length < 2) {
      setRemote([]);
      return;
    }
    const controller = new AbortController();
    const q = encodeURIComponent(debounced.trim());
    (async () => {
      const [productsRes, customersRes] = await Promise.allSettled([
        authFetch(`/api/products?search=${q}&page=1&pageSize=5`, { signal: controller.signal }),
        authFetch(`/api/customers?search=${q}&pageSize=5`, { signal: controller.signal }),
      ]);
      const items: PaletteItem[] = [];
      if (productsRes.status === "fulfilled" && productsRes.value.ok) {
        const d = (await productsRes.value.json().catch(() => null)) as { products?: ProductHit[] } | null;
        for (const p of (d?.products ?? []).slice(0, 5)) {
          items.push({
            kind: "product",
            label: p.name,
            sub: [p.category_name, p.variants?.[0]?.sku].filter(Boolean).join(" · ") || undefined,
            href: `/admin/products?q=${encodeURIComponent(p.name)}`,
            icon: Package,
          });
        }
      }
      if (customersRes.status === "fulfilled" && customersRes.value.ok) {
        const d = (await customersRes.value.json().catch(() => null)) as { customers?: CustomerHit[] } | null;
        for (const c of (d?.customers ?? []).slice(0, 5)) {
          const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || c.phone || "Customer";
          items.push({
            kind: "customer",
            label: name,
            sub: c.email ?? c.phone ?? undefined,
            href: `/admin/customers?q=${encodeURIComponent(c.email ?? name)}`,
            icon: User,
          });
        }
      }
      if (!controller.signal.aborted) setRemote(items);
    })().catch(() => {});
    return () => controller.abort();
  }, [open, debounced]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = q
      ? ALL_PAGES.filter((p) => p.label.toLowerCase().includes(q) || (p.sub ?? "").toLowerCase().includes(q))
      : ALL_PAGES;
    return [...pages.slice(0, 8), ...remote];
  }, [query, remote]);

  // Clamp the active row when results change.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  const go = (item: PaletteItem) => {
    setOpen(false);
    router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && items[activeIdx]) { e.preventDefault(); go(items[activeIdx]); }
  };

  const KIND_LABEL: Record<PaletteItem["kind"], string> = { page: "Page", product: "Product", customer: "Customer" };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Search">
      <button type="button" aria-label="Close search" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
      <div
        className="absolute left-1/2 top-[15vh] w-[640px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--surface-panel)", borderColor: "var(--border-subtle)" }}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-4" style={{ borderColor: "var(--border-subtle)" }}>
          <Search className="h-4 w-4 shrink-0" style={{ color: "var(--text-secondary)" }} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, products, customers…"
            aria-label="Search pages, products, customers"
            className="w-full bg-transparent py-3.5 text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
          <kbd className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
              No matches{query.trim().length < 2 ? "" : " — try a product name, SKU, customer, or page"}.
            </p>
          ) : (
            items.map((item, i) => {
              const Icon = item.icon;
              const active = i === activeIdx;
              return (
                <button
                  key={`${item.kind}:${item.href}:${item.label}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => go(item)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm"
                  style={active ? { background: "var(--surface-accent)", color: "#fff" } : { color: "var(--text-primary)" }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    {item.sub && (
                      <span className="block truncate text-xs" style={active ? { color: "rgba(255,255,255,0.8)" } : { color: "var(--text-secondary)" }}>
                        {item.sub}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                    style={active ? { borderColor: "rgba(255,255,255,0.4)", color: "rgba(255,255,255,0.9)" } : { borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                    {KIND_LABEL[item.kind]}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-4 py-2 text-[11px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          <span>↑↓ navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="h-3 w-3" /> open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
