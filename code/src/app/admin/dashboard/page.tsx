'use client';


import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api/client';
import { DASHBOARD_POLL_INTERVAL_MS } from '@/lib/config/timing';
import { formatCurrency } from '@/lib/format';
import { safeErr } from "@/lib/logging/safe-err";
import { KpiCard } from "@/components/ui/kpi-card";
// Field names mirror /api/dashboard's response exactly (pg numerics arrive
// as strings — Number() at render). The previous shape drifted from the API
// (hour/sales vs label/total, type vs tender_type, …) which rendered the
// hourly/tender/employee/recent sections blank.
interface Metrics {
  grossSales: number;
  totalDiscounts: number;
  totalTax: number;
  netSales: number;
  transactionCount: number;
  avgTicket: number;
  largestSale: number;
}

interface PreviousMetrics {
  grossSales: number;
  netSales: number;
  transactionCount: number;
  avgTicket: number;
}

interface HourlyData {
  hour: number;
  label: string;
  count: number;
  total: number;
}

interface DailyPoint {
  day: string;
  count: number;
  total: number;
}

interface CategorySlice {
  name: string;
  revenue: number;
}

interface TenderBreakdown {
  tender_type: string;
  total: string | number;
  count: number;
}

interface EmployeePerformance {
  display_name: string;
  total_sales: string | number;
  transaction_count: number;
  avg_ticket: string | number;
}

interface RecentTransaction {
  id: string;
  grand_total: string | number;
  status: string;
  created_at: string;
  employee_name: string | null;
}

interface LowStockAlert {
  product_name: string;
  sku: string | null;
  size: string | null;
  color: string | null;
  on_hand: number;
  reorder_point: number;
}

interface DashboardData {
  metrics: Metrics;
  previousMetrics?: PreviousMetrics;
  dailySeries?: DailyPoint[];
  categoryMix?: CategorySlice[];
  hourlyBreakdown: HourlyData[];
  tenderBreakdown: TenderBreakdown[];
  employeePerformance: EmployeePerformance[];
  recentTransactions: RecentTransaction[];
  lowStockAlerts: LowStockAlert[];
}

/** % change vs the prior period; null when there's no baseline. */
const pctChange = (cur: number, prev: number | undefined): number | null =>
  prev && prev > 0 ? ((cur - prev) / prev) * 100 : null;

type RangeType = 'today' | 'week' | 'month';

