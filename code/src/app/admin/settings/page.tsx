'use client';


import { useState, useEffect } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';
import { getTaxRate, getCitiesForState, US_STATES } from '@/lib/tax-rates';
import { authFetch } from '@/lib/api/client';
import { FETCH_TIMEOUT_MS } from '@/lib/config/timing';
import { formatCurrency } from "@/lib/format";
// R53: step-up re-auth when tax rate changes. Server /api/settings
// PUT gates bucketKey:'tax-rate-stepup' specifically on taxRate
// drift; other location fields (name/address/city/phone/etc) stay
// cookie-only. Prior UI didn't thread actorPassword so every
// tax-rate edit threw.
import { usePasswordGate } from "@/components/shared/password-gate";

interface StoreSettings {
  store: {
    name: string;
    legalName: string;
    phone: string;
    email: string;
    website: string;
    timezone: string;
    currencyCode: string;
  };
  location: {
    name: string;
    code: string;
    address1: string;
    city: string;
    region: string;
    postalCode: string;
    phone: string;
    taxRate: number;
    isActive: boolean;
  };
  receipt: {
    header: string;
    footer: string;
    storeName: string;
    storeAddress: string;
    storeCity: string;
    storeRegion: string;
    storePostalCode: string;
    storePhone: string;
  };
  customerDisplay: {
    displayName: string;
    welcomeText: string;
    idleMessage: string;
    accentColor: string;
  };
}

