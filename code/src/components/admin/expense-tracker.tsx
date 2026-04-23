'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from "@/lib/format";

interface Expense {
  id: string; category: string; description: string; amount: string; expense_date: string;
  is_recurring: boolean; recurrence_period: string | null; notes: string | null; location_name: string; created_at: string;
}
interface CategorySummary { category: string; total: string; count: number; }

const CATEGORIES = [
  { value: 'rent', label: 'Rent' }, { value: 'utilities', label: 'Utilities' },
  { value: 'payroll', label: 'Payroll' }, { value: 'supplies', label: 'Supplies' },
  { value: 'marketing', label: 'Marketing' }, { value: 'insurance', label: 'Insurance' },
  { value: 'maintenance', label: 'Maintenance' }, { value: 'shipping', label: 'Shipping' },
  { value: 'taxes', label: 'Taxes' }, { value: 'other', label: 'Other' },
];

const CAT_COLORS: Record<string, string> = {
  rent: 'bg-blue-100 text-blue-700', utilities: 'bg-amber-100 text-amber-700', payroll: 'bg-violet-100 text-violet-700',
  supplies: 'bg-teal-100 text-teal-700', marketing: 'bg-pink-100 text-pink-700', insurance: 'bg-sky-100 text-sky-700',
  maintenance: 'bg-orange-100 text-orange-700', shipping: 'bg-lime-100 text-lime-700', taxes: 'bg-red-100 text-red-700',
  other: 'bg-zinc-100 text-zinc-600',
};

