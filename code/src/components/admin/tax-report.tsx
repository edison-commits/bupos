'use client';

import React, { useState, useMemo } from 'react';
import { LocalStoreData } from '@/lib/persistence/types';
import { formatCurrency } from "@/lib/format";
import { csvCell } from "@/lib/format/csv-sanitize";

type DateRange = {
  startDate: Date;
  endDate: Date;
};

type PeriodType = 'custom' | 'monthly' | 'quarterly' | 'yearly';

type MonthOption = {
  label: string;
  startDate: Date;
  endDate: Date;
};

type QuarterOption = {
  label: string;
  startDate: Date;
  endDate: Date;
};

const getCurrentYear = () => new Date().getFullYear();

const getMonthOptions = (year: number): MonthOption[] => [
  { label: `Jan ${year}`, startDate: new Date(year, 0, 1), endDate: new Date(year, 0, 31) },
  { label: `Feb ${year}`, startDate: new Date(year, 1, 1), endDate: new Date(year, 1, 28) },
  { label: `Mar ${year}`, startDate: new Date(year, 2, 1), endDate: new Date(year, 2, 31) },
  { label: `Apr ${year}`, startDate: new Date(year, 3, 1), endDate: new Date(year, 3, 30) },
  { label: `May ${year}`, startDate: new Date(year, 4, 1), endDate: new Date(year, 4, 31) },
  { label: `Jun ${year}`, startDate: new Date(year, 5, 1), endDate: new Date(year, 5, 30) },
  { label: `Jul ${year}`, startDate: new Date(year, 6, 1), endDate: new Date(year, 6, 31) },
  { label: `Aug ${year}`, startDate: new Date(year, 7, 1), endDate: new Date(year, 7, 31) },
  { label: `Sep ${year}`, startDate: new Date(year, 8, 1), endDate: new Date(year, 8, 30) },
  { label: `Oct ${year}`, startDate: new Date(year, 9, 1), endDate: new Date(year, 9, 31) },
  { label: `Nov ${year}`, startDate: new Date(year, 10, 1), endDate: new Date(year, 10, 30) },
  { label: `Dec ${year}`, startDate: new Date(year, 11, 1), endDate: new Date(year, 11, 31) },
];

const getQuarterOptions = (year: number): QuarterOption[] => [
  { label: `Q1 ${year}`, startDate: new Date(year, 0, 1), endDate: new Date(year, 2, 31) },
  { label: `Q2 ${year}`, startDate: new Date(year, 3, 1), endDate: new Date(year, 5, 30) },
  { label: `Q3 ${year}`, startDate: new Date(year, 6, 1), endDate: new Date(year, 8, 30) },
  { label: `Q4 ${year}`, startDate: new Date(year, 9, 1), endDate: new Date(year, 11, 31) },
];

interface DailyTaxData {
  date: string;
  grossSales: number;
  returns: number;
  netSales: number;
  taxCollected: number;
}

interface TenderBreakdown {
  type: string;
  amount: number;
  taxAmount: number;
}

interface TaxSummary {
  grossSales: number;
  totalReturns: number;
  netTaxableSales: number;
  taxCollected: number;
  expectedTax: number;
  variance: number;
  tenderBreakdown: TenderBreakdown[];
  dailyBreakdown: DailyTaxData[];
  taxRate: number;
}

