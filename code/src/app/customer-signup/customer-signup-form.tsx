'use client';

import { useState } from 'react';

type PreferenceDraft = {
  category: string;
  sizeLabel: string;
  fitPreference: string;
  preferredColors: string;
  preferredBrands: string;
  styleNotes: string;
};

const defaultPreference: PreferenceDraft = {
  category: 'Scrub tops',
  sizeLabel: '',
  fitPreference: '',
  preferredColors: '',
  preferredBrands: '',
  styleNotes: '',
};

function csv(value: string) {
  return value.split(',').map((part) => part.trim()).filter(Boolean).slice(0, 12);
}

export function CustomerSignupForm() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [preferences, setPreferences] = useState<PreferenceDraft[]>([defaultPreference]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const updatePreference = (index: number, patch: Partial<PreferenceDraft>) => {
    setPreferences((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('saving');
    setMessage('');
    try {
      const response = await fetch('/api/customer-self-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          email: email || undefined,
          phone: phone || undefined,
          marketingOptIn,
          preferences: preferences
            .filter((pref) => pref.category.trim())
            .map((pref) => ({
              category: pref.category.trim(),
              size_label: pref.sizeLabel.trim() || undefined,
              fit_preference: pref.fitPreference.trim() || undefined,
              preferred_colors: csv(pref.preferredColors),
              preferred_brands: csv(pref.preferredBrands),
              style_notes: pref.styleNotes.trim() || undefined,
            })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Could not save your profile.');
      }
      setStatus('saved');
      setMessage('Saved. Tell the cashier your name next time and we can find your preferences.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not save your profile.');
    }
  };

  return (
    <form onSubmit={submit} className="rounded-3xl border border-white/10 bg-white p-5 text-slate-950 shadow-2xl">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold">
          First name
          <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-3" />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Last name
          <input required value={lastName} onChange={(e) => setLastName(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-3" />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-3" />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Phone
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-3" />
        </label>
      </div>

      <div className="mt-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">Fit & style preferences</h2>
          <button
            type="button"
            onClick={() => setPreferences((prev) => [...prev, { ...defaultPreference, category: '' }])}
            className="rounded-xl bg-teal-100 px-3 py-2 text-xs font-black text-teal-800"
          >
            Add another
          </button>
        </div>
        {preferences.map((pref, index) => (
          <div key={index} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={pref.category} onChange={(e) => updatePreference(index, { category: e.target.value })} placeholder="Category e.g. Pants" className="rounded-xl border border-slate-300 px-3 py-2" />
              <input value={pref.sizeLabel} onChange={(e) => updatePreference(index, { sizeLabel: e.target.value })} placeholder="Size e.g. M, 8.5W" className="rounded-xl border border-slate-300 px-3 py-2" />
              <input value={pref.fitPreference} onChange={(e) => updatePreference(index, { fitPreference: e.target.value })} placeholder="Fit e.g. jogger, relaxed" className="rounded-xl border border-slate-300 px-3 py-2" />
              <input value={pref.preferredColors} onChange={(e) => updatePreference(index, { preferredColors: e.target.value })} placeholder="Preferred colors" className="rounded-xl border border-slate-300 px-3 py-2" />
              <input value={pref.preferredBrands} onChange={(e) => updatePreference(index, { preferredBrands: e.target.value })} placeholder="Preferred brands" className="rounded-xl border border-slate-300 px-3 py-2" />
              <input value={pref.styleNotes} onChange={(e) => updatePreference(index, { styleNotes: e.target.value })} placeholder="Notes" className="rounded-xl border border-slate-300 px-3 py-2" />
            </div>
          </div>
        ))}
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={marketingOptIn} onChange={(e) => setMarketingOptIn(e.target.checked)} className="mt-1" />
        Send me occasional updates or offers from the store.
      </label>

      <button disabled={status === 'saving'} className="mt-5 w-full rounded-2xl bg-teal-600 px-4 py-3 font-black text-white hover:bg-teal-700 disabled:opacity-50">
        {status === 'saving' ? 'Saving…' : 'Save my profile'}
      </button>
      {message && (
        <p className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${status === 'saved' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          {message}
        </p>
      )}
    </form>
  );
}
