'use client';

import { useState, useEffect, useCallback } from 'react';
// R52-M: step-up re-auth on supplier PUT (both edits and active
// toggle). Server /api/suppliers PUT unconditionally requires
// step-up — prior UI didn't prompt so every edit and every toggle
// threw. Mirror the gift-card-manager pattern.
import { usePasswordGate } from "@/components/shared/password-gate";

interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export function SupplierManager() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [form, setForm] = useState({ name: '', contact_name: '', email: '', phone: '', address: '', notes: '' });
  const [promptPassword, passwordGate] = usePasswordGate();

  const fetchSuppliers = useCallback(async () => {
    try {
      const res = await fetch('/api/suppliers');
      if (!res.ok) throw new Error('Failed to load suppliers');
      const data = await res.json();
      setSuppliers(data.suppliers || []);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load suppliers' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSuppliers(); }, [fetchSuppliers]);

  const openNew = () => {
    setEditing(null);
    setForm({ name: '', contact_name: '', email: '', phone: '', address: '', notes: '' });
    setShowForm(true);
    setMessage(null);
  };

  const openEdit = (s: Supplier) => {
    setEditing(s);
    setForm({
      name: s.name,
      contact_name: s.contact_name || '',
      email: s.email || '',
      phone: s.phone || '',
      address: s.address || '',
      notes: s.notes || '',
    });
    setShowForm(true);
    setMessage(null);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: 'Supplier name is required.' });
      return;
    }
    // R52-M: on edit (PUT), prompt for step-up password. On create
    // (POST), server skips step-up so skip the prompt.
    let actorPassword: string | undefined;
    if (editing) {
      const pwd = await promptPassword({
        title: `Update supplier "${editing.name}"?`,
        description:
          "Supplier edits affect purchase orders and vendor payables. Confirm with your password.",
        confirmLabel: "Save supplier",
        confirmVariant: "default",
      });
      if (!pwd) return;
      actorPassword = pwd;
    }
    setSaving(true);
    setMessage(null);
    try {
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { id: editing.id, ...form, ...(actorPassword ? { actorPassword } : {}) }
        : form;
      const res = await fetch('/api/suppliers', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // R78-FE-M: .catch fallback on non-JSON response bodies
        // so proxy timeouts / HTML error pages surface as an
        // HTTP-status hint instead of throwing into the outer
        // generic "Failed to save" catch.
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessage({ type: 'error', text: err.error || 'Failed to save' });
        return;
      }
      setMessage({ type: 'success', text: editing ? 'Supplier updated.' : 'Supplier added.' });
      setShowForm(false);
      fetchSuppliers();
    } catch {
      setMessage({ type: 'error', text: 'Failed to save supplier.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: Supplier) => {
    // R52-M: activate/deactivate is a PUT → server gates on step-up.
    const pwd = await promptPassword({
      title: s.is_active ? `Deactivate "${s.name}"?` : `Reactivate "${s.name}"?`,
      description:
        "Toggling supplier status affects PO eligibility. Confirm with your password.",
      confirmLabel: s.is_active ? "Deactivate" : "Reactivate",
      confirmVariant: s.is_active ? "destructive" : "default",
    });
    if (!pwd) return;
    try {
      const res = await fetch('/api/suppliers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, name: s.name, is_active: !s.is_active, actorPassword: pwd }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to toggle' }));
        setMessage({ type: 'error', text: err.error || 'Failed to toggle supplier' });
        return;
      }
      fetchSuppliers();
    } catch {
      setMessage({ type: 'error', text: 'Failed to toggle supplier.' });
    }
  };

  const update = (field: string, value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-600">{suppliers.length} supplier{suppliers.length !== 1 ? 's' : ''}</span>
        <button onClick={openNew} className="touch-button px-4 py-2 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800">
          + Add Supplier
        </button>
      </div>

      {message && (
        <div role="alert" className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="rounded-xl bg-white border-2 border-teal-300 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-zinc-900 mb-4">{editing ? 'Edit Supplier' : 'New Supplier'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1">Company Name <span className="text-red-500">*</span></label>
              <input type="text" value={form.name} onChange={(e) => update('name', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="e.g. Pacific Denim Co." />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Contact Name</label>
              <input type="text" value={form.contact_name} onChange={(e) => update('contact_name', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="John Smith" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Email</label>
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="orders@supplier.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Phone</label>
              <input type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="(555) 123-4567" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Address</label>
              <input type="text" value={form.address} onChange={(e) => update('address', e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="123 Main St, City, ST 12345" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
              <textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} rows={2}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800" placeholder="Payment terms, lead times, etc." />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving}
              className="touch-button px-6 py-2.5 rounded-lg bg-teal-700 text-white font-semibold text-sm hover:bg-teal-800 disabled:opacity-40">
              {saving ? 'Saving...' : editing ? 'Update Supplier' : 'Add Supplier'}
            </button>
            <button onClick={() => setShowForm(false)}
              className="touch-button px-6 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Supplier List */}
      {loading ? (
        <div className="text-center py-8 text-zinc-400">Loading suppliers...</div>
      ) : suppliers.length === 0 ? (
        <div className="text-center py-8 text-zinc-400">No suppliers yet. Add your first supplier above.</div>
      ) : (
        <div className="space-y-2">
          {suppliers.map((s) => (
            <div key={s.id} className={`rounded-xl border p-4 flex items-center gap-4 ${s.is_active ? 'border-zinc-200 bg-white' : 'border-zinc-100 bg-zinc-50 opacity-60'}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-zinc-900">{s.name}</span>
                  {!s.is_active && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-zinc-200 text-zinc-500">Inactive</span>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-sm text-zinc-500">
                  {s.contact_name && <span>{s.contact_name}</span>}
                  {s.email && <span>{s.email}</span>}
                  {s.phone && <span>{s.phone}</span>}
                </div>
                {s.address && <div className="text-xs text-zinc-400 mt-0.5">{s.address}</div>}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => openEdit(s)} className="touch-button px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-700">Edit</button>
                <button onClick={() => toggleActive(s)} className={`touch-button px-3 py-1.5 rounded-lg text-xs font-medium ${s.is_active ? 'bg-amber-100 hover:bg-amber-200 text-amber-700' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700'}`}>
                  {s.is_active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* R52-M: <PasswordGate> renders nothing when inactive. */}
      {passwordGate}
    </div>
  );
}
