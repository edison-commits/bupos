'use client';

import type { LocalStoreData } from '@/lib/persistence/types';
import { useState, useMemo } from 'react';

type DateRange = 'today' | 'week' | 'month' | 'custom';

interface LocationMetrics {
  locationId: string;
  locationName: string;
  grossSales: number;
  netSales: number;
  transactionCount: number;
  returnCount: number;
  returnAmount: number;
  avgTicket: number;
  inventoryRetailValue: number;
  inventoryCostValue: number;
  staffCount: number;
  shiftsClosedCount: number;
  cashVariance: number;
  lowStockItemCount: number;
  margin: number;
}

export function MultiLocationDashboard({ store }: { store: LocalStoreData }) {
  const [selectedLocations, setSelectedLocations] = useState<Set<string>>(
    new Set(store.locations.map((l) => l.id))
  );
  const [dateRange, setDateRange] = useState<DateRange>('today');
  const [rankingMetric, setRankingMetric] = useState<keyof LocationMetrics>('grossSales');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const getDateRange = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (dateRange === 'custom') {
      return { start: new Date(customStart), end: new Date(customEnd) };
    }
    if (dateRange === 'today') {
      return { start: today, end: new Date(today.getTime() + 86400000) };
    }
    if (dateRange === 'week') {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      return { start: weekStart, end: new Date(now.getTime() + 86400000) };
    }
    if (dateRange === 'month') {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: monthStart, end: new Date(now.getTime() + 86400000) };
    }
    return { start: today, end: new Date(today.getTime() + 86400000) };
  };

  const metrics = useMemo(() => {
    const { start, end } = getDateRange();
    const locationMetrics: Record<string, LocationMetrics> = {};

    for (const location of store.locations) {
      const locationId = location.id;
      let grossSales = 0;
      let returnAmount = 0;
      let transactionCount = 0;
      let returnCount = 0;

      for (const event of store.transactionEventPlaceholders) {
        const createdAt = new Date(event.createdAt);
        if (createdAt < start || createdAt >= end) continue;

        const transaction = store.transactionEventPlaceholders.find(
          (t) => t.transactionId === event.transactionId
        );
        if (transaction?.eventKind === 'transaction_placeholder' && transaction.payload?.grand_total) {
          const amount = parseFloat(transaction.payload.grand_total);
          if (transaction.payload.is_return === 'true') {
            returnAmount += amount;
            returnCount++;
          } else {
            grossSales += amount;
            transactionCount++;
          }
        }
      }

      const staffAssigned = store.employees.filter((e) =>
        e.locationIds.includes(locationId)
      ).length;

      const shiftsClosedInPeriod = store.shifts.filter((s) => {
        if (s.locationId !== locationId) return false;
        if (!s.closedAt) return false;
        const closedAt = new Date(s.closedAt);
        return closedAt >= start && closedAt < end;
      }).length;

      const shiftsWithVariance = store.shifts.filter((s) => {
        if (s.locationId !== locationId) return false;
        if (!s.closedAt) return false;
        const closedAt = new Date(s.closedAt);
        return closedAt >= start && closedAt < end;
      });
      
      const cashVariance = shiftsWithVariance.reduce((sum, s) => {
        return sum + (s.closingVariance ?? 0);
      }, 0);

      const inventoryAtLocation = store.inventory.filter((i) => i.locationId === locationId);
      let inventoryRetailValue = 0;
      let inventoryCostValue = 0;
      let lowStockCount = 0;

      for (const item of inventoryAtLocation) {
        const variant = store.variants.find((v) => v.id === item.productVariantId);
        if (!variant) continue;

        const available = item.onHand - item.reserved;
        inventoryRetailValue += available * (variant.price ?? 0);
        inventoryCostValue += available * (variant.cost ?? 0);

        if (available <= item.reorderPoint) {
          lowStockCount++;
        }
      }

      const netSales = grossSales - returnAmount;
      const avgTicket = transactionCount > 0 ? netSales / transactionCount : 0;
      const margin = netSales > 0 ? ((netSales - inventoryCostValue) / netSales) * 100 : 0;

      locationMetrics[locationId] = {
        locationId,
        locationName: location.name,
        grossSales,
        netSales,
        transactionCount,
        returnCount,
        returnAmount,
        avgTicket,
        inventoryRetailValue,
        inventoryCostValue,
        staffCount: staffAssigned,
        shiftsClosedCount: shiftsClosedInPeriod,
        cashVariance,
        lowStockItemCount: lowStockCount,
        margin,
      };
    }

    return locationMetrics;
  }, [store, dateRange, customStart, customEnd]);

  const selectedMetrics = Object.values(metrics).filter((m) =>
    selectedLocations.has(m.locationId)
  );

  const rankedMetrics = [...selectedMetrics].sort((a, b) => {
    const aVal = typeof a[rankingMetric] === 'number' ? (a[rankingMetric] as number) : 0;
    const bVal = typeof b[rankingMetric] === 'number' ? (b[rankingMetric] as number) : 0;
    return bVal - aVal;
  });

  const maxRankValue = rankedMetrics[0]?.[rankingMetric as keyof LocationMetrics] ?? 100;

  const generateInsight = () => {
    if (selectedMetrics.length === 0) return '';
    if (selectedMetrics.length === 1) {
      const m = selectedMetrics[0];
      const flags: string[] = [];
      if (m.returnCount > m.transactionCount * 0.1) flags.push('high return rate');
      if (m.lowStockItemCount > 5) flags.push(`${m.lowStockItemCount} low-stock items`);
      if (Math.abs(m.cashVariance) > 100) flags.push('notable cash variance');
      return flags.length > 0
        ? `${m.locationName}: Watch for ${flags.join(', ')}`
        : `${m.locationName} performing steadily`;
    }

    const leader = rankedMetrics[0];
    const secondPlace = rankedMetrics[1];
    const metricLabel = rankingMetric === 'grossSales' ? 'sales' : rankingMetric;
    const diff = ((leader[rankingMetric as keyof LocationMetrics] as number) - 
                  (secondPlace[rankingMetric as keyof LocationMetrics] as number)) as number;
    const pctDiff = ((diff / (secondPlace[rankingMetric as keyof LocationMetrics] as number)) * 100).toFixed(0);
    return `${leader.locationName} leads in ${metricLabel} by ${pctDiff}%`;
  };

  return (
    <div className="space-y-6 p-6">
      <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200">
        <h1 className="text-2xl font-bold text-zinc-900 mb-6">Multi-Location Dashboard</h1>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <h3 className="text-sm font-semibold text-zinc-700 mb-3">Locations</h3>
            <div className="space-y-2">
              {store.locations.map((loc) => (
                <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedLocations.has(loc.id)}
                    onChange={(e) => {
                      const updated = new Set(selectedLocations);
                      if (e.target.checked) {
                        updated.add(loc.id);
                      } else {
                        updated.delete(loc.id);
                      }
                      setSelectedLocations(updated);
                    }}
                    className="w-4 h-4 rounded border-zinc-300"
                  />
                  <span className="text-sm text-zinc-700">{loc.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-zinc-700 mb-3">Period</h3>
            <div className="space-y-2">
              {(['today', 'week', 'month'] as const).map((period) => (
                <label key={period} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="period"
                    value={period}
                    checked={dateRange === period}
                    onChange={() => setDateRange(period)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-zinc-700 capitalize">{period}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="period"
                  value="custom"
                  checked={dateRange === 'custom'}
                  onChange={() => setDateRange('custom')}
                  className="w-4 h-4"
                />
                <span className="text-sm text-zinc-700">Custom</span>
              </label>
              {dateRange === 'custom' && (
                <div className="ml-6 space-y-2">
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="block w-full px-2 py-1 text-sm border border-zinc-300 rounded"
                  />
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="block w-full px-2 py-1 text-sm border border-zinc-300 rounded"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {generateInsight() && (
          <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 text-sm text-teal-800">
            {generateInsight()}
          </div>
        )}
      </div>

      {selectedMetrics.length === 0 ? (
        <div className="bg-zinc-50 rounded-2xl p-8 text-center text-zinc-500">
          Select at least one location to view metrics
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {selectedMetrics.map((m) => (
              <div key={m.locationId} className="bg-white rounded-2xl border border-zinc-200 p-6">
                <h2 className="text-lg font-bold text-zinc-900 mb-4">{m.locationName}</h2>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-zinc-600 text-xs">Gross Sales</div>
                    <div className="text-xl font-semibold text-zinc-900">
                      ${m.grossSales.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Net Sales</div>
                    <div className="text-xl font-semibold text-zinc-900">
                      ${m.netSales.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Transactions</div>
                    <div className="text-lg font-semibold text-zinc-900">{m.transactionCount}</div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Avg Ticket</div>
                    <div className="text-lg font-semibold text-zinc-900">
                      ${m.avgTicket.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Returns</div>
                    <div className="text-lg font-semibold text-zinc-900">
                      {m.returnCount} (${m.returnAmount.toFixed(2)})
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Margin %</div>
                    <div className="text-lg font-semibold text-zinc-900">{m.margin.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Inventory Value</div>
                    <div className="text-lg font-semibold text-zinc-900">
                      ${m.inventoryRetailValue.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Staff / Shifts</div>
                    <div className="text-lg font-semibold text-zinc-900">
                      {m.staffCount} / {m.shiftsClosedCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Cash Variance</div>
                    <div
                      className={`text-lg font-semibold ${
                        Math.abs(m.cashVariance) > 50 ? 'text-red-600' : 'text-zinc-900'
                      }`}
                    >
                      ${m.cashVariance.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-600 text-xs">Low Stock Items</div>
                    <div
                      className={`text-lg font-semibold ${
                        m.lowStockItemCount > 5 ? 'text-amber-600' : 'text-zinc-900'
                      }`}
                    >
                      {m.lowStockItemCount}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200 p-6">
            <h2 className="text-lg font-bold text-zinc-900 mb-4">Ranking by Metric</h2>
            <div className="mb-4">
              <select
                value={rankingMetric}
                onChange={(e) => setRankingMetric(e.target.value as keyof LocationMetrics)}
                className="px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-700 bg-white"
              >
                <option value="grossSales">Gross Sales</option>
                <option value="netSales">Net Sales</option>
                <option value="transactionCount">Transactions</option>
                <option value="avgTicket">Avg Ticket</option>
                <option value="margin">Margin %</option>
                <option value="inventoryRetailValue">Inventory Value</option>
              </select>
            </div>
            <div className="space-y-4">
              {rankedMetrics.map((m, idx) => {
                const val = Number(m[rankingMetric as keyof LocationMetrics]) || 0;
                const pct = Number(maxRankValue) > 0 ? (val / Number(maxRankValue)) * 100 : 0;
                return (
                  <div key={m.locationId}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium text-zinc-900">
                        {idx + 1}. {m.locationName}
                      </span>
                      <span className="text-sm font-semibold text-zinc-700">
                        {rankingMetric === 'margin' ? `${(val as number).toFixed(1)}%` : `$${(val as number).toFixed(2)}`}
                      </span>
                    </div>
                    <div className="w-full bg-zinc-200 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-teal-700 h-full rounded-full transition-all"
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl border border-zinc-200 p-6">
              <h3 className="text-lg font-bold text-zinc-900 mb-4">Sales by Location</h3>
              <div className="space-y-3">
                {selectedMetrics
                  .sort((a, b) => b.netSales - a.netSales)
                  .map((m) => {
                    const maxSales = Math.max(...selectedMetrics.map((x) => x.netSales));
                    const pct = maxSales > 0 ? (m.netSales / maxSales) * 100 : 0;
                    return (
                      <div key={m.locationId}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium text-zinc-700">{m.locationName}</span>
                          <span className="text-zinc-600">${m.netSales.toFixed(2)}</span>
                        </div>
                        <div className="w-full bg-zinc-200 rounded-full h-3 overflow-hidden">
                          <div
                            className="bg-teal-700 h-full rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-zinc-200 p-6">
              <h3 className="text-lg font-bold text-zinc-900 mb-4">Staff Distribution</h3>
              <div className="space-y-3">
                {selectedMetrics
                  .sort((a, b) => b.staffCount - a.staffCount)
                  .map((m) => {
                    const maxStaff = Math.max(...selectedMetrics.map((x) => x.staffCount));
                    const pct = maxStaff > 0 ? (m.staffCount / maxStaff) * 100 : 0;
                    return (
                      <div key={m.locationId}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium text-zinc-700">{m.locationName}</span>
                          <span className="text-zinc-600">{m.staffCount} staff</span>
                        </div>
                        <div className="w-full bg-zinc-200 rounded-full h-3 overflow-hidden">
                          <div
                            className="bg-teal-700 h-full rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200 p-6">
            <h3 className="text-lg font-bold text-zinc-900 mb-4">Inventory Health</h3>
            <div className="space-y-3">
              {selectedMetrics
                .sort((a, b) => b.lowStockItemCount - a.lowStockItemCount)
                .map((m) => {
                  const maxLow = Math.max(...selectedMetrics.map((x) => x.lowStockItemCount));
                  const pct = maxLow > 0 ? (m.lowStockItemCount / maxLow) * 100 : 0;
                  return (
                    <div key={m.locationId}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium text-zinc-700">{m.locationName}</span>
                        <span className={`font-semibold ${m.lowStockItemCount > 5 ? 'text-amber-600' : 'text-zinc-600'}`}>
                          {m.lowStockItemCount} low stock
                        </span>
                      </div>
                      <div className="w-full bg-zinc-200 rounded-full h-3 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${m.lowStockItemCount > 5 ? 'bg-amber-500' : 'bg-teal-700'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
