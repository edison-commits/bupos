'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect } from 'react';
import { ChevronLeft, DollarSign, TrendingUp, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/api/client';

interface ShiftData {
  shift: {
    id: string;
    employeeName: string;
    openedAt: string;
    openingFloat: number;
    status: string;
  };
  report: {
    salesCount: number;
    salesAmount: number;
    tenderBreakdown: Array<{ type: string; count: number; amount: number }>;
    refundsCount: number;
    refundsAmount: number;
    netSales: number;
    payIns: number;
    payOuts: number;
    expectedCash: number;
  };
}

export default function ShiftClosePage() {
  const router = useRouter();
  const [data, setData] = useState<ShiftData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [declaredCash, setDeclaredCash] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [isClosing, setIsClosing] = useState(false);
  const [closeSuccess, setCloseSuccess] = useState(false);

  useEffect(() => {
    fetchShiftData();
  }, []);

  const fetchShiftData = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await authFetch('/api/shift-close');
      if (!response.ok) {
        throw new Error('Failed to load shift data');
      }
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCloseShift = async () => {
    if (!data || !declaredCash) {
      setError('Please enter the cash count');
      return;
    }

    // Warn and require acknowledgment for large cash variances before proceeding
    const varianceAmt = Number(declaredCash) - data.report.expectedCash;
    const varianceAbs = Math.abs(varianceAmt);
    if (varianceAbs >= 20 && !window.confirm(`This shift has a $${varianceAbs.toFixed(2)} variance (${varianceAmt >= 0 ? 'over' : 'short'}). Are you sure you want to close it?`)) {
      return;
    }

    try {
      setIsClosing(true);
      setError(null);

      const response = await authFetch('/api/shift-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shiftId: data.shift.id,
          declaredCash: Number(declaredCash),
          notes: notes || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to close shift');
      }

      setCloseSuccess(true);
      setTimeout(() => {
        router.push('/admin');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsClosing(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (closeSuccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <CheckCircle2 className="w-16 h-16 text-emerald-600 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Shift Closed</h1>
          <p className="text-gray-600">Your shift has been successfully closed. Redirecting to dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
        <AdminTopNav />
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h1 className="text-2xl font-bold text-gray-900">Close Shift</h1>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {loading ? (
          <ShiftCloseSkeleton />
        ) : error && !data ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-start gap-4">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-900">{error}</h3>
              <button
                onClick={fetchShiftData}
                className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
              >
                Retry
              </button>
            </div>
          </div>
        ) : data ? (
          <div className="space-y-6">
            {/* Shift Info Card */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <p className="text-sm font-medium text-gray-600">Employee</p>
                  <h2 className="text-lg font-semibold text-gray-900">{data.shift.employeeName}</h2>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-gray-600">Shift Start</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {formatDateTime(data.shift.openedAt)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-6 border-t border-gray-200">
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Opening Float</p>
                  <p className="text-2xl font-bold text-emerald-600">
                    {formatCurrency(data.shift.openingFloat)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Duration</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Math.round(
                      (Date.now() - new Date(data.shift.openedAt).getTime()) / (1000 * 60)
                    )}{' '}
                    min
                  </p>
                </div>
              </div>
            </div>

            {/* Z-Report Summary */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-teal-600 to-emerald-600 px-6 py-4">
                <h3 className="text-lg font-semibold text-white">Z-Report Summary</h3>
              </div>

              <div className="p-6 space-y-4">
                {/* Sales Summary */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <MetricBox
                    label="Total Sales"
                    value={formatCurrency(data.report.salesAmount)}
                    count={`${data.report.salesCount} transactions`}
                    icon={<DollarSign className="w-5 h-5" />}
                    color="teal"
                  />
                  <MetricBox
                    label="Refunds"
                    value={formatCurrency(data.report.refundsAmount)}
                    count={`${data.report.refundsCount} returns`}
                    icon={<TrendingUp className="w-5 h-5 rotate-180" />}
                    color="amber"
                  />
                  <MetricBox
                    label="Net Sales"
                    value={formatCurrency(data.report.netSales)}
                    count="After refunds"
                    icon={<CheckCircle2 className="w-5 h-5" />}
                    color="emerald"
                  />
                </div>

                {/* Tender Breakdown */}
                {data.report.tenderBreakdown.length > 0 && (
                  <div className="pt-4 border-t border-gray-200">
                    <p className="text-sm font-semibold text-gray-900 mb-3">Payment Methods</p>
                    <div className="space-y-2">
                      {data.report.tenderBreakdown.map((tender, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full bg-teal-500" />
                            <span className="text-sm font-medium text-gray-700 capitalize">
                              {tender.type === 'card' ? 'Credit/Debit' : tender.type}
                            </span>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-gray-900">
                              {formatCurrency(tender.amount)}
                            </p>
                            <p className="text-xs text-gray-500">{tender.count} transaction{tender.count !== 1 ? 's' : ''}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pay Ins/Outs */}
                {(data.report.payIns > 0 || data.report.payOuts > 0) && (
                  <div className="pt-4 border-t border-gray-200">
                    <p className="text-sm font-semibold text-gray-900 mb-3">Adjustments</p>
                    <div className="grid grid-cols-2 gap-3">
                      {data.report.payIns > 0 && (
                        <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                          <p className="text-xs font-medium text-green-700 uppercase tracking-wide">Pay Ins</p>
                          <p className="text-lg font-bold text-green-600 mt-1">
                            +{formatCurrency(data.report.payIns)}
                          </p>
                        </div>
                      )}
                      {data.report.payOuts > 0 && (
                        <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                          <p className="text-xs font-medium text-red-700 uppercase tracking-wide">Pay Outs</p>
                          <p className="text-lg font-bold text-red-600 mt-1">
                            -{formatCurrency(data.report.payOuts)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Expected Cash */}
                <div className="pt-4 border-t border-gray-200 bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4">
                  <p className="text-sm font-semibold text-blue-900 mb-1">Expected Cash in Drawer</p>
                  <div className="flex items-baseline justify-between">
                    <p className="text-3xl font-bold text-blue-600">
                      {formatCurrency(data.report.expectedCash)}
                    </p>
                    <p className="text-xs text-blue-700">
                      Opening + Sales - Refunds + Ins - Outs
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Cash Count Input */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Physical Cash Count
              </h3>
              <div className="space-y-4">
                <div>
                  <label htmlFor="declared-cash" className="block text-sm font-medium text-gray-700 mb-2">
                    Cash Counted in Drawer
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">
                      $
                    </span>
                    <input
                      id="declared-cash"
                      type="number"
                      step="0.01"
                      min="0"
                      value={declaredCash}
                      onChange={(e) => setDeclaredCash(e.target.value)}
                      placeholder="0.00"
                      className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent text-lg font-semibold"
                    />
                  </div>
                </div>

                {declaredCash && (
                  <div className="p-4 rounded-lg border-2 border-teal-200 bg-teal-50">
                    <div className="flex items-start justify-between mb-3">
                      <p className="text-sm font-semibold text-teal-900">Variance</p>
                      <p
                        className={`text-2xl font-bold ${
                          Number(declaredCash) === data.report.expectedCash
                            ? 'text-green-600'
                            : Number(declaredCash) > data.report.expectedCash
                            ? 'text-amber-600'
                            : 'text-red-600'
                        }`}
                      >
                        {Number(declaredCash) >= data.report.expectedCash ? '+' : ''}
                        {formatCurrency(Number(declaredCash) - data.report.expectedCash)}
                      </p>
                    </div>
                    <p className="text-xs text-teal-700">
                      {Number(declaredCash) === data.report.expectedCash
                        ? 'Perfect match!'
                        : `${Math.abs(Number(declaredCash) - data.report.expectedCash).toFixed(2)} ${Number(declaredCash) > data.report.expectedCash ? 'over' : 'short'}`}
                    </p>
                  </div>
                )}

                <div>
                  <label htmlFor="closing-notes" className="block text-sm font-medium text-gray-700 mb-2">
                    Closing Notes (Optional)
                  </label>
                  <textarea
                    id="closing-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any discrepancies or notes..."
                    rows={3}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-none"
                  />
                </div>
              </div>
            </div>

            {/* Error Banner */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-4">
              <button
                onClick={() => router.back()}
                disabled={isClosing}
                className="flex-1 px-6 py-3 border border-gray-300 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCloseShift}
                disabled={isClosing || !declaredCash}
                className="flex-1 px-6 py-3 bg-gradient-to-r from-teal-600 to-emerald-600 text-white rounded-lg font-semibold hover:from-teal-700 hover:to-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isClosing ? (
                  <>
                    <Clock className="w-5 h-5 animate-spin" />
                    Closing...
                  </>
                ) : (
                  'Close Shift'
                )}
              </button>
            </div>

            {/* Print Button */}
            <button
              onClick={() => window.print()}
              disabled={isClosing}
              className="w-full px-6 py-2 border border-gray-300 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 text-sm"
            >
              Print Z-Report
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface MetricBoxProps {
  label: string;
  value: string;
  count: string;
  icon: React.ReactNode;
  color: 'teal' | 'amber' | 'emerald';
}

function MetricBox({ label, value, count, icon, color }: MetricBoxProps) {
  const colorClasses = {
    teal: 'bg-teal-50 border-teal-200 text-teal-600',
    amber: 'bg-amber-50 border-amber-200 text-amber-600',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-600',
  };

  return (
    <div className={`p-4 rounded-lg border ${colorClasses[color]}`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-700">{label}</p>
        {icon}
      </div>
      <p className="text-2xl font-bold text-gray-900 mb-1">{value}</p>
      <p className="text-xs text-gray-600">{count}</p>
    </div>
  );
}

function ShiftCloseSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Shift Info Skeleton */}
      <div className="bg-gray-200 h-32 rounded-lg" />

      {/* Z-Report Skeleton */}
      <div className="bg-gray-200 h-96 rounded-lg" />

      {/* Cash Count Skeleton */}
      <div className="bg-gray-200 h-48 rounded-lg" />

      {/* Buttons Skeleton */}
      <div className="flex gap-4">
        <div className="flex-1 bg-gray-200 h-12 rounded-lg" />
        <div className="flex-1 bg-gray-200 h-12 rounded-lg" />
      </div>
    </div>
  );
}
