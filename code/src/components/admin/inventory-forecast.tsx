'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/api/client';
import { csvCell } from '@/lib/format/csv-sanitize';

type StockoutRisk = 'critical' | 'soon' | 'watch' | 'healthy' | 'unknown';
type RiskFilter = StockoutRisk | 'all';

interface ForecastRow {
  locationId: string;
  locationName: string;
  productName: string;
  variantName: string | null;
  sku: string;
  sizeLabel: string | null;
  colorLabel: string | null;
  supplierName: string | null;
  onHand: number;
  reorderPoint: number;
  unitsSold30: number;
  unitsSold90: number;
  unitsSold365: number;
  predictedDailyDemand: number;
  daysUntilStockout: number | null;
  risk: StockoutRisk;
  suggestedReorderQty: number;
  confidence: 'high' | 'medium' | 'low';
}

interface ForecastResponse {
  rows: ForecastRow[];
  summary: Record<StockoutRisk, number>;
}

const RISK_LABELS: Record<RiskFilter, string> = {
  all: 'All risks',
  critical: 'Critical',
  soon: 'Soon',
  watch: 'Watch',
  healthy: 'Healthy',
  unknown: 'Unknown',
};

const RISK_BADGES: Record<StockoutRisk, string> = {
  critical: 'bg-red-100 text-red-800',
  soon: 'bg-orange-100 text-orange-800',
  watch: 'bg-amber-100 text-amber-800',
  healthy: 'bg-emerald-100 text-emerald-800',
  unknown: 'bg-zinc-100 text-zinc-700',
};

function daysLabel(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'Now';
  return `${days.toFixed(days < 10 ? 1 : 0)} days`;
}

function variantDescription(row: ForecastRow): string {
  const parts = [row.variantName, row.sizeLabel, row.colorLabel].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'Default variant';
}

function forecastToCSV(rows: ForecastRow[]): string {
  let csv = 'Risk,Store,Product,Variant,SKU,Supplier,On Hand,Reorder Point,30d Sold,90d Sold,365d Sold,Daily Demand,Days Until Stockout,Suggested Reorder,Confidence\n';
  rows.forEach((row) => {
    csv += [
      csvCell(row.risk),
      csvCell(row.locationName),
      csvCell(row.productName),
      csvCell(variantDescription(row)),
      csvCell(row.sku),
      csvCell(row.supplierName ?? 'No supplier'),
      csvCell(row.onHand),
      csvCell(row.reorderPoint),
      csvCell(row.unitsSold30),
      csvCell(row.unitsSold90),
      csvCell(row.unitsSold365),
      csvCell(row.predictedDailyDemand.toFixed(2)),
      csvCell(row.daysUntilStockout == null ? '' : row.daysUntilStockout.toFixed(2)),
      csvCell(row.suggestedReorderQty),
      csvCell(row.confidence),
    ].join(',') + '\n';
  });
  return csv;
}

export function InventoryForecast() {
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [risk, setRisk] = useState<RiskFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchForecast = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/inventory/forecast?location=all&risk=${risk}&limit=100`);
      if (!response.ok) throw new Error('Failed to load inventory forecast');
      setData(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory forecast');
    } finally {
      setLoading(false);
    }
  }, [risk]);

  useEffect(() => {
    fetchForecast();
  }, [fetchForecast]);

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? { critical: 0, soon: 0, watch: 0, healthy: 0, unknown: 0 };

  const exportCSV = () => {
    const blob = new Blob([forecastToCSV(rows)], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-forecast-${risk}.csv`;
    a.click();
    requestAnimationFrame(() => window.URL.revokeObjectURL(url));
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-zinc-50 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Inventory Forecast</h2>
            <p className="text-sm text-zinc-500">Predicts stockout risk from 30/90/365-day sales velocity.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-zinc-500">Risk</span>
              <select
                value={risk}
                onChange={(e) => setRisk(e.target.value as RiskFilter)}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
              >
                {Object.entries(RISK_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button
              onClick={exportCSV}
              disabled={rows.length === 0}
              className="self-end rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <SummaryCard label="Critical" value={summary.critical} tone="text-red-700 bg-red-50" />
        <SummaryCard label="Soon" value={summary.soon} tone="text-orange-700 bg-orange-50" />
        <SummaryCard label="Watch" value={summary.watch} tone="text-amber-700 bg-amber-50" />
        <SummaryCard label="Healthy" value={summary.healthy} tone="text-emerald-700 bg-emerald-50" />
        <SummaryCard label="Unknown" value={summary.unknown} tone="text-zinc-700 bg-zinc-50" />
      </div>

      {loading ? (
        <div className="rounded-xl border border-zinc-200 p-8 text-center text-zinc-500">Loading forecast...</div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Risk</th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Store</th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Product</th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Supplier</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">On Hand</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">30d</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">90d</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">365d</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Daily</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Stockout</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Order Qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-zinc-500">No forecast rows match this filter.</td>
                </tr>
              ) : rows.map((row) => (
                <tr key={`${row.locationId}-${row.sku}`} className="border-b border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${RISK_BADGES[row.risk]}`}>{RISK_LABELS[row.risk]}</span>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{row.locationName}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-900">{row.productName}</div>
                    <div className="text-xs text-zinc-500">{variantDescription(row)} · {row.sku}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{row.supplierName ?? 'No supplier'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-zinc-900">{row.onHand}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{row.unitsSold30}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{row.unitsSold90}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{row.unitsSold365}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{row.predictedDailyDemand.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{daysLabel(row.daysUntilStockout)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-teal-700">{row.suggestedReorderQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-zinc-500">Forecast v1 is a transparent heuristic, not ML: 50% last 30 days, 30% last 90 days, 20% last 365 days, with 14-day lead time and 14-day safety stock.</p>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 p-4 ${tone}`}>
      <p className="text-xs font-medium uppercase">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
