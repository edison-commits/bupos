'use client';

import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api/client';

interface Candidate {
  productId: string;
  name: string;
  variantCount: number;
  hasImage: boolean;
  minPrice: number;
  maxPrice: number;
}
interface ListResp { connected: boolean; products: Candidate[] }

const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
const priceRange = (lo: number, hi: number) => (lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`);

/** Phase 3c — publish BuPOS products (not yet on Shopify) as Shopify products. */
export function PublishPanel() {
  const [connected, setConnected] = useState(false);
  const [products, setProducts] = useState<Candidate[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch('/api/channels/shopify/publishable');
      if (r.ok) {
        const d = (await r.json()) as ListResp;
        setConnected(d.connected);
        setProducts(d.products);
        setSel(new Set());
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => setSel((s) => (s.size === products.length ? new Set() : new Set(products.map((p) => p.productId))));

  async function publish() {
    if (sel.size === 0) return;
    setBusy(true); setMsg(null);
    try {
      const r = await authFetch('/api/channels/shopify/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [...sel] }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; published?: unknown[]; failed?: { name: string; error: string }[] };
      if (r.ok || d.published) {
        const ok = (d.published ?? []).length;
        const fail = (d.failed ?? []).length;
        const detail = fail ? `, ${fail} failed (${(d.failed ?? []).slice(0, 2).map((f) => `${f.name}: ${f.error}`).join('; ')})` : '';
        setMsg({ kind: fail ? 'err' : 'ok', text: `Published ${ok} product${ok === 1 ? '' : 's'}${detail}.` });
      } else {
        setMsg({ kind: 'err', text: d.error || 'Publish failed' });
      }
      await load();
    } finally { setBusy(false); }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Publish products to Shopify</h2>
        {products.length > 0 && (
          <button onClick={publish} disabled={busy || !connected || sel.size === 0}
            className="px-3 py-1.5 text-sm rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
            {busy ? 'Publishing…' : `Publish selected (${sel.size})`}
          </button>
        )}
      </div>

      {!connected && <p className="text-sm text-amber-700 bg-amber-50 rounded px-3 py-2">Connect a store below first to publish products.</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-gray-500">All active products with SKUs are already on Shopify.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3"><input type="checkbox" aria-label="Select all" checked={sel.size === products.length && products.length > 0} onChange={toggleAll} /></th>
                <th className="py-2 pr-3 font-medium">Product</th>
                <th className="py-2 pr-3 font-medium">Variants</th>
                <th className="py-2 pr-3 font-medium text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.productId} className="border-b border-gray-100">
                  <td className="py-2 pr-3"><input type="checkbox" aria-label={`Select ${p.name}`} checked={sel.has(p.productId)} onChange={() => toggle(p.productId)} /></td>
                  <td className="py-2 pr-3 text-gray-900">{p.name}</td>
                  <td className="py-2 pr-3 text-gray-600">{p.variantCount}</td>
                  <td className="py-2 pr-3 text-right">{priceRange(p.minPrice, p.maxPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg && <div className={`text-sm rounded px-3 py-2 ${msg.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>{msg.text}</div>}
      <p className="text-xs text-gray-400">
        Creates each product on Shopify with its variants (size/color), price, and current stock at your fulfillment location, then lists it on your Online Store.
      </p>
    </div>
  );
}
