'use client';

import { useState, useMemo, useEffect } from 'react';
import { LocalStoreData } from '@/lib/persistence/types';
import { Mail, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatCurrency } from "@/lib/format";
import { authFetch } from '@/lib/api/client';

interface DigestSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  recipientEmails: string;
  sendTime: string;
}

interface ApiDigestConfig {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  recipients: string[];
  sendHour: number;
  lastDailySentOn: string | null;
  lastWeeklySentOn: string | null;
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
  largeDiscountCount: number;
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
  const [errorText, setErrorText] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<{ daily: string | null; weekly: string | null }>({ daily: null, weekly: null });

  // Load the persisted config (P3.2 — this panel was a stub until the
  // /api/sales-digest backend existed).
  useEffect(() => {
    (async () => {
      try {
        const r = await authFetch('/api/sales-digest');
        if (!r.ok) return;
        const d = (await r.json()) as { config?: ApiDigestConfig };
        if (!d.config) return;
        setSettings({
          dailyEnabled: d.config.dailyEnabled,
          weeklyEnabled: d.config.weeklyEnabled,
          recipientEmails: (d.config.recipients ?? []).join(', '),
          sendTime: `${String(d.config.sendHour ?? 8).padStart(2, '0')}:00`,
        });
        setLastSent({ daily: d.config.lastDailySentOn, weekly: d.config.lastWeeklySentOn });
      } catch { /* ignore — panel still usable */ }
    })();
  }, []);

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
    let largeDiscountCount = 0;

    // Filter to sale transactions (eventKind === "transaction_placeholder" with grand_total)
    transactions.forEach((tx) => {
      if (tx.eventKind !== "transaction_placeholder" || !tx.payload?.grand_total) return;
      const grandTotal = Number(tx.payload.grand_total ?? 0);
      const discountTotal = Number(tx.payload.discount_total ?? tx.payload.discountTotal ?? 0);
      const subtotal = Number(tx.payload.subtotal ?? 0);
      if (tx.payload?.is_return === "true") {
        returnsCount += 1;
        returnsAmount += Math.abs(grandTotal);
      } else {
        if (discountTotal >= 25 || (subtotal > 0 && discountTotal / subtotal >= 0.2)) largeDiscountCount += 1;
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
      largeDiscountCount,
      shiftCount: shifts.length,
    };
  }, [store]);

  const handleSettingChange = (key: keyof DigestSettings, value: string | boolean | number) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const toPayload = () => ({
    dailyEnabled: settings.dailyEnabled,
    weeklyEnabled: settings.weeklyEnabled,
    recipients: settings.recipientEmails.split(',').map((e) => e.trim()).filter(Boolean),
    sendHour: Math.min(23, Math.max(0, parseInt(settings.sendTime.split(':')[0] ?? '8', 10) || 8)),
  });

  const handleSaveSettings = async () => {
    setSaveStatus('saving');
    setErrorText(null);
    try {
      const r = await authFetch('/api/sales-digest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload()),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setSaveStatus('success');
      } else {
        setErrorText((d as { error?: string }).error ?? 'Save failed');
        setSaveStatus('error');
      }
    } catch {
      setErrorText('Save failed — network error');
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 4000);
  };

  const handleSendTestEmail = async () => {
    if (!settings.recipientEmails.trim()) {
      setErrorText('Add at least one recipient first');
      setTestEmailStatus('error');
      setTimeout(() => setTestEmailStatus('idle'), 3000);
      return;
    }
    setTestEmailStatus('sending');
    setErrorText(null);
    try {
      // Save first so the test goes to exactly what's persisted.
      const save = await authFetch('/api/sales-digest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload()),
      });
      if (!save.ok) {
        const d = await save.json().catch(() => ({}));
        setErrorText((d as { error?: string }).error ?? 'Save failed');
        setTestEmailStatus('error');
        setTimeout(() => setTestEmailStatus('idle'), 4000);
        return;
      }
      const r = await authFetch('/api/sales-digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setTestEmailStatus('success');
      } else {
        setErrorText((d as { error?: string }).error ?? 'Test send failed');
        setTestEmailStatus('error');
      }
    } catch {
      setErrorText('Test send failed — network error');
      setTestEmailStatus('error');
    }
    setTimeout(() => setTestEmailStatus('idle'), 4000);
  };

  const isConfigured = settings.dailyEnabled || settings.weeklyEnabled;
  const recipientList = settings.recipientEmails
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
  const previewInventory = store.inventory || [];

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

          {/* Last-sent info */}
          {(lastSent.daily || lastSent.weekly) && (
            <p className="text-sm text-zinc-500">
              {lastSent.daily && <>Last daily digest covered <span className="font-medium text-zinc-700">{lastSent.daily}</span>. </>}
              {lastSent.weekly && <>Last weekly digest covered the week ending <span className="font-medium text-zinc-700">{lastSent.weekly}</span>.</>}
            </p>
          )}

          {/* Save / test status */}
          {(saveStatus !== 'idle' || testEmailStatus !== 'idle') && (
            <div
              className={`flex items-center gap-3 p-4 rounded-xl ${
                saveStatus === 'success' || testEmailStatus === 'success'
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : saveStatus === 'error' || testEmailStatus === 'error'
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'bg-blue-50 text-blue-700 border border-blue-200'
              }`}
            >
              {(saveStatus === 'success' || testEmailStatus === 'success') && <CheckCircle2 className="w-5 h-5 flex-shrink-0" />}
              {(saveStatus === 'error' || testEmailStatus === 'error') && <AlertCircle className="w-5 h-5 flex-shrink-0" />}
              <span className="text-sm font-medium">
                {saveStatus === 'saving' && 'Saving settings…'}
                {testEmailStatus === 'sending' && 'Sending test digest…'}
                {saveStatus === 'success' && 'Settings saved.'}
                {testEmailStatus === 'success' && 'Test digest sent — check your inbox.'}
                {(saveStatus === 'error' || testEmailStatus === 'error') && (errorText ?? 'Something went wrong.')}
              </span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="text-sm font-semibold text-zinc-900">Test-send readiness</p>
            <p className="mt-1 text-sm text-zinc-600">
              {recipientList.length > 0 && isConfigured
                ? 'Ready to save and send a test digest to the configured recipients.'
                : 'Enable a digest and add at least one recipient before sending a test email.'}
            </p>
          </div>

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

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h4 className="mb-3 flex items-center gap-2 font-semibold text-amber-950">
              <AlertCircle className="h-4 w-4" />
              Manager Alert Preview
            </h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-lg bg-white p-3 border border-amber-100">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Stockouts</p>
                <p className="mt-1 text-2xl font-bold text-amber-950">{previewInventory.filter((item) => item.onHand <= 0).length}</p>
              </div>
              <div className="rounded-lg bg-white p-3 border border-amber-100">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Large discounts</p>
                <p className="mt-1 text-2xl font-bold text-amber-950">{metrics.largeDiscountCount}</p>
              </div>
              <div className="rounded-lg bg-white p-3 border border-amber-100">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Cash variance</p>
                <p className="mt-1 text-2xl font-bold text-amber-950">{formatCurrency(metrics.cashVariance)}</p>
              </div>
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
