'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { formatCurrency } from "@/lib/format";
import { TrendingUp, TrendingDown, BarChart3, Users } from 'lucide-react';import {
  Employee,
  TransactionEventPlaceholder,
  TransactionTenderPlaceholder,
  ShiftRecord,
  TimeClockEntry,
  TransactionExceptionPlaceholder,
} from '@/lib/domain/types';

interface EmployeePerformanceProps {
  employees: Employee[];
  transactions: TransactionEventPlaceholder[];
  tenders: TransactionTenderPlaceholder[];
  shifts: ShiftRecord[];
  timeClockEntries: TimeClockEntry[];
  exceptions: TransactionExceptionPlaceholder[];
}

type DateRange = 'today' | 'week' | 'month' | 'custom';
type SortMetric = 'sales' | 'transactions' | 'avg_transaction' | 'sales_per_hour' | 'variance';

interface PerformanceMetrics {
  employeeId: string;
  employeeName: string;
  totalSales: number;
  transactionCount: number;
  averageTransaction: number;
  salesPerHour: number;
  voidReturnRate: number;
  exceptionCount: number;
  cashVariance: number;
  hoursWorked: number;
}

interface ComparisonEmployee {
  id: string;
  name: string;
}

export function EmployeePerformance({
  employees,
  transactions,
  tenders,
  shifts,
  timeClockEntries,
  exceptions,
}: EmployeePerformanceProps) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRange>('month');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [sortMetric, setSortMetric] = useState<SortMetric>('sales');
  const [comparisonEmployees, setComparisonEmployees] = useState<ComparisonEmployee[]>([]);

  // Helper: Get date range
  const getDateRange = (): [Date, Date] => {
    const today = new Date();
    let start = new Date();

    switch (dateRange) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(today.getDate() - today.getDay());
        start.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'custom':
        start = customStartDate ? new Date(customStartDate) : new Date(0);
        break;
    }

    const end = dateRange === 'custom' && customEndDate ? new Date(customEndDate) : today;
    end.setHours(23, 59, 59, 999);

    return [start, end];
  };

  // Helper: Calculate metrics for a specific employee
  const calculateMetrics = useCallback((employeeId: string, startDate: Date, endDate: Date): PerformanceMetrics => {
    const employee = employees.find((e) => e.id === employeeId);
    if (!employee) {
      return {
        employeeId,
        employeeName: 'Unknown',
        totalSales: 0,
        transactionCount: 0,
        averageTransaction: 0,
        salesPerHour: 0,
        voidReturnRate: 0,
        exceptionCount: 0,
        cashVariance: 0,
        hoursWorked: 0,
      };
    }

    // Filter transactions and tenders by date and employee
    const employeeTransactions = transactions.filter(
      (t) =>
        t.actorEmployeeId === employeeId &&
        new Date(t.createdAt) >= startDate &&
        new Date(t.createdAt) <= endDate,
    );

    const transactionIds = new Set(employeeTransactions.map((t) => t.transactionId));

    const employeeTenders = tenders.filter((t) => transactionIds.has(t.transactionId));
    const totalSales = employeeTenders.reduce((sum, t) => sum + t.amount, 0);

    // Void/return rate
    const voidReturnEvents = employeeTransactions.filter((t) =>
      ['void', 'return', 'adjustment'].includes(t.eventKind),
    ).length;
    const voidReturnRate = employeeTransactions.length > 0 ? (voidReturnEvents / employeeTransactions.length) * 100 : 0;

    // Exception count
    const employeeExceptions = exceptions.filter(
      (e) =>
        transactionIds.has(e.transactionId) &&
        (!e.resolvedAt || new Date(e.resolvedAt) >= startDate),
    ).length;

    // Cash variance from shifts
    const employeeShifts = shifts.filter(
      (s) =>
        s.employeeId === employeeId &&
        new Date(s.openedAt) >= startDate &&
        new Date(s.openedAt) <= endDate,
    );
    const cashVariance = employeeShifts.reduce((sum, s) => sum + (s.closingVariance || 0), 0);

    // Hours worked from time clock entries
    const employeeTimeClocks = timeClockEntries.filter(
      (t) =>
        t.employeeId === employeeId &&
        new Date(t.createdAt) >= startDate &&
        new Date(t.createdAt) <= endDate,
    );

    let hoursWorked = 0;
    for (let i = 0; i < employeeTimeClocks.length; i += 2) {
      const clockIn = employeeTimeClocks[i];
      const clockOut = employeeTimeClocks[i + 1];

      if (clockIn && clockOut && clockIn.eventType === 'clock_in' && clockOut.eventType === 'clock_out') {
        const inTime = new Date(clockIn.createdAt).getTime();
        const outTime = new Date(clockOut.createdAt).getTime();
        hoursWorked += (outTime - inTime) / (1000 * 60 * 60);
      }
    }

    const uniqueTransactions = new Set(employeeTransactions.map((t) => t.transactionId)).size;
    const averageTransaction = uniqueTransactions > 0 ? totalSales / uniqueTransactions : 0;
    const salesPerHour = hoursWorked > 0 ? totalSales / hoursWorked : 0;

    return {
      employeeId,
      employeeName: employee.displayName || `${employee.firstName} ${employee.lastName}`,
      totalSales,
      transactionCount: uniqueTransactions,
      averageTransaction,
      salesPerHour,
      voidReturnRate,
      exceptionCount: employeeExceptions,
      cashVariance,
      hoursWorked,
    };
  }, [employees, transactions, tenders, shifts, timeClockEntries, exceptions]);

  const [startDate, endDate] = getDateRange();

  // Calculate metrics for all employees
  const allMetrics = useMemo(
    () =>
      employees
        .filter((e) => e.isActive !== false)
        .map((e) => calculateMetrics(e.id, startDate, endDate)),
    [calculateMetrics, employees, startDate, endDate],
  );

  // Filter for selected employee
  const filteredMetrics =
    selectedEmployeeId === 'all'
      ? allMetrics
      : allMetrics.filter((m) => m.employeeId === selectedEmployeeId);

  // Sort metrics
  const sortedMetrics = useMemo(() => {
    const sorted = [...filteredMetrics];
    sorted.sort((a, b) => {
      const aValue =
        sortMetric === 'sales'
          ? a.totalSales
          : sortMetric === 'transactions'
            ? a.transactionCount
            : sortMetric === 'avg_transaction'
              ? a.averageTransaction
              : sortMetric === 'sales_per_hour'
                ? a.salesPerHour
                : a.cashVariance;

      const bValue =
        sortMetric === 'sales'
          ? b.totalSales
          : sortMetric === 'transactions'
            ? b.transactionCount
            : sortMetric === 'avg_transaction'
              ? b.averageTransaction
              : sortMetric === 'sales_per_hour'
                ? b.salesPerHour
                : b.cashVariance;

      return bValue - aValue;
    });
    return sorted;
  }, [filteredMetrics, sortMetric]);

  // Get performance indicator color
  const getPerformanceColor = (metric: SortMetric, value: number, allValues: number[]): string => {
    if (allValues.length === 0) return 'text-zinc-500';

    const avg = allValues.reduce((a, b) => a + b, 0) / allValues.length;
    const stdDev = Math.sqrt(allValues.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / allValues.length);

    // For cash variance, negative is worse
    if (metric === 'variance') {
      if (value > avg - stdDev * 0.5) return 'text-green-600';
      if (value > avg - stdDev) return 'text-amber-600';
      return 'text-red-600';
    }

    // For other metrics, higher is better
    if (value > avg + stdDev * 0.5) return 'text-green-600';
    if (value > avg - stdDev * 0.5) return 'text-amber-600';
    return 'text-red-600';
  };

  const currentMetric = sortedMetrics[0];
  const comparisonMetrics = comparisonEmployees
    .map((ce) => filteredMetrics.find((m) => m.employeeId === ce.id))
    .filter((m): m is PerformanceMetrics => m !== undefined);

  const toggleComparison = (employeeId: string, employeeName: string) => {
    const existing = comparisonEmployees.find((e) => e.id === employeeId);
    if (existing) {
      setComparisonEmployees(comparisonEmployees.filter((e) => e.id !== employeeId));
    } else if (comparisonEmployees.length < 2) {
      setComparisonEmployees([...comparisonEmployees, { id: employeeId, name: employeeName }]);
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-8 w-8 text-zinc-700" />
          <h1 className="text-2xl font-bold text-zinc-900">Employee Performance</h1>
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-4 rounded-2xl bg-zinc-50 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {/* Employee Selector */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-2">Employee</label>
            <select
              value={selectedEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
              className="touch-button w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 appearance-none cursor-pointer"
            >
              <option value="all">All Employees</option>
              {employees
                .filter((e) => e.isActive !== false)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName || `${e.firstName} ${e.lastName}`}
                  </option>
                ))}
            </select>
          </div>

          {/* Date Range Selector */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-2">Date Range</label>
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateRange)}
              className="touch-button w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 appearance-none cursor-pointer"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {/* Custom Date Start */}
          {dateRange === 'custom' && (
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">Start Date</label>
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="touch-button w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </div>
          )}

          {/* Custom Date End */}
          {dateRange === 'custom' && (
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">End Date</label>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="touch-button w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </div>
          )}

          {/* Sort Metric */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-2">Sort By</label>
            <select
              value={sortMetric}
              onChange={(e) => setSortMetric(e.target.value as SortMetric)}
              className="touch-button w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 appearance-none cursor-pointer"
            >
              <option value="sales">Total Sales</option>
              <option value="transactions">Transaction Count</option>
              <option value="avg_transaction">Avg Transaction</option>
              <option value="sales_per_hour">Sales Per Hour</option>
              <option value="variance">Cash Variance</option>
            </select>
          </div>
        </div>
      </div>

      {/* KPI Cards for Selected Employee */}
      {selectedEmployeeId !== 'all' && currentMetric && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-zinc-900">Performance Metrics</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KPICard
              label="Total Sales"
              value={formatCurrency(currentMetric.totalSales)}
              trend={undefined}
              color="bg-blue-50 text-blue-700"
            />
            <KPICard
              label="Transactions"
              value={currentMetric.transactionCount.toString()}
              trend={undefined}
              color="bg-indigo-50 text-indigo-700"
            />
            <KPICard
              label="Avg Transaction"
              value={formatCurrency(currentMetric.averageTransaction)}
              trend={undefined}
              color="bg-purple-50 text-purple-700"
            />
            <KPICard
              label="Sales Per Hour"
              value={formatCurrency(currentMetric.salesPerHour)}
              trend={undefined}
              color="bg-green-50 text-green-700"
            />
            <KPICard
              label="Void/Return Rate"
              value={`${currentMetric.voidReturnRate.toFixed(1)}%`}
              trend={undefined}
              color="bg-amber-50 text-amber-700"
            />
            <KPICard
              label="Exceptions"
              value={currentMetric.exceptionCount.toString()}
              trend={undefined}
              color="bg-red-50 text-red-700"
            />
            <KPICard
              label="Cash Variance"
              value={formatCurrency(currentMetric.cashVariance)}
              trend={undefined}
              color="bg-orange-50 text-orange-700"
            />
            <KPICard
              label="Hours Worked"
              value={`${currentMetric.hoursWorked.toFixed(1)}h`}
              trend={undefined}
              color="bg-cyan-50 text-cyan-700"
            />
          </div>
        </div>
      )}

      {/* Leaderboard Table */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-900">Leaderboard</h2>
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-left font-semibold text-zinc-700">Rank</th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-700">Employee</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Sales</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Transactions</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Avg Transaction</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Sales/Hour</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Void Rate</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700">Variance</th>
                <th className="px-4 py-3 text-center font-semibold text-zinc-700">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedMetrics.map((metric, index) => {
                const isSelected = comparisonEmployees.some((e) => e.id === metric.employeeId);
                const salesValues = allMetrics.map((m) => m.totalSales);
                const transactionValues = allMetrics.map((m) => m.transactionCount);
                const avgValues = allMetrics.map((m) => m.averageTransaction);
                const salesPerHourValues = allMetrics.map((m) => m.salesPerHour);
                const varianceValues = allMetrics.map((m) => m.cashVariance);

                return (
                  <tr
                    key={metric.employeeId}
                    className={`border-b border-zinc-100 transition-colors ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <td className="px-4 py-3 font-semibold text-zinc-900">{index + 1}</td>
                    <td className="px-4 py-3 text-zinc-900">{metric.employeeName}</td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('sales', metric.totalSales, salesValues)}`}>
                      {formatCurrency(metric.totalSales)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('transactions', metric.transactionCount, transactionValues)}`}>
                      {metric.transactionCount}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('avg_transaction', metric.averageTransaction, avgValues)}`}>
                      {formatCurrency(metric.averageTransaction)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('sales_per_hour', metric.salesPerHour, salesPerHourValues)}`}>
                      {formatCurrency(metric.salesPerHour)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('sales_per_hour', 100 - metric.voidReturnRate, [100])}`}>
                      {metric.voidReturnRate.toFixed(1)}%
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${getPerformanceColor('variance', metric.cashVariance, varianceValues)}`}>
                      {formatCurrency(metric.cashVariance)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => toggleComparison(metric.employeeId, metric.employeeName)}
                        className={`touch-button rounded px-3 py-1 text-xs font-medium transition-colors ${
                          isSelected
                            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                        }`}
                      >
                        {isSelected ? 'Remove' : 'Compare'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Comparison View */}
      {comparisonMetrics.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-zinc-900">
            Comparison: {comparisonMetrics.map((m) => m.employeeName).join(' vs ')}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {comparisonMetrics.map((metric) => (
              <div
                key={metric.employeeId}
                className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4"
              >
                <h3 className="text-base font-semibold text-zinc-900">{metric.employeeName}</h3>
                <div className="space-y-2 text-sm">
                  <ComparisonRow label="Total Sales" value={formatCurrency(metric.totalSales)} />
                  <ComparisonRow label="Transactions" value={metric.transactionCount.toString()} />
                  <ComparisonRow label="Avg Transaction" value={formatCurrency(metric.averageTransaction)} />
                  <ComparisonRow label="Sales Per Hour" value={formatCurrency(metric.salesPerHour)} />
                  <ComparisonRow label="Void/Return Rate" value={`${metric.voidReturnRate.toFixed(1)}%`} />
                  <ComparisonRow label="Exceptions" value={metric.exceptionCount.toString()} />
                  <ComparisonRow label="Cash Variance" value={formatCurrency(metric.cashVariance)} />
                  <ComparisonRow label="Hours Worked" value={`${metric.hoursWorked.toFixed(1)}h`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {sortedMetrics.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 py-12">
          <Users className="mb-4 h-12 w-12 text-zinc-400" />
          <p className="text-center text-zinc-600">No performance data available for the selected filters.</p>
        </div>
      )}
    </div>
  );
}

// KPI Card Component
function KPICard({
  label,
  value,
  trend,
  color,
}: {
  label: string;
  value: string;
  trend?: number;
  color: string;
}) {
  return (
    <div className={`rounded-2xl ${color} p-4`}>
      <p className="text-xs font-medium opacity-75">{label}</p>
      <div className="mt-2 flex items-baseline justify-between">
        <p className="text-xl font-bold">{value}</p>
        {trend !== undefined && (
          <div className="flex items-center gap-1">
            {trend > 0 ? (
              <TrendingUp className="h-4 w-4" />
            ) : trend < 0 ? (
              <TrendingDown className="h-4 w-4" />
            ) : null}
            <span className="text-xs font-medium">{Math.abs(trend)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Comparison Row Component
function ComparisonRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-600">{label}</span>
      <span className="font-semibold text-zinc-900">{value}</span>
    </div>
  );
}
