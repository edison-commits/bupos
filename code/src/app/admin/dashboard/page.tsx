'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api/client';
import { DASHBOARD_POLL_INTERVAL_MS } from '@/lib/config/timing';
import { formatCurrency } from '@/lib/format';
import { safeErr } from "@/lib/logging/safe-err";
interface Metrics {
  grossSales: number;
  discounts: number;
  tax: number;
  netSales: number;
  transactionCount: number;
  avgTicket: number;
  largestSale: number;
}

interface HourlyData {
  hour: string;
  sales: number;
  count: number;
}

interface TenderBreakdown {
  type: string;
  total: number;
  count: number;
}

interface EmployeePerformance {
  name: string;
  sales: number;
  count: number;
  avgTicket: number;
}

interface RecentTransaction {
  id: string;
  total: number;
  status: string;
  created_at: string;
  employee_name: string;
  item_count: number;
}

interface LowStockAlert {
  product_name: string;
  variant_label: string;
  quantity: number;
}

interface DashboardData {
  metrics: Metrics;
  hourlyBreakdown: HourlyData[];
  tenderBreakdown: TenderBreakdown[];
  employeePerformance: EmployeePerformance[];
  recentTransactions: RecentTransaction[];
  lowStockAlerts: LowStockAlert[];
}

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
        <AdminTopNav />
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">Sales Dashboard</h1>

          {/* Range Selector */}
          <div className="flex gap-2">
            {rangeButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => setRange(btn.value)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  range === btn.value
                    ? 'bg-teal-600 text-white'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
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
            {/* Top Metrics */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <MetricCard
                label="Net Sales"
                value={formatCurrency(data.metrics.netSales)}
                Icon={undefined}
              />
              <MetricCard
                label="Transactions"
                value={data.metrics.transactionCount.toString()}
                Icon={undefined}
              />
              <MetricCard
                label="Avg Ticket"
                value={formatCurrency(data.metrics.avgTicket)}
                Icon={undefined}
              />
              <MetricCard
                label="Largest Sale"
                value={formatCurrency(data.metrics.largestSale)}
                Icon={undefined}
              />
            </div>

            {/* Charts Row */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Hourly Sales Chart */}
              <div className="rounded-lg bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold text-gray-900">
                  Hourly Sales
                </h2>
                <HourlyChart data={data.hourlyBreakdown} />
              </div>

              {/* Tender Breakdown */}
              <div className="rounded-lg bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold text-gray-900">
                  Payment Methods
                </h2>
                <TenderBreakdown data={data.tenderBreakdown} />
              </div>
            </div>

            {/* Employee Performance */}
            <div className="rounded-lg bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900">
                Employee Performance
              </h2>
              <EmployeeTable data={data.employeePerformance} />
            </div>

            {/* Recent Transactions */}
            <div className="rounded-lg bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900">
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

interface MetricCardProps {
  label: string;
  value: string;
  Icon?: React.ComponentType<{ className?: string }>;
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="rounded-lg bg-white p-6 shadow-sm border border-gray-200">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-2 text-2xl font-bold text-teal-600">{value}</p>
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

  const maxSales = Math.max(...data.map((d) => d.sales));

  return (
    <div className="flex items-end gap-2 h-64">
      {data.map((item, idx) => (
        <div key={idx} className="flex-1 flex flex-col items-center gap-2">
          <div className="w-full bg-gray-200 rounded relative group cursor-pointer">
            <div
              className="bg-gradient-to-t from-teal-600 to-teal-400 rounded transition-all"
              style={{
                height: `${(item.sales / maxSales) * 200}px`,
                minHeight: item.sales > 0 ? '4px' : '0px',
              }}
            >
              <div className="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap transition-opacity">
                {formatCurrency(item.sales, 'USD', { fractionDigits: 0 })}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-600 text-center w-full">{item.hour}</p>
        </div>
      ))}
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

  const total = data.reduce((sum, item) => sum + item.total, 0);

  return (
    <div className="space-y-4">
      {data.map((item, idx) => {
        const percentage = total > 0 ? (item.total / total) * 100 : 0;

        return (
          <div key={idx} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">{item.type}</span>
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
              <td className="px-4 py-3 text-gray-900 font-medium">{emp.name}</td>
              <td className="px-4 py-3 text-right text-teal-600 font-semibold">
                {formatCurrency(emp.sales)}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {emp.count}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {formatCurrency(emp.avgTicket)}
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
              Items
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
              <td className="px-4 py-3 text-gray-700">{txn.employee_name}</td>
              <td className="px-4 py-3 text-center text-gray-600">
                {txn.item_count}
              </td>
              <td className="px-4 py-3 text-right font-semibold text-teal-600">
                {formatCurrency(txn.total)}
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
            <p className="text-sm text-amber-700">{alert.variant_label}</p>
          </div>
          <p className="font-bold text-amber-900">
            {alert.quantity} units
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