export function ExpenseTracker() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<CategorySummary[]>([]);
  const [grandTotal, setGrandTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // R49: hydration fix — lazy initializers that read `new Date()` run
  // at render time on both the server and the client, but with
  // different wall-clocks if the user's machine drifts past a minute/
  // day boundary while the SSR payload is in flight. The resulting
  // hydration mismatch is logged as a client-side error. Mirror R47-M's
  // product-grid fix: initialize to empty, then set the real value in
  // a useEffect so both passes match.
  const [month, setMonth] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [form, setForm] = useState({
    category: 'supplies', description: '', amount: '', expense_date: '',
    is_recurring: false, recurrence_period: '', notes: '',
  });

  // R49: set the current month + default expense_date after mount so the
  // server-rendered HTML and the first client render agree. Without
  // this, a user loading the page near a day boundary sees a React
  // hydration warning (different ISO strings on server vs. client).
  useEffect(() => {
    const d = new Date();
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setForm((p) => p.expense_date ? p : { ...p, expense_date: d.toISOString().slice(0, 10) });
  }, []);

  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      if (catFilter) params.set('category', catFilter);
      const res = await fetch(`/api/expenses?${params}`);
      if (!res.ok) throw new Error('Failed to load expenses');
      const data = await res.json();
      setExpenses(data.expenses || []);
      setSummary(data.summary || []);
      setGrandTotal(data.grandTotal || 0);
    } catch { /* */ } finally { setLoading(false); }
  }, [month, catFilter]);

  useEffect(() => { fetchExpenses(); }, [fetchExpenses]);

  const handleSave = async () => {
    if (!form.description.trim() || !form.amount) { setMessage({ type: 'error', text: 'Description and amount required.' }); return; }
    setSaving(true); setMessage(null);
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount), recurrence_period: form.is_recurring ? form.recurrence_period : null }),
      });
      if (!res.ok) { const err = await res.json(); setMessage({ type: 'error', text: err.error }); return; }
      setMessage({ type: 'success', text: 'Expense added.' });
      setShowForm(false); fetchExpenses();
    } catch { setMessage({ type: 'error', text: 'Failed to save.' }); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch('/api/expenses', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      fetchExpenses();
    } catch { /* */ }
  };

  const update = (field: string, value: string | boolean) => setForm((p) => ({ ...p, [field]: value }));

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-white border border-zinc-200 p-3 text-center">
          <div className="text-2xl font-bold text-zinc-900">{formatCurrency(grandTotal)}</div>
          <div className="text-xs text-zinc-500 mt-1">Total for {month}</div>
        </div>
        {summary.slice(0, 3).map((s) => (
          <div key={s.category} className="rounded-xl bg-white border border-zinc-200 p-3 text-center">
            <div className="text-lg font-bold text-zinc-900">{formatCurrency(Number(s.total))}</div>
            <div className="text-xs text-zinc-500 mt-1 capitalize">{s.category} ({s.count})</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700" />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700">
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button onClick={() => { setShowForm(true); setMessage(null); setForm({ category: 'supplies', description: '', amount: '', expense_date: new Date().toISOString().slice(0, 10), is_recurring: false, recurrence_period: '', notes: '' }); }}
          /* R49: this onClick fires on user interaction (not during
             render), so `new Date()` here is safe — no hydration gap. */
          className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 ml-auto">+ Add Expense</button>
      </div>

      {message && <div role="alert" className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>{message.text}</div>}

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl bg-white border-2 border-teal-300 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-zinc-900 mb-4">New Expense</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Category</label>
              <select value={form.category} onChange={(e) => update('category', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-700">
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select></div>
            <div className="sm:col-span-2"><label className="block text-sm font-medium text-zinc-700 mb-1">Description <span className="text-red-500">*</span></label>
              <input type="text" value={form.description} onChange={(e) => update('description', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="e.g. Monthly rent payment" /></div>
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Amount <span className="text-red-500">*</span></label>
              <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">$</span>
                <input type="number" step="0.01" value={form.amount} onChange={(e) => update('amount', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white pl-7 pr-3 py-2.5 text-sm text-zinc-800" /></div></div>
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Date</label>
              <input type="date" value={form.expense_date} onChange={(e) => update('expense_date', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Recurring?</label>
              <div className="flex items-center gap-3 mt-1">
                <input type="checkbox" checked={form.is_recurring} onChange={(e) => update('is_recurring', e.target.checked)} className="rounded" />
                {form.is_recurring && (
                  <select value={form.recurrence_period} onChange={(e) => update('recurrence_period', e.target.value)} className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700">
                    <option value="">Period...</option>
                    <option value="weekly">Weekly</option><option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
                  </select>
                )}
              </div>
            </div>
            <div className="sm:col-span-3"><label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
              <input type="text" value={form.notes} onChange={(e) => update('notes', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="Optional" /></div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40">{saving ? 'Saving...' : 'Add Expense'}</button>
            <button onClick={() => setShowForm(false)} className="touch-button px-6 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      )}

      {/* Expense list */}
      {loading ? <div className="text-center py-8 text-zinc-400">Loading...</div> : expenses.length === 0 ? (
        <div className="text-center py-8 text-zinc-400">No expenses recorded for this period.</div>
      ) : (
        <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Date</th>
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Category</th>
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Description</th>
              <th className="text-right px-3 py-3 font-semibold text-zinc-700">Amount</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Recurring</th>
              <th className="w-12"></th>
            </tr></thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-zinc-100 hover:bg-zinc-50/50">
                  <td className="px-3 py-2.5 text-zinc-600 text-xs">{new Date(e.expense_date).toLocaleDateString()}</td>
                  <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${CAT_COLORS[e.category] || CAT_COLORS.other}`}>{e.category}</span></td>
                  <td className="px-3 py-2.5 text-zinc-800">{e.description}{e.notes && <span className="text-xs text-zinc-400 ml-1">— {e.notes}</span>}</td>
                  <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{formatCurrency(Number(e.amount))}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-zinc-500">{e.is_recurring ? e.recurrence_period : '—'}</td>
                  <td className="px-3 py-2.5"><button onClick={() => handleDelete(e.id)} className="text-red-400 hover:text-red-600 text-xs">&times;</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
