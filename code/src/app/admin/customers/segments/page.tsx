'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';
import { formatCurrency } from '@/lib/format';

type SegmentKey = 'all' | 'win_back' | 'loyalty_ready' | 'high_value' | 'saved_preferences_no_recent_purchase' | 'marketing_opt_in';

interface SegmentSummary {
  key: SegmentKey;
  label: string;
  count: number;
}

interface SegmentCustomer {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  loyalty_points: number;
  total_spend: string | number;
  visit_count: number;
  last_purchase_at?: string | null;
  preference_count: number;
  marketing_opt_in: boolean;
}

const SEGMENT_LABELS: Record<SegmentKey, string> = {
  all: 'All customers',
  win_back: 'Win-back',
  loyalty_ready: 'Loyalty ready',
  high_value: 'High value',
  saved_preferences_no_recent_purchase: 'Saved preferences, no recent purchase',
  marketing_opt_in: 'Marketing opt-in',
};

const SEGMENT_HELP: Record<SegmentKey, string> = {
  all: 'All active customers for broad exports or list review.',
  win_back: 'Customers with a completed purchase more than 90 days ago.',
  loyalty_ready: 'Customers with at least 100 loyalty points available.',
  high_value: 'Customers with $500+ lifetime spend.',
  saved_preferences_no_recent_purchase: 'Customers with saved sizes/style preferences and no purchase in the last 30 days.',
  marketing_opt_in: 'Customers who opted into marketing through signup or staff notes.',
};

function dateLabel(value?: string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString();
}

export default function CustomerSegmentsPage() {
  const [segment, setSegment] = useState<SegmentKey>('win_back');
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [customers, setCustomers] = useState<SegmentCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeSegment = useMemo(
    () => segments.find((item) => item.key === segment),
    [segment, segments],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/customers/segments?segment=${segment}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load marketing segments');
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSegments(data.segments ?? []);
        setCustomers(data.customers ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load marketing segments');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [segment]);

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <Link href="/admin/customers" className="text-sm font-medium text-blue-600 hover:text-blue-800">← Customers</Link>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">Marketing Segments</h1>
            <p className="mt-1 text-sm text-slate-600">Find win-back, loyalty, high-value, and saved-preference customer groups for email/SMS campaign exports.</p>
          </div>
          <a
            href={`/api/customers/segments?segment=${segment}&format=csv`}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Export segment CSV
          </a>
        </div>

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          {segments.map((item) => (
            <button
              key={item.key}
              onClick={() => setSegment(item.key)}
              className={`rounded-2xl border p-4 text-left shadow-sm transition ${
                segment === item.key ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.label}</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{item.count}</p>
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">{activeSegment?.label ?? SEGMENT_LABELS[segment]}</h2>
              <p className="mt-1 text-sm text-slate-500">{SEGMENT_HELP[segment]}</p>
            </div>
            <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700">
              {customers.length} shown
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-slate-500">Loading customer segment…</div>
          ) : customers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">No customers currently match this segment.</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3 text-right">Spend</th>
                    <th className="px-4 py-3 text-right">Points</th>
                    <th className="px-4 py-3 text-right">Visits</th>
                    <th className="px-4 py-3">Last purchase</th>
                    <th className="px-4 py-3 text-right">Prefs</th>
                    <th className="px-4 py-3">Opt-in</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {customers.map((customer) => (
                    <tr key={customer.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-semibold text-slate-900">{customer.first_name} {customer.last_name}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{customer.email || 'No email'}</div>
                        <div className="text-xs text-slate-400">{customer.phone || 'No phone'}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-700">{formatCurrency(Number(customer.total_spend || 0))}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{customer.loyalty_points}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{customer.visit_count}</td>
                      <td className="px-4 py-3 text-slate-600">{dateLabel(customer.last_purchase_at)}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{customer.preference_count}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${customer.marketing_opt_in ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                          {customer.marketing_opt_in ? 'Yes' : 'No'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
