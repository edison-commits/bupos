'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Eye, AlertCircle, Loader2, Users } from 'lucide-react';
import { authFetch } from '@/lib/api/client';
import { formatCurrency } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { safeErr } from "@/lib/logging/safe-err";
import { usePasswordGate } from "@/components/shared/password-gate";
import { KpiCard } from "@/components/ui/kpi-card";
interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  loyalty_points: number;
  total_spend: string | number;
  visit_count: number;
  store_credit_balance: string | number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface Transaction {
  id: string;
  created_at: string;
  total_due: string | number;
  total_paid: string | number;
}

interface PaginationState {
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

type ModalMode = 'create' | 'edit' | 'detail' | null;

export default function CustomerManagement() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [pagination, setPagination] = useState<PaginationState>({
    pageSize: 50,
    nextCursor: null,
    hasMore: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [promptPassword, passwordGate] = usePasswordGate();
  const [deleting, setDeleting] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stats, setStats] = useState({ totalCustomers: 0, newThisMonth: 0, avgSpend: 0, totalPointsOutstanding: 0 });
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    address: '',
    notes: '',
  });


  const loadCustomers = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        pageSize: pagination.pageSize.toString(),
        ...(debouncedSearch && { search: debouncedSearch }),
      });

      const response = await authFetch(`/api/customers?${params}`);
      if (!response.ok) {
        throw new Error('Failed to load customers');
      }

      const data = await response.json();
      setCustomers(data.customers);
      setPagination({ pageSize: pagination.pageSize, nextCursor: data.nextCursor, hasMore: data.hasMore });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreCustomers = async () => {
    if (!pagination.nextCursor) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        pageSize: pagination.pageSize.toString(),
        cursor: pagination.nextCursor,
        ...(search && { search }),
      });

      const response = await authFetch(`/api/customers?${params}`);
      if (!response.ok) {
        throw new Error('Failed to load more customers');
      }

      const data = await response.json();
      setCustomers((prev) => [...prev, ...data.customers]);
      setPagination({ pageSize: pagination.pageSize, nextCursor: data.nextCursor, hasMore: data.hasMore });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more customers');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const params = new URLSearchParams({ stats: 'true' });
      if (search) params.set('search', search);
      const res = await authFetch(`/api/customers?${params}`);
      if (!res.ok) return;
      const { total, newThisMonth, avgSpend, totalPointsOutstanding } = await res.json();
      setStats({
        totalCustomers: total,
        newThisMonth: newThisMonth ?? 0,
        avgSpend: avgSpend ?? 0,
        totalPointsOutstanding: totalPointsOutstanding ?? 0,
      });
    } catch (err) {
      console.error('Failed to load stats:', safeErr(err));
    }
  };

  useEffect(() => {
    loadCustomers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.pageSize, debouncedSearch]);

  // Stats don't depend on search — load once on mount, not every keystroke.
  useEffect(() => {
    loadStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setFormData({
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      address: '',
      notes: '',
    });
  };

  const openEditModal = (customer: Customer) => {
    setSelectedCustomer(customer);
    setFormData({
      first_name: customer.first_name || '',
      last_name: customer.last_name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || '',
      notes: customer.notes || '',
    });
    setModalMode('edit');
  };

  const openDetailModal = async (customer: Customer) => {
    setSelectedCustomer(customer);
    setModalMode('detail');
    setDetailLoading(true);
    try {
      const response = await authFetch(`/api/customers?id=${customer.id}`);
      if (!response.ok) throw new Error('Failed to load customer details');

      const data = await response.json();
      setSelectedCustomer(data.customer);
      setTransactions(data.transactions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customer details');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    // R53: step-up re-auth when editing PII-sensitive fields. Mirror
    // the R52-L pattern from src/components/admin/customer-database.
    // Create (POST) has no step-up; PUT gates on
    // bucketKey:'customer-update-stepup' when any of email, phone,
    // address, or notes changes relative to the loaded customer.
    let actorPassword: string | undefined;
    if (modalMode === 'edit' && selectedCustomer) {
      const priorEmail = selectedCustomer.email ?? '';
      const priorPhone = selectedCustomer.phone ?? '';
      const priorAddress = selectedCustomer.address ?? '';
      const priorNotes = selectedCustomer.notes ?? '';
      const sensitiveChanged =
        priorEmail !== formData.email ||
        priorPhone !== formData.phone ||
        priorAddress !== formData.address ||
        priorNotes !== formData.notes;
      if (sensitiveChanged) {
        const pwd = await promptPassword({
          title: `Update ${selectedCustomer.first_name} ${selectedCustomer.last_name}'s contact details?`,
          description:
            "Changing phone, email, address, or notes is PII-sensitive and requires step-up re-auth. Confirm with your password.",
          confirmLabel: "Save changes",
          confirmVariant: "default",
        });
        if (!pwd) return;
        actorPassword = pwd;
      }
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const method = modalMode === 'create' ? 'POST' : 'PUT';
      const body = modalMode === 'create'
        ? formData
        : {
            id: selectedCustomer?.id,
            ...formData,
            ...(actorPassword ? { actorPassword } : {}),
          };

      const response = await authFetch('/api/customers', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `Failed to ${modalMode === 'create' ? 'create' : 'update'} customer`);
      }

      setSuccess(`Customer ${modalMode === 'create' ? 'created' : 'updated'} successfully!`);
      setModalMode(null);
      resetForm();
      loadCustomers();
      loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  // R41-1: customer anonymization / right-to-be-forgotten. Uses the
  // shared PasswordGate for step-up, calls the R39-A1-1 DELETE route
  // which NULL-anonymizes in place (does NOT hard-delete — financial
  // history is preserved per tax-retention norms).
  const handleAnonymize = async () => {
    if (!selectedCustomer || deleting) return;
    const pwd = await promptPassword({
      title: `Anonymize ${selectedCustomer.first_name} ${selectedCustomer.last_name}?`,
      description:
        "Scrubs this customer's name, email, phone, address, and notes. Transaction history and financial records are preserved. This is the GDPR/CCPA right-to-be-forgotten action and cannot be undone.",
      confirmLabel: "Anonymize",
      confirmVariant: "destructive",
    });
    if (!pwd) return;
    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await authFetch('/api/customers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedCustomer.id, actorPassword: pwd }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to anonymize customer');
      }
      setSuccess('Customer anonymized.');
      setModalMode(null);
      resetForm();
      loadCustomers();
      loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
        <AdminTopNav />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Customers</h1>
            <p className="mt-2 text-gray-600">Manage customer profiles, loyalty points, and purchase history</p>
          </div>
          <button
            onClick={() => {
              resetForm();
              setModalMode('create');
            }}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-4 text-white hover:bg-emerald-700 transition-colors font-medium"
          >
            <Plus className="h-5 w-5" />
            Add Customer
          </button>
        </div>

        {/* Summary Cards */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Total Customers" value={stats.totalCustomers} />
          <KpiCard label="New This Month" value={stats.newThisMonth} />
          <KpiCard label="Avg Spend" value={formatCurrency(stats.avgSpend)} />
          <KpiCard label="Total Points Outstanding" value={stats.totalPointsOutstanding.toLocaleString()} />
        </div>

        {/* Error and Success Messages */}
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-lg bg-red-50 p-4 border border-red-200">
            <AlertCircle className="h-5 w-5 text-red-600" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}
        {success && (
          <div className="mb-6 flex items-center gap-3 rounded-lg bg-emerald-50 p-4 border border-emerald-200">
            <div className="h-5 w-5 text-emerald-600">
              <svg fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-sm text-emerald-800">{success}</p>
          </div>
        )}

        {/* Search */}
        <div className="mb-6 flex gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, email, or phone..."
              aria-label="Search customers"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPagination({ ...pagination, nextCursor: null, hasMore: true });
              }}
              className="w-full rounded-lg border border-gray-300 pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        {/* Customers Table */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex h-96 items-center justify-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
              <p className="text-gray-600">Loading customers...</p>
            </div>
          ) : customers.length === 0 ? (
            <div className="flex h-96 flex-col items-center justify-center gap-2">
              <Users className="h-12 w-12 text-gray-300" />
              <p className="text-gray-600">No customers found</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Name</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Contact</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Visits</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Total Spend</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Loyalty Points</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Store Credit</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((customer, idx) => (
                      <tr key={customer.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-6 py-4 text-sm font-medium text-gray-900">
                          {customer.first_name} {customer.last_name}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          <div className="text-xs">{customer.email}</div>
                          <div className="text-xs text-gray-500">{customer.phone}</div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-900 font-medium">{customer.visit_count}</td>
                        <td className="px-6 py-4 text-sm text-gray-900 font-medium">{formatCurrency(customer.total_spend)}</td>
                        <td className="px-6 py-4 text-sm text-emerald-600 font-medium">{customer.loyalty_points.toLocaleString()}</td>
                        <td className="px-6 py-4 text-sm text-teal-600 font-medium">{formatCurrency(customer.store_credit_balance)}</td>
                        <td className="px-6 py-4 text-sm">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                            customer.is_active
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-gray-100 text-gray-800'
                          }`}>
                            {customer.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <div className="flex gap-2">
                            <button
                              onClick={() => openDetailModal(customer)}
                              className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 transition-colors"
                              title="View details"
                            >
                              <Eye className="h-5 w-5" />
                            </button>
                            <button
                              onClick={() => openEditModal(customer)}
                              className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 transition-colors"
                              title="Edit"
                            >
                              <Edit2 className="h-5 w-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
                <p className="text-sm text-gray-600">
                  {customers.length} customers loaded
                </p>
                <div className="flex gap-2">
                  {pagination.hasMore ? (
                    <button
                      onClick={loadMoreCustomers}
                      className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                      Load More
                    </button>
                  ) : (
                    <span className="text-sm text-gray-500 px-4 py-2">No more customers</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-xl font-bold text-gray-900 mb-6">
              {modalMode === 'create' ? 'Add New Customer' : 'Edit Customer'}
            </h2>

            <form onSubmit={handleCreateOrUpdate} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="First Name"
                  aria-label="First Name"
                  required
                  value={formData.first_name}
                  onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  aria-label="Last Name"
                  required
                  value={formData.last_name}
                  onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <input
                type="email"
                placeholder="Email"
                aria-label="Email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <input
                type="tel"
                placeholder="Phone"
                aria-label="Phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <input
                type="text"
                placeholder="Address"
                aria-label="Address"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <textarea
                placeholder="Notes"
                aria-label="Notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 rounded-lg bg-emerald-600 px-5 py-4 text-white font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Saving...' : modalMode === 'create' ? 'Create' : 'Update'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModalMode(null);
                    resetForm();
                  }}
                  className="flex-1 rounded-2xl border-2 border-gray-300 px-5 py-4 text-lg font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {/* R41-1: right-to-be-forgotten control, edit-mode only.
                  Separate row + destructive styling so it's not
                  confused with the regular Update / Cancel buttons. */}
              {modalMode === 'edit' && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={handleAnonymize}
                    disabled={deleting}
                    className="w-full rounded-lg border-2 border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    {deleting ? 'Anonymizing…' : 'Anonymize customer (right-to-be-forgotten)'}
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {modalMode === 'detail' && selectedCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg max-h-96 overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              {selectedCustomer.first_name} {selectedCustomer.last_name}
            </h2>

            {detailLoading ? (
              <div className="flex items-center justify-center gap-3 py-8">
                <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
                <p className="text-gray-600">Loading details...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Customer Info */}
                <div className="grid grid-cols-2 gap-4 border-b border-gray-200 pb-4">
                  <div>
                    <p className="text-xs font-medium text-gray-600">Email</p>
                    <p className="mt-1 text-sm text-gray-900">{selectedCustomer.email || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-600">Phone</p>
                    <p className="mt-1 text-sm text-gray-900">{selectedCustomer.phone || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-600">Total Spend</p>
                    <p className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(selectedCustomer.total_spend)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-600">Visits</p>
                    <p className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.visit_count}</p>
                  </div>
                </div>

                {/* Loyalty Section */}
                <div className="border-b border-gray-200 pb-4">
                  <h3 className="mb-3 font-semibold text-gray-900">Loyalty</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-lg bg-emerald-50 p-3 border border-emerald-200">
                      <p className="text-xs font-medium text-emerald-600">Loyalty Points</p>
                      <p className="mt-1 text-2xl font-bold text-emerald-700">{selectedCustomer.loyalty_points.toLocaleString()}</p>
                    </div>
                    <div className="rounded-lg bg-teal-50 p-3 border border-teal-200">
                      <p className="text-xs font-medium text-teal-600">Store Credit</p>
                      <p className="mt-1 text-2xl font-bold text-teal-700">{formatCurrency(selectedCustomer.store_credit_balance)}</p>
                    </div>
                  </div>
                </div>

                {/* Purchase History */}
                <div>
                  <h3 className="mb-3 font-semibold text-gray-900">Recent Transactions</h3>
                  {transactions.length === 0 ? (
                    <p className="text-sm text-gray-600">No transactions yet</p>
                  ) : (
                    <div className="space-y-2">
                      {transactions.slice(0, 5).map((txn) => (
                        <div key={txn.id} className="flex justify-between items-center text-sm p-2 rounded bg-gray-50">
                          <div>
                            <p className="text-gray-900 font-medium">{formatDate(txn.created_at)}</p>
                          </div>
                          <p className="text-gray-900 font-semibold">{formatCurrency(txn.total_paid)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-3 pt-4 border-t border-gray-200">
                  <button
                    onClick={() => openEditModal(selectedCustomer)}
                    className="flex-1 rounded-lg bg-emerald-600 px-5 py-4 text-white font-medium hover:bg-emerald-700 transition-colors"
                  >
                    Edit Customer
                  </button>
                  <button
                    onClick={() => setModalMode(null)}
                    className="flex-1 rounded-2xl border-2 border-gray-300 px-5 py-4 text-lg font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* R41-1: mount the shared password-gate modal; it renders
          nothing until a destructive action asks for a password. */}
      {passwordGate}
    </div>
  );
}