export function TaxReport({ store }: { store: LocalStoreData }) {
  const currentYear = getCurrentYear();
  const [periodType, setPeriodType] = useState<PeriodType>('monthly');
  const [selectedMonthOption, setSelectedMonthOption] = useState<string>('Jan 2026');
  const [selectedQuarterOption, setSelectedQuarterOption] = useState<string>('Q1 2026');
  const [customStartDate, setCustomStartDate] = useState<string>('2026-01-01');
  const [customEndDate, setCustomEndDate] = useState<string>('2026-01-31');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  const monthOptions = useMemo(() => getMonthOptions(selectedYear), [selectedYear]);
  const quarterOptions = useMemo(() => getQuarterOptions(selectedYear), [selectedYear]);

  const dateRange = useMemo((): DateRange => {
    if (periodType === 'custom') {
      return {
        startDate: new Date(customStartDate),
        endDate: new Date(customEndDate),
      };
    }

    if (periodType === 'monthly') {
      const selected = monthOptions.find((m) => m.label === selectedMonthOption);
      if (selected) return { startDate: selected.startDate, endDate: selected.endDate };
    }

    if (periodType === 'quarterly') {
      const selected = quarterOptions.find((q) => q.label === selectedQuarterOption);
      if (selected) return { startDate: selected.startDate, endDate: selected.endDate };
    }

    if (periodType === 'yearly') {
      return {
        startDate: new Date(selectedYear, 0, 1),
        endDate: new Date(selectedYear, 11, 31),
      };
    }

    return { startDate: new Date(), endDate: new Date() };
  }, [periodType, selectedMonthOption, selectedQuarterOption, customStartDate, customEndDate, selectedYear, monthOptions, quarterOptions]);

  const taxRate = useMemo(() => {
    if (store.locations && store.locations.length > 0) {
      return store.locations[0].taxRate || 0.1;
    }
    return 0.1;
  }, [store.locations]);

  const taxSummary = useMemo((): TaxSummary => {
    const transactions = store.transactionEventPlaceholders || [];
    const tenders = store.transactionTenderPlaceholders || [];

    const filteredTransactions = transactions.filter((tx) => {
      const txDate = new Date(tx.createdAt || new Date());
      return txDate >= dateRange.startDate && txDate <= dateRange.endDate;
    });

    let grossSales = 0;
    let totalReturns = 0;
    let taxCollected = 0;
    const dailyMap = new Map<string, DailyTaxData>();
    const tenderMap = new Map<string, TenderBreakdown>();

    filteredTransactions.forEach((tx) => {
      const payload = tx.payload || {};
      const subtotal = Number(payload.subtotal ?? payload.grand_total ?? 0);
      const txTax = Number(payload.tax_total ?? 0);
      const isReturn = payload.is_return === "true";

      const dateKey = new Date(tx.createdAt || new Date()).toISOString().split('T')[0];

      if (isReturn) {
        totalReturns += Math.abs(subtotal);
      } else {
        grossSales += subtotal;
      }

      taxCollected += txTax;

      // Daily breakdown
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          grossSales: 0,
          returns: 0,
          netSales: 0,
          taxCollected: 0,
        });
      }
      const daily = dailyMap.get(dateKey)!;
      if (isReturn) {
        daily.returns += Math.abs(subtotal);
      } else {
        daily.grossSales += subtotal;
      }
      daily.taxCollected += txTax;
      daily.netSales = daily.grossSales - daily.returns;
    });

    // Tender breakdown — use tenderType and amount directly from TransactionTenderPlaceholder
    tenders.forEach((tender) => {
      const tenderType = tender.tenderType || 'Unknown';
      const amount = tender.amount || 0;
      const tenderTax = amount * (taxRate / (1 + taxRate));

      if (!tenderMap.has(tenderType)) {
        tenderMap.set(tenderType, {
          type: tenderType,
          amount: 0,
          taxAmount: 0,
        });
      }
      const tenderBreak = tenderMap.get(tenderType)!;
      tenderBreak.amount += amount;
      tenderBreak.taxAmount += tenderTax;
    });

    const netTaxableSales = grossSales - totalReturns;
    const expectedTax = netTaxableSales * taxRate;
    const variance = taxCollected - expectedTax;

    const dailyBreakdown = Array.from(dailyMap.values()).sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    return {
      grossSales,
      totalReturns,
      netTaxableSales,
      taxCollected,
      expectedTax,
      variance,
      tenderBreakdown: Array.from(tenderMap.values()),
      dailyBreakdown,
      taxRate,
    };
  }, [store.transactionEventPlaceholders, store.transactionTenderPlaceholders, dateRange, taxRate]);

  const handleExportCSV = () => {
    const { organization } = store;
    const businessName = organization?.name || 'Business';

    const headers = [
      csvCell(`Tax Report - ${businessName}`),
      csvCell(`Period: ${dateRange.startDate.toLocaleDateString()} to ${dateRange.endDate.toLocaleDateString()}`),
      csvCell(`Generated: ${new Date().toLocaleDateString()}`),
      '',
      'Daily Breakdown',
      ['Date', 'Gross Sales', 'Returns', 'Net Sales', 'Tax Collected'].map(csvCell).join(','),
    ];

    const rows = taxSummary.dailyBreakdown.map((day) =>
      [
        csvCell(day.date),
        csvCell(day.grossSales.toFixed(2)),
        csvCell(day.returns.toFixed(2)),
        csvCell(day.netSales.toFixed(2)),
        csvCell(day.taxCollected.toFixed(2)),
      ].join(',')
    );

    const summary = [
      '',
      'Summary',
      [csvCell('Gross Sales'), csvCell(taxSummary.grossSales.toFixed(2))].join(','),
      [csvCell('Returns/Refunds'), csvCell(taxSummary.totalReturns.toFixed(2))].join(','),
      [csvCell('Net Taxable Sales'), csvCell(taxSummary.netTaxableSales.toFixed(2))].join(','),
      [csvCell('Tax Rate'), csvCell((taxSummary.taxRate * 100).toFixed(2) + '%')].join(','),
      [csvCell('Tax Collected'), csvCell(taxSummary.taxCollected.toFixed(2))].join(','),
      [csvCell('Expected Tax'), csvCell(taxSummary.expectedTax.toFixed(2))].join(','),
      [csvCell('Variance'), csvCell(taxSummary.variance.toFixed(2))].join(','),
    ];

    const csvContent = [...headers, ...rows, ...summary].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tax-report-${dateRange.startDate.getTime()}.csv`;
    link.click();
    window.URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-6 bg-white">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-zinc-900 mb-2">Tax Report</h1>
        <p className="text-zinc-600">Generate tax period summaries for accountant handoff</p>
      </div>

      {/* Period Selector */}
      <div className="bg-zinc-50 rounded-2xl p-6 mb-8 border border-zinc-200">
        <h2 className="text-lg font-semibold text-zinc-900 mb-6">Select Period</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Period Type Selection */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-3">Period Type</label>
            <div className="space-y-2">
              {(['monthly', 'quarterly', 'yearly', 'custom'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setPeriodType(type)}
                  className={`w-full text-left px-4 py-2 rounded-lg transition-colors touch-button ${
                    periodType === type
                      ? 'bg-teal-700 text-white'
                      : 'bg-white text-zinc-700 hover:bg-zinc-100 border border-zinc-200'
                  }`}
                >
                  <span className="capitalize">{type}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Dynamic Selection Based on Period Type */}
          <div>
            {periodType === 'monthly' && (
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-3">Select Month</label>
                <select
                  value={selectedMonthOption}
                  onChange={(e) => setSelectedMonthOption(e.target.value)}
                  className="w-full px-4 py-2 border border-zinc-300 rounded-lg bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                >
                  {monthOptions.map((month) => (
                    <option key={month.label} value={month.label}>
                      {month.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {periodType === 'quarterly' && (
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-3">Select Quarter</label>
                <select
                  value={selectedQuarterOption}
                  onChange={(e) => setSelectedQuarterOption(e.target.value)}
                  className="w-full px-4 py-2 border border-zinc-300 rounded-lg bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                >
                  {quarterOptions.map((quarter) => (
                    <option key={quarter.label} value={quarter.label}>
                      {quarter.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {periodType === 'yearly' && (
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-3">Select Year</label>
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                  className="w-full px-4 py-2 border border-zinc-300 rounded-lg bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                >
                  {[2024, 2025, 2026, 2027].map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {periodType === 'custom' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="w-full px-4 py-2 border border-zinc-300 rounded-lg bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1">End Date</label>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="w-full px-4 py-2 border border-zinc-300 rounded-lg bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleExportCSV}
            className="px-6 py-2 bg-teal-700 text-white rounded-lg font-medium hover:bg-teal-800 transition-colors touch-button"
          >
            Export to CSV
          </button>
          <button
            onClick={handlePrint}
            className="px-6 py-2 bg-zinc-700 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors touch-button"
          >
            Print View
          </button>
        </div>
      </div>

      {/* Tax Summary Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <SummaryCard label="Gross Sales" value={formatCurrency(taxSummary.grossSales)} />
        <SummaryCard label="Returns/Refunds" value={`-${formatCurrency(taxSummary.totalReturns)}`} negative />
        <SummaryCard label="Net Taxable Sales" value={formatCurrency(taxSummary.netTaxableSales)} />
        <SummaryCard label="Tax Collected" value={formatCurrency(taxSummary.taxCollected)} />
        <SummaryCard label="Expected Tax" value={formatCurrency(taxSummary.expectedTax)} />
        <SummaryCard
          label="Variance"
          value={formatCurrency(Math.abs(taxSummary.variance))}
          negative={taxSummary.variance < 0}
        />
      </div>

      {/* Tender Breakdown */}
      {taxSummary.tenderBreakdown.length > 0 && (
        <div className="bg-zinc-50 rounded-2xl p-6 mb-8 border border-zinc-200">
          <h2 className="text-lg font-semibold text-zinc-900 mb-4">Tender Breakdown</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-300">
                  <th className="text-left px-4 py-2 text-zinc-700 font-semibold">Tender Type</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Amount</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Tax Amount</th>
                </tr>
              </thead>
              <tbody>
                {taxSummary.tenderBreakdown.map((tender, idx) => (
                  <tr key={idx} className="border-b border-zinc-100 hover:bg-white transition-colors">
                    <td className="px-4 py-3 text-zinc-900">{tender.type}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(tender.amount)}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(tender.taxAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monthly/Daily Trend */}
      {taxSummary.dailyBreakdown.length > 0 && (
        <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200">
          <h2 className="text-lg font-semibold text-zinc-900 mb-4">Daily Breakdown</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-300">
                  <th className="text-left px-4 py-2 text-zinc-700 font-semibold">Date</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Gross Sales</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Returns</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Net Sales</th>
                  <th className="text-right px-4 py-2 text-zinc-700 font-semibold">Tax Collected</th>
                </tr>
              </thead>
              <tbody>
                {taxSummary.dailyBreakdown.map((day, idx) => (
                  <tr key={idx} className="border-b border-zinc-100 hover:bg-white transition-colors">
                    <td className="px-4 py-3 text-zinc-900 font-medium">{day.date}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(day.grossSales)}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(day.returns)}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(day.netSales)}</td>
                    <td className="text-right px-4 py-3 text-zinc-900">{formatCurrency(day.taxCollected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Print Styles */}
      <style>{`
        @media print {
          body {
            background: white;
          }
          .bg-zinc-50 {
            background: white !important;
            border: 1px solid #e4e4e7 !important;
          }
          button {
            display: none !important;
          }
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th, td {
            border: 1px solid #e4e4e7 !important;
            padding: 0.75rem !important;
          }
        }
      `}</style>
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  value: string;
  negative?: boolean;
}

function SummaryCard({ label, value, negative }: SummaryCardProps) {
  return (
    <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200">
      <p className="text-sm font-medium text-zinc-600 mb-2">{label}</p>
      <p className={`text-2xl font-bold ${negative ? 'text-red-600' : 'text-teal-700'}`}>{value}</p>
    </div>
  );
}