const EMPTY_SETTINGS: StoreSettings = {
  store: {
    name: '',
    legalName: '',
    phone: '',
    email: '',
    website: '',
    timezone: 'UTC',
    currencyCode: 'USD',
  },
  location: {
    name: '',
    code: '',
    address1: '',
    city: '',
    region: '',
    postalCode: '',
    phone: '',
    taxRate: 0,
    isActive: true,
  },
  receipt: {
    header: '',
    footer: '',
    storeName: '',
    storeAddress: '',
    storeCity: '',
    storeRegion: '',
    storePostalCode: '',
    storePhone: '',
  },
  customerDisplay: {
    displayName: '',
    welcomeText: 'Welcome',
    idleMessage: 'Ready to checkout',
    accentColor: '#14b8a6',
  },
};

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-lg shadow p-6">
          <div className="h-8 bg-gray-200 rounded w-1/3 mb-6"></div>
          <div className="space-y-4">
            {[1, 2, 3, 4].map((j) => (
              <div key={j}>
                <div className="h-4 bg-gray-200 rounded w-1/4 mb-2"></div>
                <div className="h-10 bg-gray-100 rounded"></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3 items-start">
      <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
      <div>
        <h3 className="font-semibold text-red-900">Error</h3>
        <p className="text-red-700 text-sm">{message}</p>
      </div>
    </div>
  );
}

function StoreSection({
  data,
  isEditing,
  isSaving,
  onEdit,
  onCancel,
  onSave,
  error,
}: {
  data: StoreSettings['store'];
  isEditing: boolean;
  isSaving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (data: StoreSettings['store']) => Promise<void>;
  error: string | null;
}) {
  const [formData, setFormData] = useState<StoreSettings['store']>(data);

  useEffect(() => {
    setFormData(data);
  }, [data, isEditing]);

  const handleChange = (field: keyof StoreSettings['store'], value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    await onSave(formData);
  };

  if (!isEditing) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Store Info</h2>
          <button
            onClick={onEdit}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium"
          >
            Edit
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="text-sm font-medium text-gray-600">Store Name</label>
            <p className="text-lg text-gray-900 mt-1">{data.name || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Legal Name</label>
            <p className="text-lg text-gray-900 mt-1">{data.legalName || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Phone</label>
            <p className="text-lg text-gray-900 mt-1">{data.phone || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Email</label>
            <p className="text-lg text-gray-900 mt-1">{data.email || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Website</label>
            <p className="text-lg text-gray-900 mt-1">{data.website || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Timezone</label>
            <p className="text-lg text-gray-900 mt-1">{data.timezone}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Currency</label>
            <p className="text-lg text-gray-900 mt-1">{data.currencyCode}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Store Info</h2>
      </div>

      {error && <ErrorAlert message={error} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Store Name
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => handleChange('name', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Legal Name
          </label>
          <input
            type="text"
            value={formData.legalName}
            onChange={(e) => handleChange('legalName', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Phone
          </label>
          <input
            type="tel"
            value={formData.phone}
            onChange={(e) => handleChange('phone', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Email
          </label>
          <input
            type="email"
            value={formData.email}
            onChange={(e) => handleChange('email', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Website
          </label>
          <input
            type="url"
            value={formData.website}
            onChange={(e) => handleChange('website', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Timezone
          </label>
          <select
            value={formData.timezone}
            onChange={(e) => handleChange('timezone', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          >
            <option value="UTC">UTC</option>
            <option value="America/New_York">America/New_York</option>
            <option value="America/Chicago">America/Chicago</option>
            <option value="America/Denver">America/Denver</option>
            <option value="America/Los_Angeles">America/Los_Angeles</option>
            <option value="Europe/London">Europe/London</option>
            <option value="Europe/Paris">Europe/Paris</option>
            <option value="Asia/Tokyo">Asia/Tokyo</option>
            <option value="Australia/Sydney">Australia/Sydney</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Currency Code
          </label>
          <select
            value={formData.currencyCode}
            onChange={(e) => handleChange('currencyCode', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          >
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CAD">CAD</option>
            <option value="AUD">AUD</option>
            <option value="JPY">JPY</option>
          </select>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 transition font-medium flex items-center gap-2"
        >
          <Check size={18} /> Save
        </button>
        <button
          onClick={onCancel}
          disabled={isSaving}
          className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg hover:bg-gray-400 disabled:bg-gray-200 transition font-medium flex items-center gap-2"
        >
          <X size={18} /> Cancel
        </button>
      </div>
    </div>
  );
}

function LocationSection({
  data,
  isEditing,
  isSaving,
  onEdit,
  onCancel,
  onSave,
  error,
}: {
  data: StoreSettings['location'];
  isEditing: boolean;
  isSaving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (data: StoreSettings['location']) => Promise<void>;
  error: string | null;
}) {
  const [formData, setFormData] = useState<StoreSettings['location']>(data);
  const [suggestedRate, setSuggestedRate] = useState<number | null>(null);

  useEffect(() => {
    setFormData(data);
  }, [data, isEditing]);

  // Recalculate suggested rate when city or region changes
  useEffect(() => {
    if (formData.region) {
      const rate = getTaxRate(formData.city, formData.region);
      setSuggestedRate(rate);
    } else {
      setSuggestedRate(null);
    }
  }, [formData.city, formData.region]);

  const handleChange = (
    field: keyof StoreSettings['location'],
    value: string | number | boolean
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    await onSave(formData);
  };

  if (!isEditing) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Location Details</h2>
          <button
            onClick={onEdit}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium"
          >
            Edit
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="text-sm font-medium text-gray-600">Location Name</label>
            <p className="text-lg text-gray-900 mt-1">{data.name || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Location Code</label>
            <p className="text-lg text-gray-900 mt-1">{data.code || '—'}</p>
          </div>
          <div className="md:col-span-2">
            <label className="text-sm font-medium text-gray-600">Address</label>
            <p className="text-lg text-gray-900 mt-1">{data.address1 || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">City</label>
            <p className="text-lg text-gray-900 mt-1">{data.city || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">State</label>
            <p className="text-lg text-gray-900 mt-1">{US_STATES.find(s => s.code === data.region)?.name ?? data.region ?? '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Postal Code</label>
            <p className="text-lg text-gray-900 mt-1">{data.postalCode || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Phone</label>
            <p className="text-lg text-gray-900 mt-1">{data.phone || '—'}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Tax Rate</label>
            {/* R58-0: DB stores tax_rate as a decimal (0.0875), GET
                returns it as-is, but the display label is "%" — so
                show it scaled ×100 to match. Prior shape rendered
                "0.09%" for an 8.75% tax. */}
            <p className="text-lg text-gray-900 mt-1">{(data.taxRate * 100).toFixed(2)}%</p>
            {suggestedRate !== null && suggestedRate !== data.taxRate && (
              <p className="text-xs text-zinc-400 mt-0.5">
                Suggested: {(suggestedRate * 100).toFixed(2)}% for {data.city}
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Status</label>
            <p className="text-lg mt-1">
              {data.isActive ? (
                <span className="inline-flex items-center px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full text-sm font-medium">
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center px-3 py-1 bg-gray-200 text-gray-800 rounded-full text-sm font-medium">
                  Inactive
                </span>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Location Details</h2>
      </div>

      {error && <ErrorAlert message={error} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Location Name
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => handleChange('name', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Location Code
          </label>
          <input
            type="text"
            value={formData.code}
            onChange={(e) => handleChange('code', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Address
          </label>
          <input
            type="text"
            value={formData.address1}
            onChange={(e) => handleChange('address1', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            State
          </label>
          <select
            value={formData.region}
            onChange={(e) => {
              handleChange('region', e.target.value);
              handleChange('city', '');
            }}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          >
            <option value="">Select state…</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            City
          </label>
          <select
            value={formData.city}
            onChange={(e) => handleChange('city', e.target.value)}
            disabled={!formData.region}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:bg-gray-100"
          >
            <option value="">Select city…</option>
            {formData.region && (() => {
              const knownCities = getCitiesForState(formData.region);
              const _cityIsKnown = knownCities.includes(formData.city);
              return knownCities.map((city) => (
                <option key={city} value={city}>{city}</option>
              ));
            })()}
            {formData.city && !getCitiesForState(formData.region).includes(formData.city) && (
              <option value={formData.city}>{formData.city} (saved)</option>
            )}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Postal Code
          </label>
          <input
            type="text"
            value={formData.postalCode}
            onChange={(e) => handleChange('postalCode', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Phone
          </label>
          <input
            type="tel"
            value={formData.phone}
            onChange={(e) => handleChange('phone', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tax Rate
          </label>
          <div className="flex gap-2">
            {/* R58-0: convert decimal (stored) <-> percent (UI) at
                the input boundary. formData.taxRate stays in the DB
                shape (0.0875 for 8.75%) so handleSaveLocation can
                pass it straight through to /api/settings; the input
                displays and parses percent. */}
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={Number((formData.taxRate * 100).toFixed(4))}
              onChange={(e) => handleChange('taxRate', (parseFloat(e.target.value) || 0) / 100)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              placeholder="e.g. 8.75"
            />
            {suggestedRate !== null && suggestedRate !== formData.taxRate && (
              <button
                type="button"
                // R58-0: `suggestedRate` is already a decimal (0.0875
                // for 8.75%) from getTaxRate(). formData.taxRate is
                // now the stored decimal too, so "Apply" just copies
                // the suggested value. Prior shape multiplied by 100
                // (making formData.taxRate = 8.75, a 875% rate).
                onClick={() => handleChange('taxRate', suggestedRate)}
                className="shrink-0 px-3 py-2 text-sm font-semibold bg-teal-50 text-teal-700 rounded-lg hover:bg-teal-100 border border-teal-200 transition-colors"
                title={`Apply ${(suggestedRate * 100).toFixed(2)}%`}
              >
                Apply {(suggestedRate * 100).toFixed(2)}%
              </button>
            )}
          </div>
          {suggestedRate !== null && (
            <p className="text-xs text-zinc-500 mt-1">
              {formData.city && formData.region
                ? `Suggested combined rate for ${formData.city}, ${formData.region}: ${(suggestedRate * 100).toFixed(2)}%`
                : `Select city & state to see suggested rate`}
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
          <select
            value={formData.isActive ? 'active' : 'inactive'}
            onChange={(e) => handleChange('isActive', e.target.value === 'active')}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 transition font-medium flex items-center gap-2"
        >
          <Check size={18} /> Save
        </button>
        <button
          onClick={onCancel}
          disabled={isSaving}
          className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg hover:bg-gray-400 disabled:bg-gray-200 transition font-medium flex items-center gap-2"
        >
          <X size={18} /> Cancel
        </button>
      </div>
    </div>
  );
}

function ReceiptPreview({
  header,
  footer,
  storeName,
  storeAddress,
  storeCity,
  storeRegion,
  storePostalCode,
  storePhone,
}: {
  header: string;
  footer: string;
  storeName: string;
  storeAddress: string;
  storeCity: string;
  storeRegion: string;
  storePostalCode: string;
  storePhone: string;
}) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const SAMPLE_ITEMS = [
    { name: 'Cotton Crew Neck T-Shirt (L)', qty: 2, price: 24.99 },
    { name: 'Slim Fit Denim Jeans (32)', qty: 1, price: 49.99 },
    { name: 'Canvas Sneakers (M)', qty: 1, price: 34.99 },
  ];
  const subtotal = SAMPLE_ITEMS.reduce((s, i) => s + i.qty * i.price, 0);
  const tax = subtotal * 0.0875;
  const total = subtotal + tax;

  return (
    <div
      className="rounded-xl shadow-xl w-72 overflow-hidden"
      style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', fontFamily: 'monospace' }}
    >
      {/* Receipt paper */}
      <div className="p-4" style={{ backgroundColor: '#fefefe' }}>
        {/* Tear line */}
        <div className="flex items-center gap-1 mb-4">
          <div className="flex-1 border-t-2 border-dashed border-gray-300" />
          <span className="text-xs text-gray-400 uppercase tracking-widest px-2">receipt</span>
          <div className="flex-1 border-t-2 border-dashed border-gray-300" />
        </div>

        {/* Header text */}
        {header ? (
          <p className="text-center text-xs mb-3 whitespace-pre-wrap" style={{ color: '#374151' }}>{header}</p>
        ) : null}

        {/* Store info */}
        <div className="text-center text-sm font-bold mb-1" style={{ color: '#111827' }}>
          {storeName || 'Store Name'}
        </div>
        {storeAddress ? <div className="text-center text-xs mb-1" style={{ color: '#6b7280' }}>{storeAddress}</div> : null}
        {storeCity || storeRegion || storePostalCode
          ? <div className="text-center text-xs mb-1" style={{ color: '#6b7280' }}>
              {[storeCity, storeRegion, storePostalCode].filter(Boolean).join(', ')}
            </div>
          : null}
        {storePhone ? <div className="text-center text-xs mb-3" style={{ color: '#6b7280' }}>{storePhone}</div> : null}

        {/* Date/time */}
        <div className="flex justify-between text-xs mb-3" style={{ color: '#374151' }}>
          <span>{dateStr}</span>
          <span>{timeStr}</span>
          <span>TRANS-001</span>
        </div>

        {/* Divider */}
        <div className="border-t border-dashed border-gray-300 mb-3" />

        {/* Column headers */}
        <div className="flex justify-between text-xs font-bold mb-1" style={{ color: '#374151' }}>
          <span>ITEM</span>
          <span>AMT</span>
        </div>
        <div className="border-t border-dashed border-gray-200 mb-2" />

        {/* Sample items */}
        {SAMPLE_ITEMS.map((item, i) => (
          <div key={i} className="mb-2">
            <div className="flex justify-between items-start">
              <div className="text-xs" style={{ color: '#374151' }}>
                <span className="font-bold">{item.qty}x</span> {item.name}
              </div>
              <div className="text-xs font-bold whitespace-nowrap ml-2" style={{ color: '#374151' }}>
                {formatCurrency((item.qty * item.price))}
              </div>
            </div>
          </div>
        ))}

        {/* Divider */}
        <div className="border-t border-dashed border-gray-300 mt-3 mb-3" />

        {/* Totals */}
        <div className="space-y-1 mb-3">
          <div className="flex justify-between text-xs" style={{ color: '#374151' }}>
            <span>Subtotal</span>
            <span>{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between text-xs" style={{ color: '#374151' }}>
            <span>Tax (8.75%)</span>
            <span>{formatCurrency(tax)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold border-t border-gray-200 pt-1 mt-1" style={{ color: '#111827' }}>
            <span>TOTAL</span>
            <span>{formatCurrency(total)}</span>
          </div>
          <div className="flex justify-between text-xs mt-1" style={{ color: '#374151' }}>
            <span>VISA **** 4242</span>
            <span>{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-dashed border-gray-300 mb-3" />

        {/* Footer text */}
        {footer ? (
          <p className="text-center text-xs whitespace-pre-wrap" style={{ color: '#6b7280' }}>{footer}</p>
        ) : (
          <p className="text-center text-xs italic" style={{ color: '#9ca3af' }}>No footer configured</p>
        )}

        {/* Barcode placeholder */}
        <div className="mt-4 flex justify-center">
          <div className="flex gap-px">
            {[4,2,3,1,5,2,4,1,3,2,4,3,1,5,2,3,4,1,2,3,4,5,1,2,3,4,5,2,3,4,1,3,5,2,4].map((w, i) => (
              <div key={i} style={{ width: w, height: 32, backgroundColor: '#111827' }} />
            ))}
          </div>
        </div>

        {/* Tear line */}
        <div className="flex items-center gap-1 mt-4">
          <div className="flex-1 border-t-2 border-dashed border-gray-300" />
          <div className="flex-1 border-t-2 border-dashed border-gray-300" />
        </div>
      </div>
    </div>
  );
}

function ReceiptSection({
  data,
  isEditing,
  isSaving,
  onEdit,
  onCancel,
  onSave,
  error,
}: {
  data: StoreSettings['receipt'];
  isEditing: boolean;
  isSaving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (data: StoreSettings['receipt']) => Promise<void>;
  error: string | null;
}) {
  const [formData, setFormData] = useState<StoreSettings['receipt']>(data);

  useEffect(() => {
    setFormData(data);
  }, [data, isEditing]);

  const handleChange = (field: keyof StoreSettings['receipt'], value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    await onSave(formData);
  };

  if (!isEditing) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Receipt Settings</h2>
          <button
            onClick={onEdit}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium"
          >
            Edit
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label className="text-sm font-medium text-gray-600">Header Text</label>
            <div className="mt-2 p-4 bg-gray-50 rounded-lg border border-gray-200 min-h-24 whitespace-pre-wrap text-gray-900">
              {data.header || '(No header text configured)'}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600">Footer Text</label>
            <div className="mt-2 p-4 bg-gray-50 rounded-lg border border-gray-200 min-h-24 whitespace-pre-wrap text-gray-900">
              {data.footer || '(No footer text configured)'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Receipt Settings</h2>
      </div>

      {error && <ErrorAlert message={error} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left: form */}
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Store Info on Receipt
            </label>
            <div className="space-y-3">
              <input
                type="text"
                value={formData.storeName}
                onChange={(e) => handleChange('storeName', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                placeholder="Store name (e.g. BasicUniformPOS)"
              />
              <input
                type="text"
                value={formData.storeAddress}
                onChange={(e) => handleChange('storeAddress', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                placeholder="Street address (e.g. 123 Main Street)"
              />
              <div className="grid grid-cols-3 gap-3">
                <input
                  type="text"
                  value={formData.storeCity}
                  onChange={(e) => handleChange('storeCity', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                  placeholder="City"
                />
                <input
                  type="text"
                  value={formData.storeRegion}
                  onChange={(e) => handleChange('storeRegion', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                  placeholder="State"
                />
                <input
                  type="text"
                  value={formData.storePostalCode}
                  onChange={(e) => handleChange('storePostalCode', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                  placeholder="ZIP"
                />
              </div>
              <input
                type="text"
                value={formData.storePhone}
                onChange={(e) => handleChange('storePhone', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                placeholder="Phone (e.g. (555) 123-4567)"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Header Text
            </label>
            <textarea
              value={formData.header}
              onChange={(e) => handleChange('header', e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono text-sm"
              placeholder="Text to display at the top of receipts..."
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Footer Text
            </label>
            <textarea
              value={formData.footer}
              onChange={(e) => handleChange('footer', e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono text-sm"
              placeholder="Text to display at the bottom of receipts..."
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 transition font-medium flex items-center gap-2"
            >
              <Check size={18} /> Save
            </button>
            <button
              onClick={onCancel}
              disabled={isSaving}
              className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg hover:bg-gray-400 disabled:bg-gray-200 transition font-medium flex items-center gap-2"
            >
              <X size={18} /> Cancel
            </button>
          </div>
        </div>

        {/* Right: live receipt preview */}
        <div className="flex flex-col">
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Live Preview</p>
          <div className="flex-1 flex justify-center">
            <ReceiptPreview
              header={formData.header}
              footer={formData.footer}
              storeName={formData.storeName}
              storeAddress={formData.storeAddress}
              storeCity={formData.storeCity}
              storeRegion={formData.storeRegion}
              storePostalCode={formData.storePostalCode}
              storePhone={formData.storePhone}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerDisplayPreview({ data, fallbackName }: { data: StoreSettings['customerDisplay']; fallbackName: string }) {
  const accentColor = data.accentColor || '#14b8a6';
  return (
    <div className="overflow-hidden rounded-2xl bg-slate-950 p-6 text-white shadow-xl">
      <div className="mb-8 text-center">
        <div className="mb-4 text-5xl font-black" style={{ color: accentColor }}>◆</div>
        <h3 className="text-3xl font-bold">{data.displayName || fallbackName || 'Store Name'}</h3>
      </div>
      <p className="text-center text-2xl text-slate-200">{data.welcomeText || 'Welcome'}</p>
      <p className="mt-3 text-center text-lg text-slate-400">{data.idleMessage || 'Ready to checkout'}</p>
      <div className="mt-8 rounded-xl border border-slate-700 bg-slate-900 p-4">
        <div className="flex justify-between text-sm text-slate-300"><span>Sample total</span><span>$48.00</span></div>
        <div className="mt-3 h-2 rounded-full" style={{ backgroundColor: accentColor }} />
      </div>
    </div>
  );
}

function CustomerDisplaySection({
  data,
  fallbackName,
  isEditing,
  isSaving,
  onEdit,
  onCancel,
  onSave,
  error,
}: {
  data: StoreSettings['customerDisplay'];
  fallbackName: string;
  isEditing: boolean;
  isSaving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (data: StoreSettings['customerDisplay']) => Promise<void>;
  error: string | null;
}) {
  const [formData, setFormData] = useState<StoreSettings['customerDisplay']>(data);
  useEffect(() => { setFormData(data); }, [data, isEditing]);
  const handleChange = (field: keyof StoreSettings['customerDisplay'], value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  if (!isEditing) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Customer Display Branding</h2>
            <p className="mt-1 text-sm text-gray-500">Customize the idle and checkout screen customers see at the register.</p>
          </div>
          <button onClick={onEdit} className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium">Edit</button>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div><label className="text-sm font-medium text-gray-600">Display Name</label><p className="text-lg text-gray-900 mt-1">{data.displayName || fallbackName || '—'}</p></div>
            <div><label className="text-sm font-medium text-gray-600">Welcome Text</label><p className="text-lg text-gray-900 mt-1">{data.welcomeText || 'Welcome'}</p></div>
            <div><label className="text-sm font-medium text-gray-600">Idle Message</label><p className="text-lg text-gray-900 mt-1">{data.idleMessage || 'Ready to checkout'}</p></div>
            <div><label className="text-sm font-medium text-gray-600">Accent Color</label><p className="text-lg text-gray-900 mt-1">{data.accentColor || '#14b8a6'}</p></div>
          </div>
          <CustomerDisplayPreview data={data} fallbackName={fallbackName} />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="mb-6 text-2xl font-bold text-gray-900">Customer Display Branding</h2>
      {error && <ErrorAlert message={error} />}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Display Name</label>
            <input value={formData.displayName} onChange={(e) => handleChange('displayName', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500" placeholder={fallbackName || 'Store name'} />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Welcome Text</label>
            <input value={formData.welcomeText} onChange={(e) => handleChange('welcomeText', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500" placeholder="Welcome" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Idle Message</label>
            <input value={formData.idleMessage} onChange={(e) => handleChange('idleMessage', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500" placeholder="Ready to checkout" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Accent Color</label>
            <input type="color" value={formData.accentColor || '#14b8a6'} onChange={(e) => handleChange('accentColor', e.target.value)} className="h-11 w-24 rounded-lg border border-gray-300 p-1" />
          </div>
          <div className="flex gap-3">
            <button onClick={() => onSave(formData)} disabled={isSaving} className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 transition font-medium flex items-center gap-2"><Check size={18} /> Save</button>
            <button onClick={onCancel} disabled={isSaving} className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg hover:bg-gray-400 disabled:bg-gray-200 transition font-medium flex items-center gap-2"><X size={18} /> Cancel</button>
          </div>
        </div>
        <CustomerDisplayPreview data={formData} fallbackName={fallbackName} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<StoreSettings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [editingSection, setEditingSection] = useState<'store' | 'location' | 'receipt' | 'customerDisplay' | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string | null>>({
    store: null,
    location: null,
    receipt: null,
    customerDisplay: null,
  });
  const [promptPassword, passwordGate] = usePasswordGate();
  // SEC-AUDIT7-CRIT1: the signed per-store /register terminal link.
  const [terminalLink, setTerminalLink] = useState<string | null>(null);
  const [terminalCopied, setTerminalCopied] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/register-terminal-link', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { path?: string } | null) => {
        if (!cancelled && d?.path) setTerminalLink(`${window.location.origin}${d.path}`);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      setGlobalError(null);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await authFetch('/api/settings', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
      } catch (e) {
        clearTimeout(timeout);
        throw e;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch settings');
      }
      const data: StoreSettings = await response.json();
      setSettings(data);
    } catch (error) {
      setGlobalError(
        error instanceof Error ? error.message : 'An error occurred while loading settings'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSaveStore = async (data: StoreSettings['store']) => {
    try {
      setSavingSection('store');
      setSectionErrors((prev) => ({ ...prev, store: null }));

      const response = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'store', data }),
      });

      if (!response.ok) {
        throw new Error('Failed to save store settings');
      }

      const updated: StoreSettings = await response.json();
      setSettings(updated);
      setEditingSection(null);
    } catch (error) {
      setSectionErrors((prev) => ({
        ...prev,
        store: error instanceof Error ? error.message : 'An error occurred',
      }));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveLocation = async (data: StoreSettings['location']) => {
    // R53: compare the submitted taxRate against the snapshot fetched
    // from the server. If it drifted, the server will require
    // step-up; prompt for password and thread it through. Any other
    // location-field drift (name, address, etc.) stays cookie-only.
    let actorPassword: string | undefined;
    // R56-LOW: epsilon-based comparison (1e-6) matches the server's
    // `Math.abs(priorTax - taxRate) > 0.00005` rule in
    // updateLocationAction. Exact float inequality would prompt on
    // JSON-deserialized drift (e.g. 0.0875 round-trip) even when the
    // user didn't touch the field.
    if (Math.abs(data.taxRate - settings.location.taxRate) > 1e-6) {
      const pwd = await promptPassword({
        // R58-0: taxRate is a decimal (0.0875 for 8.75%); display as
        // percent so the prompt matches what the user just typed.
        title: `Change tax rate to ${(data.taxRate * 100).toFixed(2)}%?`,
        description:
          "Tax-rate changes affect every future sale at this location and flow through to your tax report. Confirm with your password.",
        confirmLabel: "Save tax rate",
        confirmVariant: "default",
      });
      if (!pwd) return;
      actorPassword = pwd;
    }
    try {
      setSavingSection('location');
      setSectionErrors((prev) => ({ ...prev, location: null }));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let updated: StoreSettings;
      try {
        const response = await authFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            section: 'location',
            data,
            ...(actorPassword ? { actorPassword } : {}),
          }),
          signal: controller.signal,
          cache: 'no-store',
        });
        clearTimeout(timeout);
        // R64-M1 / R66-L4 / R68-L2: surface the server's 409 drift
        // message AND refresh the local snapshot BEFORE throwing so
        // the user's next retry operates on the fresh DB value. The
        // server re-reads `priorTaxSnap` from DB on every request
        // (so a retry without refresh still works — the server is
        // the source of truth), but the UI also does a client-side
        // snapshot-compare to decide whether to PROMPT for password
        // before sending; that prompt decision needs the fresh
        // baseline or the retry prompts even when no change was
        // made. Awaiting ensures the `setSettings` lands before the
        // thrown error unwinds to the catch + setSectionErrors.
        if (response.status === 409) {
          const body = await response.json().catch(() => ({ error: 'Location tax rate was changed by another user. Please refresh and try again.' }));
          await fetchSettings();
          throw new Error(body.error || 'Location tax rate was changed by another user. Please refresh and try again.');
        }
        if (!response.ok) {
          throw new Error('Failed to save location settings');
        }
        updated = await response.json();
      } catch (e) {
        clearTimeout(timeout);
        throw e;
      }
      setSettings(updated);
      setEditingSection(null);
    } catch (error) {
      setSectionErrors((prev) => ({
        ...prev,
        location: error instanceof Error ? error.message : 'An error occurred',
      }));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveReceipt = async (data: StoreSettings['receipt']) => {
    try {
      setSavingSection('receipt');
      setSectionErrors((prev) => ({ ...prev, receipt: null }));

      const response = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'receipt', data }),
      });

      if (!response.ok) {
        throw new Error('Failed to save receipt settings');
      }

      const updated: StoreSettings = await response.json();
      setSettings(updated);
      setEditingSection(null);
    } catch (error) {
      setSectionErrors((prev) => ({
        ...prev,
        receipt: error instanceof Error ? error.message : 'An error occurred',
      }));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveCustomerDisplay = async (data: StoreSettings['customerDisplay']) => {
    try {
      setSavingSection('customerDisplay');
      setSectionErrors((prev) => ({ ...prev, customerDisplay: null }));

      const response = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'customerDisplay', data }),
      });

      if (!response.ok) {
        throw new Error('Failed to save customer display settings');
      }

      await fetchSettings();
      setEditingSection(null);
    } catch (error) {
      setSectionErrors((prev) => ({
        ...prev,
        customerDisplay: error instanceof Error ? error.message : 'An error occurred',
      }));
    } finally {
      setSavingSection(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto px-6 pt-6 pb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-8">Settings</h1>
          <LoadingSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 pt-6 pb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Settings</h1>

        {globalError && (
          <div className="mb-6">
            <ErrorAlert message={globalError} />
          </div>
        )}

        <div className="space-y-6">
          {/* SEC-AUDIT7-CRIT1: per-store register terminal link */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900">Register terminal link</h2>
            <p className="mt-1 text-sm text-gray-600">
              Open this link on each register device to enable the tap-your-name
              clock-in for <strong>this store</strong>. Keep it private — anyone
              with the link can see this store&apos;s roster and clock in a
              cashier. It only ever works for your store, never another tenant.
            </p>
            {terminalLink ? (
              <div className="mt-3 flex items-center gap-2">
                <input
                  readOnly
                  value={terminalLink}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-800"
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(terminalLink);
                    setTerminalCopied(true);
                    setTimeout(() => setTerminalCopied(false), 2000);
                  }}
                  className="flex-shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  {terminalCopied ? "Copied!" : "Copy"}
                </button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-400">Loading…</p>
            )}
          </div>

          <StoreSection
            data={settings.store}
            isEditing={editingSection === 'store'}
            isSaving={savingSection === 'store'}
            onEdit={() => setEditingSection('store')}
            onCancel={() => setEditingSection(null)}
            onSave={handleSaveStore}
            error={sectionErrors.store}
          />

          <LocationSection
            data={settings.location}
            isEditing={editingSection === 'location'}
            isSaving={savingSection === 'location'}
            onEdit={() => setEditingSection('location')}
            onCancel={() => setEditingSection(null)}
            onSave={handleSaveLocation}
            error={sectionErrors.location}
          />

          <ReceiptSection
            data={settings.receipt}
            isEditing={editingSection === 'receipt'}
            isSaving={savingSection === 'receipt'}
            onEdit={() => setEditingSection('receipt')}
            onCancel={() => setEditingSection(null)}
            onSave={handleSaveReceipt}
            error={sectionErrors.receipt}
          />

          <CustomerDisplaySection
            data={settings.customerDisplay}
            fallbackName={settings.store.name}
            isEditing={editingSection === 'customerDisplay'}
            isSaving={savingSection === 'customerDisplay'}
            onEdit={() => setEditingSection('customerDisplay')}
            onCancel={() => setEditingSection(null)}
            onSave={handleSaveCustomerDisplay}
            error={sectionErrors.customerDisplay}
          />
        </div>
      </div>
      {/* R53: shared password gate renders nothing until prompted. */}
      {passwordGate}
    </div>
  );
}