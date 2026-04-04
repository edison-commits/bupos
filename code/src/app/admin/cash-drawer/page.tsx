'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect } from 'react';
import { ChevronLeft, DollarSign, TrendingUp, AlertCircle, CheckCircle2, Plus, Minus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/api/client';

interface Shift {
  id: string;
  employeeName: string;
  openedAt: string;
  closedAt?: string;
  openingFloat: number;
  expectedCash?: number;
  declaredCash?: number;
  variance?: number;
}

interface PayInOut {
  id: string;
  direction: 'pay_in' | 'pay_out';
  amount: number;
  reason: string;
  note?: string;
  createdAt: string;
}

export default function CashDrawerPage() {
  const router = useRouter();
  const [currentShift, setCurrentShift] = useState<Shift | null>(null);
  const [shiftHistory, setShiftHistory] = useState<Shift[]>([]);
  const [payInOuts, setPayInOuts] = useState<PayInOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Open shift form
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [openingFloat, setOpeningFloat] = useState<string>('');
  const [openingNote, setOpeningNote] = useState<string>('');
  const [isOpeningShift, setIsOpeningShift] = useState(false);

  // Pay in/out forms
  const [showPayInForm, setShowPayInForm] = useState(false);
  const [showPayOutForm, setShowPayOutForm] = useState(false);
  const [payAmount, setPayAmount] = useState<string>('');
  const [payReason, setPayReason] = useState<string>('');
  const [payNote, setPayNote] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Close shift
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [declaredCash, setDeclaredCash] = useState<string>('');
  const [closeNote, setCloseNote] = useState<string>('');
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const [statusRes, historyRes] = await Promise.all([
        authFetch('/api/cash-drawer?action=status'),
        authFetch('/api/cash-drawer?action=history'),
      ]);

      if (!statusRes.ok || !historyRes.ok) {
        throw new Error('Failed to load data');
      }

      const statusData = await statusRes.json();
      const historyData = await historyRes.json();

      setCurrentShift(statusData.shift);
      setShiftHistory(historyData.shifts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenShift = async () => {
    if (!openingFloat) {
      setError('Please enter opening float');
      return;
    }

    try {
      setIsOpeningShift(true);
      setError(null);

      const response = await authFetch('/api/cash-drawer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'open_shift',
          opening_float: Number(openingFloat),
          note: openingNote || undefined,
        }),
      });

      if (!response.ok) throw new Error('Failed to open shift');

      setShowOpenForm(false);
      setOpeningFloat('');
      setOpeningNote('');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsOpeningShift(false);
    }
  };

  const handlePayInOut = async (direction: 'pay_in' | 'pay_out') => {
    if (!currentShift || !payAmount || !payReason) {
      setError('Please fill in all required fields');
      return;
    }

    try {
      setIsProcessing(true);
      setError(null);

      const response = await authFetch('/api/cash-drawer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: direction,
          shift_id: currentShift.id,
          amount: Number(payAmount),
          reason: payReason,
          note: payNote || undefined,
        }),
      });

      if (!response.ok) throw new Error(`Failed to record ${direction}`);

      setPayAmount('');
      setPayReason('');
      setPayNote('');
      setShowPayInForm(false);
      setShowPayOutForm(false);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCloseShift = async () => {
    if (!currentShift || !declaredCash) {
      setError('Please enter declared cash amount');
      return;
    }

    try {
      setIsClosing(true);
      setError(null);

      const response = await authFetch('/api/cash-drawer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close_shift',
          shift_id: currentShift.id,
          declared_cash: Number(declaredCash),
          note: closeNote || undefined,
        }),
      });

      if (!response.ok) throw new Error('Failed to close shift');

      setShowCloseForm(false);
      setDeclaredCash('');
      setCloseNote('');
      await fetchData();
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

  const getVarianceColor = (variance: number) => {
    if (variance === 0) return 'text-green-600';
    if (variance > 0) return 'text-amber-600';
    return 'text-red-600';
  };

  return (
    <div className="min-h-screen bg-gray-50">
        <AdminTopNav />
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h1 className="text-2xl font-bold text-gray-900">Cash Drawer</h1>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {loading ? (
          <CashDrawerSkeleton />
        ) : error && !currentShift ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-start gap-4">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-900">{error}</h3>
              <button
                onClick={fetchData}
                className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Current Shift Status Card */}
            {currentShift ? (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <p className="text-sm font-medium text-gray-600">Shift Status</p>
                    <h2 className="text-2xl font-bold text-emerald-600">Open</h2>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-600">Started</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {formatDateTime(currentShift.openedAt)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4 pt-6 border-t border-gray-200">
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Opening Float</p>
                    <p className="text-2xl font-bold text-emerald-600 mt-1">
                      {formatCurrency(currentShift.openingFloat)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Time Open</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">
                      {Math.round((Date.now() - new Date(currentShift.openedAt).getTime()) / (1000 * 60))} min
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Status</p>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="w-3 h-3 bg-green-500 rounded-full" />
                      <span className="text-lg font-semibold text-green-600">Active</span>
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3 mt-6 pt-6 border-t border-gray-200">
                  <button
                    onClick={() => setShowPayInForm(true)}
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-4 bg-green-50 text-green-700 rounded-2xl border-2 border-green-200 hover:bg-green-100 transition-colors font-medium"
                  >
                    <Plus className="w-5 h-5" />
                    Pay In
                  </button>
                  <button
                    onClick={() => setShowPayOutForm(true)}
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-4 bg-red-50 text-red-700 rounded-2xl border-2 border-red-200 hover:bg-red-100 transition-colors font-medium"
                  >
                    <Minus className="w-5 h-5" />
                    Pay Out
                  </button>
                  <button
                    onClick={() => setShowCloseForm(true)}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium"
                  >
                    <CheckCircle2 className="w-5 h-5" />
                    Close Shift
                  </button>
                </div>
              </div>
            ) : (
              // No shift open - show open shift button
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
                <DollarSign className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-gray-900 mb-2">No Shift Open</h2>
                <p className="text-gray-600 mb-6">Open a new shift to get started</p>
                <button
                  onClick={() => setShowOpenForm(true)}
                  className="px-6 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium"
                >
                  Open New Shift
                </button>
              </div>
            )}

            {/* Open Shift Form */}
            {showOpenForm && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h3 className="text-lg font-bold text-gray-900 mb-4">Open New Shift</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="opening-float" className="block text-sm font-medium text-gray-700 mb-2">
                      Opening Float
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">
                        $
                      </span>
                      <input
                        id="opening-float"
                        type="number"
                        step="0.01"
                        min="0"
                        value={openingFloat}
                        onChange={(e) => setOpeningFloat(e.target.value)}
                        placeholder="0.00"
                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="opening-note" className="block text-sm font-medium text-gray-700 mb-2">
                      Note (Optional)
                    </label>
                    <textarea
                      id="opening-note"
                      value={openingNote}
                      onChange={(e) => setOpeningNote(e.target.value)}
                      placeholder="Any notes about opening..."
                      rows={2}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-none"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowOpenForm(false);
                        setOpeningFloat('');
                        setOpeningNote('');
                      }}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleOpenShift}
                      disabled={isOpeningShift}
                      className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium disabled:opacity-50"
                    >
                      {isOpeningShift ? 'Opening...' : 'Open Shift'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Pay In Form */}
            {showPayInForm && (
              <div className="bg-white rounded-lg shadow-sm border border-green-200 p-6">
                <h3 className="text-lg font-bold text-gray-900 mb-4">Record Pay In</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="pay-amount" className="block text-sm font-medium text-gray-700 mb-2">
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">
                        $
                      </span>
                      <input
                        id="pay-amount"
                        type="number"
                        step="0.01"
                        min="0"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="pay-reason" className="block text-sm font-medium text-gray-700 mb-2">
                      Reason
                    </label>
                    <input
                      id="pay-reason"
                      type="text"
                      value={payReason}
                      onChange={(e) => setPayReason(e.target.value)}
                      placeholder="e.g., Manager deposit, Bank deposit"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label htmlFor="pay-note" className="block text-sm font-medium text-gray-700 mb-2">
                      Note (Optional)
                    </label>
                    <textarea
                      id="pay-note"
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      placeholder="Additional details..."
                      rows={2}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowPayInForm(false);
                        setPayAmount('');
                        setPayReason('');
                        setPayNote('');
                      }}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handlePayInOut('pay_in')}
                      disabled={isProcessing}
                      className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium disabled:opacity-50"
                    >
                      {isProcessing ? 'Recording...' : 'Record Pay In'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Pay Out Form */}
            {showPayOutForm && (
              <div className="bg-white rounded-lg shadow-sm border border-red-200 p-6">
                <h3 className="text-lg font-bold text-gray-900 mb-4">Record Pay Out</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="payout-amount" className="block text-sm font-medium text-gray-700 mb-2">
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">
                        $
                      </span>
                      <input
                        id="payout-amount"
                        type="number"
                        step="0.01"
                        min="0"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="payout-reason" className="block text-sm font-medium text-gray-700 mb-2">
                      Reason
                    </label>
                    <input
                      id="payout-reason"
                      type="text"
                      value={payReason}
                      onChange={(e) => setPayReason(e.target.value)}
                      placeholder="e.g., Cash shortage, Manager request"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label htmlFor="payout-note" className="block text-sm font-medium text-gray-700 mb-2">
                      Note (Optional)
                    </label>
                    <textarea
                      id="payout-note"
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      placeholder="Additional details..."
                      rows={2}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowPayOutForm(false);
                        setPayAmount('');
                        setPayReason('');
                        setPayNote('');
                      }}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handlePayInOut('pay_out')}
                      disabled={isProcessing}
                      className="flex-1 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium disabled:opacity-50"
                    >
                      {isProcessing ? 'Recording...' : 'Record Pay Out'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Close Shift Form */}
            {showCloseForm && currentShift && (
              <div className="bg-white rounded-lg shadow-sm border border-teal-200 p-6">
                <h3 className="text-lg font-bold text-gray-900 mb-4">Close Shift</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="declared-cash" className="block text-sm font-medium text-gray-700 mb-2">
                      Declared Cash in Drawer
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
                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="close-note" className="block text-sm font-medium text-gray-700 mb-2">
                      Note (Optional)
                    </label>
                    <textarea
                      id="close-note"
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                      placeholder="Any discrepancies or notes..."
                      rows={2}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-none"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowCloseForm(false);
                        setDeclaredCash('');
                        setCloseNote('');
                      }}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCloseShift}
                      disabled={isClosing}
                      className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium disabled:opacity-50"
                    >
                      {isClosing ? 'Closing...' : 'Close Shift'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Error Banner */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {/* Shift History */}
            {shiftHistory.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-teal-600 to-emerald-600 px-6 py-4">
                  <h3 className="text-lg font-semibold text-white">Recent Shifts</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Employee
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Opened
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Closed
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Opening
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Expected
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Declared
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wide">
                          Variance
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {shiftHistory.map((shift) => (
                        <tr key={shift.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 text-sm font-medium text-gray-900">
                            {shift.employeeName || 'Unknown'}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {formatDateTime(shift.openedAt)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {shift.closedAt ? formatDateTime(shift.closedAt) : '-'}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-right text-gray-900">
                            {formatCurrency(shift.openingFloat)}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-right text-gray-900">
                            {shift.expectedCash !== undefined ? formatCurrency(shift.expectedCash) : '-'}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-right text-gray-900">
                            {shift.declaredCash !== undefined ? formatCurrency(shift.declaredCash) : '-'}
                          </td>
                          <td className={`px-6 py-4 text-sm font-bold text-right ${getVarianceColor(shift.variance || 0)}`}>
                            {shift.variance !== undefined
                              ? `${shift.variance >= 0 ? '+' : ''}${formatCurrency(shift.variance)}`
                              : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CashDrawerSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="bg-gray-200 h-48 rounded-lg" />
      <div className="bg-gray-200 h-64 rounded-lg" />
      <div className="bg-gray-200 h-96 rounded-lg" />
    </div>
  );
}