export default function DashboardPage() {
  const [range, setRange] = useState<RangeType>('today');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  // `showSpinner` controls whether to swap in the skeleton. Only true on the
  // first fetch; subsequent polls keep the existing data visible to avoid
  // a flash every minute.
  const fetchData = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await authFetch(`/api/dashboard?range=${range}`);
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Failed to fetch dashboard data:', safeErr(error));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    // Only poll while the tab is visible. A backgrounded tab shouldn't hammer
    // the API every minute.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      fetchData(false);
    };
    const interval = setInterval(tick, DASHBOARD_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const rangeButtons: { label: string; value: RangeType }[] = [
    { label: 'Today', value: 'today' },
    { label: 'This Week', value: 'week' },
    { label: 'This Month', value: 'month' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 pt-6">
      <div className="mx-auto max-w-7xl space-y-6 px-8 pb-12">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Sales Dashboard</h1>
            <p className="mt-0.5 text-sm text-gray-500">Performance at a glance</p>
          </div>

          {/* Range Selector — Fluent segmented control */}
          <div className="inline-flex items-center rounded-lg border border-gray-300 bg-white p-0.5 shadow-sm">
            {rangeButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => setRange(btn.value)}
                className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  range === btn.value
                    ? 'bg-teal-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <SkeletonLoader />
        ) : data ? (
          <>
            {/* Top Metrics — with vs-prior-period deltas */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <KpiCard
                label="Net Sales"
                value={formatCurrency(data.metrics.netSales)}
                delta={pctChange(data.metrics.netSales, data.previousMetrics?.netSales)}
                deltaLabel={range === 'today' ? 'vs yesterday' : 'vs prior period'}
              />
              <KpiCard
                label="Transactions"
                value={data.metrics.transactionCount.toString()}
                delta={pctChange(data.metrics.transactionCount, data.previousMetrics?.transactionCount)}
                deltaLabel={range === 'today' ? 'vs yesterday' : 'vs prior period'}
              />
              <KpiCard
                label="Avg Ticket"
                value={formatCurrency(data.metrics.avgTicket)}
                delta={pctChange(data.metrics.avgTicket, data.previousMetrics?.avgTicket)}
                deltaLabel={range === 'today' ? 'vs yesterday' : 'vs prior period'}
              />
              <KpiCard
                label="Largest Sale"
                value={formatCurrency(data.metrics.largestSale)}
              />
            </div>

            {/* Charts Row */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Hourly Sales Chart */}
              <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-base font-semibold text-gray-900">
                  Hourly Sales
                </h2>
                <HourlyChart data={data.hourlyBreakdown} />
              </div>

              {/* Tender Breakdown */}
              <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-base font-semibold text-gray-900">
                  Payment Methods
                </h2>
                <TenderBreakdown data={data.tenderBreakdown} />
              </div>
            </div>

            {/* Trend + Category Mix */}
            {((range !== 'today' && (data.dailySeries?.length ?? 0) > 0) || (data.categoryMix?.length ?? 0) > 0) && (
              <div className="grid gap-6 lg:grid-cols-2">
                {range !== 'today' && (data.dailySeries?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="mb-4 text-base font-semibold text-gray-900">
                      Sales by Day
                    </h2>
                    <DailyChart data={data.dailySeries ?? []} />
                  </div>
                )}
                {(data.categoryMix?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="mb-4 text-base font-semibold text-gray-900">
                      Top Categories
                    </h2>
                    <CategoryMix data={data.categoryMix ?? []} />
                  </div>
                )}
              </div>
            )}

            {/* Employee Performance */}
            <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-base font-semibold text-gray-900">
                Employee Performance
              </h2>
              <EmployeeTable data={data.employeePerformance} />
            </div>

            {/* Recent Transactions */}
            <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-base font-semibold text-gray-900">
                Recent Transactions
              </h2>
              <TransactionList
                data={data.recentTransactions}
                formatCurrency={formatCurrency}
                formatTime={formatTime}
              />
            </div>

            {/* Low Stock Alerts */}
            {data.lowStockAlerts.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-6 shadow-sm border border-amber-200">
                <h2 className="mb-4 text-lg font-semibold text-amber-900">
                  Low Stock Alerts
                </h2>
                <LowStockList data={data.lowStockAlerts} />
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12">
            <p className="text-gray-500">Failed to load dashboard data</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface HourlyChartProps {
  data: HourlyData[];
}

function HourlyChart({ data }: HourlyChartProps) {
  if (data.length === 0) {
    return <p className="text-gray-500 text-sm">No hourly data available</p>;
  }

  const maxSales = Math.max(...data.map((d) => Number(d.total)));

  return (
    <div className="flex items-end gap-2 h-64">
      {data.map((item, idx) => (
        <div key={idx} className="flex-1 flex flex-col items-center gap-2">
          <div className="w-full bg-gray-200 rounded relative group cursor-pointer">
            <div
              className="bg-gradient-to-t from-teal-600 to-teal-400 rounded transition-all"
              style={{
                height: `${maxSales > 0 ? (Number(item.total) / maxSales) * 200 : 0}px`,
                minHeight: Number(item.total) > 0 ? '4px' : '0px',
              }}
            >
              <div className="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap transition-opacity">
                {formatCurrency(Number(item.total), 'USD', { fractionDigits: 0 })}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-600 text-center w-full">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

function DailyChart({ data }: { data: DailyPoint[] }) {
  const max = Math.max(...data.map((d) => Number(d.total)));
  // "Jun 9" labels; show every label up to 10 points, then thin them out.
  const labelEvery = data.length > 20 ? 5 : data.length > 10 ? 2 : 1;
  return (
    <div className="flex items-end gap-1 h-64">
      {data.map((item, idx) => (
        <div key={item.day} className="flex-1 flex flex-col items-center gap-2 min-w-0">
          <div className="w-full bg-gray-200 rounded relative group cursor-pointer">
            <div
              className="bg-gradient-to-t from-teal-600 to-teal-400 rounded transition-all"
              style={{
                height: `${max > 0 ? (Number(item.total) / max) * 200 : 0}px`,
                minHeight: Number(item.total) > 0 ? '4px' : '0px',
              }}
            >
              <div className="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap transition-opacity z-10">
                {item.day}: {formatCurrency(Number(item.total), 'USD', { fractionDigits: 0 })}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-gray-600 text-center w-full truncate">
            {idx % labelEvery === 0
              ? new Date(item.day + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : ' '}
          </p>
        </div>
      ))}
    </div>
  );
}

function CategoryMix({ data }: { data: CategorySlice[] }) {
  const total = data.reduce((sum, c) => sum + Number(c.revenue), 0);
  if (total <= 0) return <p className="text-gray-500 text-sm">No category data available</p>;
  return (
    <div className="space-y-4">
      {data.map((cat) => {
        const pct = (Number(cat.revenue) / total) * 100;
        return (
          <div key={cat.name} className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700">{cat.name}</span>
              <span className="text-gray-600">
                {formatCurrency(Number(cat.revenue))} · {pct.toFixed(0)}%
              </span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded bg-gray-200">
              <div
                className="h-full rounded bg-gradient-to-r from-teal-500 to-emerald-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface TenderBreakdownProps {
  data: TenderBreakdown[];
}

function TenderBreakdown({ data }: TenderBreakdownProps) {
  if (data.length === 0) {
    return <p className="text-gray-500 text-sm">No tender data available</p>;
  }

  const total = data.reduce((sum, item) => sum + Number(item.total), 0);

  return (
    <div className="space-y-4">
      {data.map((item, idx) => {
        const percentage = total > 0 ? (Number(item.total) / total) * 100 : 0;

        return (
          <div key={idx} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium capitalize text-gray-700">{item.tender_type?.replace(/_/g, ' ')}</span>
              <span className="text-sm text-gray-600">
                {item.count} • {percentage.toFixed(0)}%
              </span>
            </div>
            <div className="relative h-8 bg-gray-200 rounded overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 flex items-center justify-center transition-all"
                style={{ width: `${percentage}%` }}
              >
                {percentage > 15 && (
                  <span className="text-xs font-medium text-white">
                    {percentage.toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface EmployeeTableProps {
  data: EmployeePerformance[];
}

function EmployeeTable({ data }: EmployeeTableProps) {
  if (data.length === 0) {
    return <p className="text-gray-500 text-sm">No employee data available</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="px-4 py-3 text-left font-medium text-gray-700">
              Employee
            </th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">
              Sales
            </th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">
              Transactions
            </th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">
              Avg Ticket
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((emp, idx) => (
            <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-900 font-medium">{emp.display_name}</td>
              <td className="px-4 py-3 text-right text-teal-600 font-semibold">
                {formatCurrency(Number(emp.total_sales))}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {emp.transaction_count}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {formatCurrency(Number(emp.avg_ticket))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TransactionListProps {
  data: RecentTransaction[];
  formatCurrency: (value: number) => string;
  formatTime: (dateString: string) => string;
}

function TransactionList({
  data,
  formatCurrency,
  formatTime,
}: TransactionListProps) {
  if (data.length === 0) {
    return <p className="text-gray-500 text-sm">No recent transactions</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="px-4 py-3 text-left font-medium text-gray-700">
              Transaction
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">
              Employee
            </th>
            <th className="px-4 py-3 text-center font-medium text-gray-700">
              Status
            </th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">
              Amount
            </th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((txn, idx) => (
            <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3 font-mono text-gray-900">
                {txn.id.slice(0, 8)}
              </td>
              <td className="px-4 py-3 text-gray-700">{txn.employee_name ?? '—'}</td>
              <td className="px-4 py-3 text-center">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  txn.status === 'completed' ? 'bg-emerald-100 text-emerald-800'
                    : txn.status === 'voided' ? 'bg-red-100 text-red-800'
                    : 'bg-amber-100 text-amber-800'
                }`}>
                  {txn.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-semibold text-teal-600">
                {formatCurrency(Number(txn.grand_total))}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {formatTime(txn.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface LowStockListProps {
  data: LowStockAlert[];
}

function LowStockList({ data }: LowStockListProps) {
  if (data.length === 0) {
    return <p className="text-amber-800 text-sm">No low stock items</p>;
  }

  return (
    <div className="grid gap-3">
      {data.map((alert, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between p-3 bg-white rounded border border-amber-100"
        >
          <div>
            <p className="font-medium text-amber-900">{alert.product_name}</p>
            <p className="text-sm text-amber-700">
              {[alert.sku, [alert.size, alert.color].filter(Boolean).join('/')].filter(Boolean).join(' · ')}
            </p>
          </div>
          <p className="font-bold text-amber-900">
            {alert.on_hand} left <span className="font-normal text-amber-700">(reorder at {alert.reorder_point})</span>
          </p>
        </div>
      ))}
    </div>
  );
}

function SkeletonLoader() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Metrics skeleton */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-gray-200 rounded-lg" />
        ))}
      </div>

      {/* Charts skeleton */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-80 bg-gray-200 rounded-lg" />
        <div className="h-80 bg-gray-200 rounded-lg" />
      </div>

      {/* Tables skeleton */}
      <div className="h-64 bg-gray-200 rounded-lg" />
      <div className="h-64 bg-gray-200 rounded-lg" />
    </div>
  );
}
