'use client';

import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api/client';

interface ConfigStatus {
  connected: boolean;
  status: string;
  provider?: string;
  shop_domain?: string | null;
  fulfillment_location_id?: string | null;
  shopify_location_id?: string | null;
  sync_prices?: boolean;
  last_sync_at?: string | null;
  last_error?: string | null;
  has_token?: boolean;
  has_webhook_secret?: boolean;
}
interface LocationOpt { id: string; name: string }

const REQUIRED_SCOPES = 'read_products, write_products, read_inventory, write_inventory, read_locations, read_orders';

export function ShopifyConnectPanel() {
  const [cfg, setCfg] = useState<ConfigStatus | null>(null);
  const [locations, setLocations] = useState<LocationOpt[]>([]);
  const [shopDomain, setShopDomain] = useState('');
  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [fulfillmentLocationId, setFulfillmentLocationId] = useState('');
  const [syncPrices, setSyncPrices] = useState(true);
  const [actorPassword, setActorPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await authFetch('/api/channels/shopify/config');
      if (r.ok) {
        const data = (await r.json()) as ConfigStatus;
        setCfg(data);
        if (data.shop_domain) setShopDomain(data.shop_domain);
        if (data.fulfillment_location_id) setFulfillmentLocationId(data.fulfillment_location_id);
        if (typeof data.sync_prices === 'boolean') setSyncPrices(data.sync_prices);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadStatus();
    authFetch('/api/locations')
      .then((r) => (r.ok ? r.json() : { locations: [] }))
      .then((d: { locations?: { id: string; name?: string }[] }) =>
        setLocations((d.locations ?? []).filter((l) => l.id).map((l) => ({ id: l.id, name: l.name?.trim() || '(unnamed)' }))))
      .catch(() => {});
  }, [loadStatus]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { shop_domain: shopDomain.trim().toLowerCase(), fulfillment_location_id: fulfillmentLocationId, sync_prices: syncPrices };
      if (token.trim()) body.access_token = token.trim();
      if (webhookSecret.trim()) body.webhook_secret = webhookSecret.trim();
      if (actorPassword) body.actorPassword = actorPassword;
      const r = await authFetch('/api/channels/shopify/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMsg({ kind: 'ok', text: 'Saved. Now run Test connection.' }); setToken(''); setWebhookSecret(''); setActorPassword(''); await loadStatus(); }
      else setMsg({ kind: 'err', text: d.error || 'Save failed' });
    } finally { setBusy(false); }
  }

  async function act(path: string, okText: (d: Record<string, unknown>) => string) {
    setBusy(true); setMsg(null);
    try {
      const r = await authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMsg({ kind: 'ok', text: okText(d) });
      else setMsg({ kind: 'err', text: (d.error as string) || 'Failed' });
      await loadStatus();
    } finally { setBusy(false); }
  }

  const statusColor = cfg?.status === 'connected' ? 'text-green-700 bg-green-100'
    : cfg?.status === 'error' ? 'text-red-700 bg-red-100' : 'text-gray-600 bg-gray-100';

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Shopify connection</h2>
          <span className={`text-xs font-medium px-2 py-1 rounded ${statusColor}`}>{cfg?.status ?? 'loading…'}</span>
        </div>
        {cfg?.shop_domain && <p className="text-sm text-gray-600 mt-2">Store: <span className="font-mono">{cfg.shop_domain}</span></p>}
        {cfg?.last_sync_at && <p className="text-sm text-gray-500">Last inventory sync: {new Date(cfg.last_sync_at).toLocaleString()}</p>}
        {cfg?.last_error && <p className="text-sm text-red-600 mt-1">Last error: {cfg.last_error}</p>}
        {cfg?.connected && (
          <div className="flex gap-2 mt-4">
            <button onClick={() => act('/api/channels/shopify/test-connection', () => 'Connection OK.')} disabled={busy}
              className="px-3 py-1.5 text-sm rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-50">Test connection</button>
            <button onClick={() => act('/api/channels/shopify/sync-inventory', (d) => {
              const p = (d.push as { pushed?: number }) ?? {}; const m = (d.map as { mapped?: number; unresolved?: number }) ?? {};
              const pr = (d.price as { pushed?: number } | null);
              return `Synced. Inventory ${p.pushed ?? 0}${pr ? `, prices ${pr.pushed ?? 0}` : ''}, newly mapped ${m.mapped ?? 0}, unresolved ${m.unresolved ?? 0}.`;
            })} disabled={busy}
              className="px-3 py-1.5 text-sm rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">Sync inventory now</button>
          </div>
        )}
      </div>

      {/* Connect / update form */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold text-gray-900">{cfg?.connected ? 'Update connection' : 'Connect a store'}</h2>
        <p className="text-xs text-gray-500">
          In Shopify, create a <strong>custom app</strong> with scopes: <span className="font-mono">{REQUIRED_SCOPES}</span>.
          Paste its Admin API access token and API secret below. The token is encrypted and never shown again.
        </p>
        <label className="block text-sm">
          <span className="text-gray-700">Shop domain</span>
          <input value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="your-store.myshopify.com"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Admin API access token {cfg?.has_token && <span className="text-gray-400">(stored — leave blank to keep)</span>}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" placeholder="shpat_…"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Webhook signing secret {cfg?.has_webhook_secret && <span className="text-gray-400">(stored — leave blank to keep)</span>}</span>
          <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="new-password" placeholder="app API secret"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Fulfillment location (online orders draw from here)</span>
          <select value={fulfillmentLocationId} onChange={(e) => setFulfillmentLocationId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm">
            <option value="">Select a location…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={syncPrices} onChange={(e) => setSyncPrices(e.target.checked)} className="rounded" />
          <span className="text-gray-700">Push prices to Shopify (BuPOS is authoritative)</span>
        </label>
        {(token.trim() || webhookSecret.trim()) && (
          <label className="block text-sm">
            <span className="text-gray-700">Your password (required to save a new token)</span>
            <input type="password" value={actorPassword} onChange={(e) => setActorPassword(e.target.value)} autoComplete="off"
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm" />
          </label>
        )}
        <button onClick={save} disabled={busy || !shopDomain.trim() || !fulfillmentLocationId}
          className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {msg && (
        <div className={`text-sm rounded px-3 py-2 ${msg.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>{msg.text}</div>
      )}
    </div>
  );
}
