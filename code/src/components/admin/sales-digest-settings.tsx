'use client';

import { useState, useMemo } from 'react';
import { LocalStoreData } from '@/lib/persistence/types';
import { Mail, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatCurrency } from "@/lib/format";

interface DigestSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  recipientEmails: string;
  sendTime: string;
}

interface SalesMetrics {
  totalSales: number;
  transactionCount: number;
  averageTicket: number;
  topItems: Array<{
    name: string;
    quantity: number;
    sales: number;
  }>;
  tenderBreakdown: Record<string, number>;
  returnsCount: number;
  returnsAmount: number;
  lowStockCount: number;
  cashVariance: number;
  shiftCount: number;
}

export function SalesDigestSettings({ store }: { store: LocalStoreData }) {
  const [settings, setSettings] = useState<DigestSettings>({
    dailyEnabled: false,
    weeklyEnabled: false,
    recipientEmails: '',
    sendTime: '08:00',
  });

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [testEmailStatus, setTestEmailStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');

  // Calculate sales metrics from store data
  const metrics = useMemo((): SalesMetrics => {
    const transactions = store.transactionEventPlaceholders || [];
    const tenders = store.transactionTenderPlaceholders || [];
    const shifts = store.shifts || [];
    const inventory = store.inventory || [];

    // Calculate total sales and transaction count
    let totalSales = 0;
    let transactionCount = 0;
    const itemSalesMap = new Map<string, { quantity: number; sales: number }>();
    let returnsCount = 0;
    let returnsAmount = 0;

    // Filter to sale transactions (eventKind === "transaction_placeholder" with grand_total)
    transactions.forEach((tx) => {
      if (tx.eventKind !== "transaction_placeholder" || !tx.payload?.grand_total) return;
      const grandTotal = Number(tx.payload.grand_total ?? 0);
      if (tx.payload?.is_return === "true") {
        returnsCount += 1;
        returnsAmount += Math.abs(grandTotal);
      } else {
        totalSales += grandTotal;
        transactionCount += 1;
        // Track items from payload if available
        const itemName = tx.payload?.item_name || tx.transactionId.slice(0, 12);
        const existing = itemSalesMap.get(itemName) || { quantity: 0, sales: 0 };
        existing.quantity += 1;
        existing.sales += grandTotal;
        itemSalesMap.set(itemName, existing);
      }
    });

    // Get top 5 selling items
    const topItems = Array.from(itemSalesMap.entries())
      .map(([name, data]) => ({
        name,
        quantity: data.quantity,
        sales: data.sales,
      }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5);

    // Calculate tender breakdown
    const tenderBreakdown: Record<string, number> = {};
    tenders.forEach((tender) => {
      const type = tender.tenderType || 'Unknown';
      tenderBreakdown[type] = (tenderBreakdown[type] || 0) + (tender.amount || 0);
    });

    // Count low stock items
    let lowStockCount = 0;
    inventory.forEach((item) => {
      if (item.onHand <= item.reorderPoint) {
        lowStockCount += 1;
      }
    });

    // Calculate cash variance from shifts
    let cashVariance = 0;
    shifts.forEach((shift) => {
      if (shift.closingVariance !== undefined && shift.closingVariance !== null) {
        cashVariance += shift.closingVariance;
      }
    });

    const averageTicket = transactionCount > 0 ? totalSales / transactionCount : 0;

    return {
      totalSales,
      transactionCount,
      averageTicket,
      topItems,
      tenderBreakdown,
      returnsCount,
      returnsAmount,
      lowStockCount,
      cashVariance,
      shiftCount: shifts.length,
    };
  }, [store]);

  const handleSettingChange = (key: keyof DigestSettings, value: string | boolean | number) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  // NOTE: the sales-digest backend is not yet implemented. These handlers
  // previously faked a save via setTimeout, misleading users into thinking
  // their settings were persisted. Until a real /api/sales-digest endpoint
  // exists, set the status to 'error' so users know the setting isn't saved.
  const handleSaveSettings = () => {
    setSaveStatus('error');
    setTimeout(() => setSaveStatus('idle'), 4000);
  };

  const handleSendTestEmail = () => {
    if (!settings.recipientEmails.trim()) {
      setTestEmailStatus('error');
      setTimeout(() => setTestEmailStatus('idle'), 3000);
      return;
    }
    setTestEmailStatus('error');
    setTimeout(() => setTestEmailStatus('idle'), 4000);
  };

  const isConfigured = settings.dailyEnabled || settings.weeklyEnabled;
  const recipientList = settings.recipientEmails
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);

  return (
    <div className="space-y-8">
      {/* Configuration Section */}
      <div className="rounded-2xl bg-zinc-50 p-6 border border-zinc-200">
        <h2 className="text-lg font-semibold text-zinc-900 mb-6 flex items-center gap-2">
          <Mail className="w-5 h-5 text-teal-700" />
          Email Digest Configuration
        </h2>

        <div className="space-y-6">
          {/* Daily Digest Toggle */}
          <div className="flex items-center justify-between py-4 px-4 bg-white rounded-xl border border-zinc-200">
            <div>
              <h3 className="font-medium text-zinc-900">Daily Sales Digest</h3>
              <p className="text-sm text-zinc-600 mt-1">
                Receive a summary of today&apos;s sales performance
              </p>
            </div>
            <button
              onClick={() => handleSettingChange('dailyEnabled', !settings.dailyEnabled)}
              className={`touch-button relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
                settings.dailyEnabled ? 'bg-teal-700' : 'bg-zinc-300'
              }`}
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                  settings.dailyEnabled ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Weekly Digest Toggle */}
          <div className="flex items-center justify-between py-4 px-4 bg-white rounded-xl border border-zinc-200">
            <div>
              <h3 className="font-medium text-zinc-900">Weekly Sales Digest</h3>
              <p className="text-sm text-zinc-600 mt-1">
                Receive a summary of the week&apos;s performance (sent Mondays)
              </p>
            </div>
            <button
              onClick={() => handleSettingChange('weeklyEnabled', !settings.weeklyEnabled)}
              className={`touch-button relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
                settings.weeklyEnabled ? 'bg-teal-700' : 'bg-zinc-300'
              }`}
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                  settings.weeklyEnabled ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Recipient Emails */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-zinc-900">
              Recipient Email(s)
            </label>
            <p className="text-sm text-zinc-600">
              Enter one or more email addresses separated by commas
            </p>
            <input
              type="text"
              value={settings.recipientEmails}
              onChange={(e) => handleSettingChange('recipientEmails', e.target.value)}
              placeholder="owner@store.com, manager@store.com"
              className="touch-button w-full px-4 py-3 rounded-xl border border-zinc-300 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:border-transparent"
            />
            {recipientList.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {recipientList.map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-100 text-teal-700 text-sm font-medium"
                  >
                    {email}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Send Time */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-zinc-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-zinc-600" />
              Time of Day to Send
            </label>
            <input
              type="time"
              value={settings.sendTime}
              onChange={(e) => handleSettingChange('sendTime', e.target.value)}
              className="touch-button px-4 py-3 rounded-xl border border-zinc-300 bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:border-transparent"
            />
            <p className="text-sm text-zinc-600">
              Emails will be sent daily at {settings.sendTime}
            </p>
          </div>

          {/* Save Status */}
          {saveStatus !== 'idle' && (
            <div
              className={`flex items-center gap-3 p-4 rounded-xl ${
                saveStatus === 'success'
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : saveStatus === 'error'
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'bg-blue-50 text-blue-700 border border-blue-200'
              }`}
            >
              {saveStatus === 'success' && <CheckCircle2 className="w-5 h-5 flex-shrink-0" />}
              {saveStatus === 'error' && <AlertCircle className="w-5 h-5 flex-shrink-0" />}
              <span className="text-sm font-medium">
                {saveStatus === 'success' && 'Settings saved successfully'}
                {saveStatus === 'saving' && 'Saving settings...'}
                {saveStatus === 'error' && 'Sales digest is not yet implemented — settings are not saved.'}
              </span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4">
            <button
              onClick={handleSendTestEmail}
              disabled={!recipientList.length}
              className={`touch-button flex-1 px-4 py-3 rounded-xl font-medium transition-colors ${
                !recipientList.length
                  ? 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
                  : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 active:bg-zinc-300'
              }`}
            >
              {testEmailStatus === 'sending' ? 'Sending...' : 'Send Test Email'}
            </button>
            <button
              onClick={handleSaveSettings}
              disabled={!isConfigured || !recipientList.length}
              className={`touch-button flex-1 px-4 py-3 rounded-xl font-medium transition-colors ${
                !isConfigured || !recipientList.length
                  ? 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
                  : 'bg-teal-700 text-white hover:bg-teal-800 active:bg-teal-900'
              }`}
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>

      {/* Preview Section */}
      <div className="rounded-2xl bg-white border border-zinc-200 overflow-hidden">
        <div className="bg-gradient-to-r from-teal-700 to-teal-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Mail className="w-5 h-5" />
            Email Digest Preview
          </h2>
          <p className="text-teal-100 text-sm mt-1">
            This is what your sales digest email will contain
          </p>
        </div>

        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="border-b border-zinc-200 pb-6">
            <h3 className="text-2xl font-bold text-zinc-900">{store.organization.name || 'Store Name'}</h3>
            <p className="text-sm text-zinc-600 mt-2">Daily Sales Summary</p>
          </div>

          {/* Key Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4 border border-blue-200">
              <p className="text-sm font-medium text-blue-900 mb-1">Total Sales</p>
              <p className="text-2xl font-bold text-blue-700">
                {formatCurrency(metrics.totalSales)}
              </p>
            </div>
            <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4 border border-purple-200">
              <p className="text-sm font-medium text-purple-900 mb-1">Transactions</p>
              <p className="text-2xl font-bold text-purple-700">{metrics.transactionCount}</p>
            </div>
            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-4 border border-green-200">
              <p className="text-sm font-medium text-green-900 mb-1">Avg Ticket</p>
              <p className="text-2xl font-bold text-green-700">
                {formatCurrency(metrics.averageTicket)}
              </p>
            </div>
            <div className="bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl p-4 border border-orange-200">
              <p className="text-sm font-medium text-orange-900 mb-1">Shifts</p>
              <p className="text-2xl font-bold text-orange-700">{metrics.shiftCount}</p>
            </div>
          </div>

          {/* Top Selling Items */}
          {metrics.topItems.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-zinc-900 text-sm uppercase tracking-wide text-zinc-600">
                Top 5 Selling Items
              </h4>
              <div className="space-y-2">
                {metrics.topItems.map((item, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-200">
                    <div>
                      <p className="font-medium text-zinc-900">{item.name}</p>
                      <p className="text-sm text-zinc-600">{item.quantity} unit{item.quantity !== 1 ? 's' : ''}</p>
                    </div>
                    <p className="font-semibold text-teal-700">{formatCurrency(item.sales)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tender Breakdown */}
          {Object.keys(metrics.tenderBreakdown).length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-zinc-900 text-sm uppercase tracking-wide text-zinc-600">
                Payment Methods
              </h4>
              <div className="space-y-2">
                {Object.entries(metrics.tenderBreakdown).map(([type, amount]) => (
                  <div key={type} className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-200">
                    <p className="font-medium text-zinc-900">{type}</p>
                    <p className="font-semibold text-zinc-700">{formatCurrency(amount)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Returns Summary */}
          {metrics.returnsCount > 0 && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <h4 className="font-semibold text-amber-900 mb-2">Returns Summary</h4>
              <p className="text-sm text-amber-800">
                {metrics.returnsCount} return{metrics.returnsCount !== 1 ? 's' : ''} totaling{' '}
                <span className="font-semibold">{formatCurrency(metrics.returnsAmount)}</span>
              </p>
            </div>
          )}

          {/* Low Stock Alerts */}
          {metrics.lowStockCount > 0 && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
              <h4 className="font-semibold text-red-900 flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4" />
                Low Stock Alerts
              </h4>
              <p className="text-sm text-red-800">
                {metrics.lowStockCount} item{metrics.lowStockCount !== 1 ? 's' : ''} below reorder point
              </p>
            </div>
          )}

          {/* Cash Variance */}
          {metrics.shiftCount > 0 && (
            <div className={`p-4 rounded-xl border ${
              Math.abs(metrics.cashVariance) < 1
                ? 'bg-green-50 border-green-200'
                : 'bg-yellow-50 border-yellow-200'
            }`}>
              <h4 className={`font-semibold mb-2 ${
                Math.abs(metrics.cashVariance) < 1
                  ? 'text-green-900'
                  : 'text-yellow-900'
              }`}>
                Cash Variance
              </h4>
              <p className={`text-sm ${
                Math.abs(metrics.cashVariance) < 1
                  ? 'text-green-800'
                  : 'text-yellow-800'
              }`}>
                Total variance across {metrics.shiftCount} shift{metrics.shiftCount !== 1 ? 's' : ''}:{' '}
                <span className="font-semibold">
                  {formatCurrency(metrics.cashVariance)}
                </span>
              </p>
            </div>
          )}

          {/* Empty State */}
          {metrics.transactionCount === 0 && (
            <div className="p-8 text-center bg-zinc-50 rounded-xl border border-zinc-200">
              <p className="text-zinc-600">No sales data available yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
