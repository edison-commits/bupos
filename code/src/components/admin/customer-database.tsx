'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { formatCurrency } from "@/lib/format";
// R52-L: step-up re-auth prompt when editing sensitive customer
// fields (phone, email, address, notes). Server /api/customers PUT
// gates on bucketKey:'customer-update-stepup' when any of these
// fields change; prior UI didn't thread actorPassword so every
// sensitive-field edit threw. Low-blast-radius fields (name) stay
// cookie-only.
import { usePasswordGate } from "@/components/shared/password-gate";

interface Customer {
  id: string; first_name: string; last_name: string; email: string | null; phone: string | null;
  address: string | null; notes: string | null; loyalty_points: number; total_spend: string;
  visit_count: number; store_credit_balance: string; is_active: boolean;
  last_visit_at: string | null; created_at: string;
}

export function CustomerDatabase() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', address: '', notes: '' });
  const [promptPassword, passwordGate] = usePasswordGate();

  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (timeout.current) clearTimeout(timeout.current); };
  }, [search]);

  // R34-D11: AbortController so rapid typing doesn't race prior
  // in-flight fetches. Prior shape let an old request resolve after
  // the newer one, overwriting `customers` with stale results.
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchCustomers = useCallback(async (page: number) => {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await fetch(`/api/customers?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error('Failed to load customers');
      const data = await res.json();
      if (!ctrl.signal.aborted) {
        setCustomers(data.customers || []);
        setPagination(data.pagination || { page: 1, pageSize: 50, total: 0, totalPages: 0 });
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => { fetchCustomers(1); }, [fetchCustomers]);

  const openNew = () => {
    setEditing(null); setForm({ first_name: '', last_name: '', email: '', phone: '', address: '', notes: '' });
    setShowForm(true); setMessage(null);
  };
  const openEdit = (c: Customer) => {
    setEditing(c); setForm({ first_name: c.first_name, last_name: c.last_name, email: c.email || '', phone: c.phone || '', address: c.address || '', notes: c.notes || '' });
    setShowForm(true); setMessage(null);
  };

  const handleSave = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) { setMessage({ type: 'error', text: 'First and last name required.' }); return; }
    // R52-L: on edit, detect sensitive-field change and prompt for
    // step-up password. On create (editing === null), no step-up
    // needed — server only gates on PUT. Compare against the cached
    // `editing` snapshot (the DB value at load-time); any drift in
    // phone/email/address/notes triggers the prompt.
    let actorPassword: string | undefined;
    if (editing) {
      const priorEmail = editing.email ?? '';
      const priorPhone = editing.phone ?? '';
      const priorAddress = editing.address ?? '';
      const priorNotes = editing.notes ?? '';
      const sensitiveChanged =
        priorEmail !== form.email ||
        priorPhone !== form.phone ||
        priorAddress !== form.address ||
        priorNotes !== form.notes;
      if (sensitiveChanged) {
        const pwd = await promptPassword({
          title: `Update ${editing.first_name} ${editing.last_name}'s contact details?`,
          description:
            "Changing phone, email, address, or notes is PII-sensitive and requires step-up re-auth. Confirm with your password.",
          confirmLabel: "Save changes",
          confirmVariant: "default",
        });
        if (!pwd) return;
        actorPassword = pwd;
      }
    }
    setSaving(true); setMessage(null);
    try {
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { id: editing.id, ...form, ...(actorPassword ? { actorPassword } : {}) }
        : form;
      const res = await fetch('/api/customers', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        // R78-FE-M: .catch fallback so a non-JSON body doesn't
        // throw from res.json() and become a generic
        // "Failed to save" instead of the actual server error.
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessage({ type: 'error', text: err.error ?? 'Unknown error' });
        return;
      }
      setMessage({ type: 'success', text: editing ? 'Customer updated.' : 'Customer added.' });
      setShowForm(false); fetchCustomers(pagination.page);
    } catch { setMessage({ type: 'error', text: 'Failed to save.' }); }
    finally { setSaving(false); }
  };

  const update = (field: string, value: string) => setForm((p) => ({ ...p, [field]: value }));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" strokeWidth="2" /><path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round" /></svg>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers..."
            className="w-full rounded-lg border border-zinc-300 bg-white pl-10 pr-4 py-2.5 text-sm text-zinc-800 placeholder-zinc-400" />
        </div>
        <button onClick={openNew} className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800">+ Add Customer</button>
      </div>

      <div className="text-sm text-zinc-600">{pagination.total} customer{pagination.total !== 1 ? 's' : ''}{debouncedSearch && ` matching "${debouncedSearch}"`}</div>

      {message && <div role="alert" className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>{message.text}</div>}

      {showForm && (
        <div className="rounded-xl bg-white border-2 border-teal-300 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-zinc-900 mb-4">{editing ? 'Edit Customer' : 'New Customer'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">First Name <span className="text-red-500">*</span></label>
              <input type="text" value={form.first_name} onChange={(e) => update('first_name', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Last Name <span className="text-red-500">*</span></label>
              <input type="text" value={form.last_name} onChange={(e) => update('last_name', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Email</label>
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div><label className="block text-sm font-medium text-zinc-700 mb-1">Phone</label>
              <input type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div className="sm:col-span-2"><label className="block text-sm font-medium text-zinc-700 mb-1">Address</label>
              <input type="text" value={form.address} onChange={(e) => update('address', e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
            <div className="sm:col-span-2"><label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
              <textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" /></div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40">
              {saving ? 'Saving...' : editing ? 'Update' : 'Add Customer'}</button>
            <button onClick={() => setShowForm(false)} className="touch-button px-6 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-zinc-400">Loading...</div> : customers.length === 0 ? (
        <div className="text-center py-8 text-zinc-400">{debouncedSearch ? 'No results found.' : 'No customers yet.'}</div>
      ) : (
        <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Name</th>
              <th className="text-left px-3 py-3 font-semibold text-zinc-700">Contact</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Points</th>
              <th className="text-right px-3 py-3 font-semibold text-zinc-700">Total Spent</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Visits</th>
              <th className="text-right px-3 py-3 font-semibold text-zinc-700">Credit</th>
              <th className="text-center px-3 py-3 font-semibold text-zinc-700">Since</th>
              <th className="w-16"></th>
            </tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className={`border-b border-zinc-100 hover:bg-zinc-50/50 ${!c.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2.5"><span className="font-medium text-zinc-900">{c.first_name} {c.last_name}</span></td>
                  <td className="px-3 py-2.5 text-zinc-600 text-xs">
                    {c.email && <div>{c.email}</div>}
                    {c.phone && <div>{c.phone}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-center"><span className="px-2 py-0.5 rounded-full text-xs font-bold bg-violet-100 text-violet-700">{c.loyalty_points}</span></td>
                  <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{formatCurrency(Number(c.total_spend))}</td>
                  <td className="px-3 py-2.5 text-center text-zinc-600">{c.visit_count}</td>
                  <td className="px-3 py-2.5 text-right text-zinc-600">{formatCurrency(Number(c.store_credit_balance))}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-zinc-500">{new Date(c.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2.5"><button onClick={() => openEdit(c)} className="touch-button px-2 py-1 rounded text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-700">Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => fetchCustomers(pagination.page - 1)} disabled={pagination.page <= 1}
            className="touch-button px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-sm text-zinc-700 disabled:opacity-40">&larr; Prev</button>
          <span className="px-3 py-1.5 text-sm text-zinc-500">Page {pagination.page} of {pagination.totalPages}</span>
          <button onClick={() => fetchCustomers(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages}
            className="touch-button px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-sm text-zinc-700 disabled:opacity-40">Next &rarr;</button>
        </div>
      )}
      {/* R52-L: <PasswordGate> renders nothing when inactive. */}
      {passwordGate}
    </div>
  );
}
