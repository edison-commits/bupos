'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Lock, Eye, EyeOff } from 'lucide-react';
import { authFetch } from '@/lib/api/client';
import { FETCH_TIMEOUT_MS } from '@/lib/config/timing';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';

const ROLES: Record<string, { label: string; color: string }> = {
  owner: { label: 'Owner', color: 'bg-red-100 text-red-800' },
  manager: { label: 'Manager', color: 'bg-blue-100 text-blue-800' },
  cashier: { label: 'Cashier', color: 'bg-green-100 text-green-800' },
  inventory_clerk: { label: 'Inventory', color: 'bg-yellow-100 text-yellow-800' },
  support: { label: 'Support', color: 'bg-purple-100 text-purple-800' },
};

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  roleKey: string;
  isActive: boolean;
  locationIds: string[];
  pinHint: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type ModalMode = 'create' | 'edit' | 'reset-pin' | null;

export default function EmployeeManagement() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string; code?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [showPinModal, setShowPinModal] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    displayName: '',
    email: '',
    phone: '',
    roleKey: 'cashier',
    pin: '',
    pinHint: '',
    locationIds: [] as string[],
  });


  const loadEmployees = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        ...(debouncedSearch && { search: debouncedSearch }),
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let data;
      try {
        const response = await authFetch(`/api/employees?${params}`, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Failed to load employees`);
        }
        data = await response.json();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Request timed out — please try again');
        }
        throw err;
      }
      setEmployees(data.employees);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load employees');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEmployees();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.page, debouncedSearch]);

  // Load the org's locations once so "create employee" can assign the
  // correct location ID instead of a hardcoded UUID.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/locations', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const locs: Array<{ id: string; name: string; code?: string }> = data.locations || [];
        setLocations(locs);
        // Default the create-form to all available locations so assignment is explicit
        setFormData((prev) => (
          prev.locationIds.length === 0 && locs.length > 0
            ? { ...prev, locationIds: locs.map((l) => l.id) }
            : prev
        ));
      } catch {
        // If locations API fails, user can still type — form just has no defaults
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const resetForm = () => {
    setFormData({
      firstName: '',
      lastName: '',
      displayName: '',
      email: '',
      phone: '',
      roleKey: 'cashier',
      pin: '',
      pinHint: '',
      locationIds: [] as string[],
    });
  };

  const handleCreateEmployee = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authFetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create employee');
      }

      setSuccess('Employee created successfully');
      setModalMode(null);
      resetForm();
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create employee');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateEmployee = async () => {
    if (!selectedEmployee) return;
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await authFetch('/api/employees', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedEmployee.id,
          ...formData,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update employee');
      }

      setSuccess('Employee updated successfully');
      setModalMode(null);
      resetForm();
      setSelectedEmployee(null);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update employee');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPin = async () => {
    if (!selectedEmployee) return;
    setError(null);

    try {
      const response = await authFetch('/api/employees', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reset-pin',
          id: selectedEmployee.id,
          pin: formData.pin,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to reset PIN');
      }

      setSuccess('PIN reset successfully');
      setShowPinModal(false);
      setFormData({ ...formData, pin: '' });
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset PIN');
    }
  };

  const handleToggleStatus = async (employee: Employee) => {
    try {
      const response = await authFetch('/api/employees', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle-status',
          id: employee.id,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update employee status');
      }

      setSuccess(`Employee ${employee.isActive ? 'deactivated' : 'activated'}`);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const openCreateModal = () => {
    resetForm();
    setSelectedEmployee(null);
    setModalMode('create');
  };

  const openEditModal = (employee: Employee) => {
    setSelectedEmployee(employee);
    setFormData({
      firstName: employee.firstName,
      lastName: employee.lastName,
      displayName: employee.displayName,
      email: employee.email || '',
      phone: '',
      roleKey: employee.roleKey,
      pin: '',
      pinHint: employee.pinHint,
      locationIds: employee.locationIds,
    });
    setModalMode('edit');
  };

  const openResetPinModal = (employee: Employee) => {
    setSelectedEmployee(employee);
    setShowPinModal(true);
    setFormData({ ...formData, pin: '' });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
        <AdminTopNav />
      {/* Success Alert */}
      {success && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
          <div className="flex items-center justify-between">
            <span>{success}</span>
            <button
              onClick={() => setSuccess(null)}
              className="text-emerald-600 hover:text-emerald-800"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          <div className="flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-600 hover:text-red-800"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <h1 className="text-3xl font-bold text-slate-900">Employee Management</h1>
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-4 text-white hover:bg-emerald-700"
          >
            <Plus className="h-5 w-5" />
            Add Employee
          </button>
        </div>

        {/* Search Bar */}
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2">
          <Search className="h-5 w-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search employees..."
            aria-label="Search employees"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPagination({ ...pagination, page: 1 });
            }}
            className="w-full bg-transparent outline-none"
          />
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex h-64 items-center justify-center rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-emerald-600"></div>
              <p className="text-slate-600">Loading employees...</p>
            </div>
          </div>
        )}

        {/* Table */}
        {!loading && employees.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Name</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Email</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Role</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Status</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => (
                  <tr key={employee.id} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <div>
                        <p className="font-medium text-slate-900">{employee.displayName}</p>
                        <p className="text-sm text-slate-500">ID: {employee.id.slice(0, 8)}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{employee.email || '—'}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                          ROLES[employee.roleKey]?.color || 'bg-slate-100 text-slate-800'
                        }`}
                      >
                        {ROLES[employee.roleKey]?.label || employee.roleKey}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                          employee.isActive
                            ? 'bg-green-100 text-green-800'
                            : 'bg-slate-100 text-slate-800'
                        }`}
                      >
                        {employee.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEditModal(employee)}
                          className="text-emerald-600 hover:text-emerald-700"
                          title="Edit"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => openResetPinModal(employee)}
                          className="text-blue-600 hover:text-blue-700"
                          title="Reset PIN"
                        >
                          <Lock className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleToggleStatus(employee)}
                          className={`${
                            employee.isActive
                              ? 'text-red-600 hover:text-red-700'
                              : 'text-green-600 hover:text-green-700'
                          }`}
                          title={employee.isActive ? 'Deactivate' : 'Activate'}
                        >
                          {employee.isActive ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty State */}
        {!loading && employees.length === 0 && (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-slate-200 bg-white">
            <p className="mb-4 text-slate-500">No employees found</p>
            <button
              onClick={openCreateModal}
              className="text-emerald-600 hover:text-emerald-700 font-medium"
            >
              Create your first employee
            </button>
          </div>
        )}

        {/* Pagination */}
        {!loading && employees.length > 0 && (
          <div className="mt-6 flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-sm text-slate-600">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  setPagination({
                    ...pagination,
                    page: Math.max(1, pagination.page - 1),
                  })
                }
                disabled={pagination.page === 1}
                className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-50"
              >
                Previous
              </button>
              <button
                onClick={() =>
                  setPagination({
                    ...pagination,
                    page: Math.min(pagination.totalPages, pagination.page + 1),
                  })
                }
                disabled={pagination.page === pagination.totalPages}
                className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {modalMode && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 p-4 z-50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">
              {modalMode === 'create' ? 'Add Employee' : 'Edit Employee'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">First Name *</label>
                <input
                  type="text"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Last Name *</label>
                <input
                  type="text"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Display Name *</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Role *</label>
                <select
                  value={formData.roleKey}
                  onChange={(e) => setFormData({ ...formData, roleKey: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="cashier">Cashier</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                  <option value="inventory_clerk">Inventory Clerk</option>
                  <option value="support">Support</option>
                </select>
              </div>

              {modalMode === 'create' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700">PIN (4-6 digits) *</label>
                  <input
                    type="password"
                    value={formData.pin}
                    onChange={(e) => setFormData({ ...formData, pin: e.target.value })}
                    placeholder="e.g., 1234"
                    className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700">PIN Hint</label>
                <input
                  type="text"
                  value={formData.pinHint}
                  onChange={(e) => setFormData({ ...formData, pinHint: e.target.value })}
                  placeholder="e.g., Birthday"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              {locations.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-700">Assigned Locations *</label>
                  <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-2 max-h-40 overflow-y-auto">
                    {locations.map((loc) => {
                      const checked = formData.locationIds.includes(loc.id);
                      return (
                        <label key={loc.id} className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 rounded cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setFormData((prev) => ({
                                ...prev,
                                locationIds: e.target.checked
                                  ? [...prev.locationIds, loc.id]
                                  : prev.locationIds.filter((id) => id !== loc.id),
                              }));
                            }}
                            className="rounded border-slate-300"
                          />
                          <span className="text-sm">{loc.name}{loc.code ? ` (${loc.code})` : ''}</span>
                        </label>
                      );
                    })}
                  </div>
                  {formData.locationIds.length === 0 && (
                    <p className="mt-1 text-xs text-rose-600">Select at least one location</p>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setModalMode(null);
                  resetForm();
                }}
                className="flex-1 rounded border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={modalMode === 'create' ? handleCreateEmployee : handleUpdateEmployee}
                disabled={submitting}
                className="flex-1 rounded bg-emerald-600 px-5 py-4 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {submitting ? 'Saving...' : modalMode === 'create' ? 'Create' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset PIN Modal */}
      {showPinModal && selectedEmployee && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 p-4 z-50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="mb-2 text-2xl font-bold text-slate-900">Reset PIN</h2>
            <p className="mb-4 text-sm text-slate-600">
              Employee: {selectedEmployee.displayName}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">New PIN (4-6 digits) *</label>
                <div className="relative mt-1">
                  <input
                    type={showPin ? 'text' : 'password'}
                    value={formData.pin}
                    onChange={(e) => setFormData({ ...formData, pin: e.target.value })}
                    placeholder="e.g., 1234"
                    className="w-full rounded border border-slate-300 px-3 py-2 pr-10 focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    onClick={() => setShowPin(!showPin)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
                  >
                    {showPin ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setShowPinModal(false);
                  setFormData({ ...formData, pin: '' });
                  setSelectedEmployee(null);
                }}
                className="flex-1 rounded border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPin}
                className="flex-1 rounded bg-emerald-600 px-5 py-4 text-white hover:bg-emerald-700"
              >
                Reset PIN
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
