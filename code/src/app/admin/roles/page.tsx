'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authFetch } from '@/lib/api/client';

interface RoleSummary {
  key: string;
  label: string;
  description: string;
  permissions: string[];
  sensitivePermissions: string[];
  activeCount: number;
  inactiveCount: number;
}

interface ReviewEmployee {
  id: string;
  displayName: string;
  email?: string | null;
  roleKey: string;
  roleLabel: string;
  isActive: boolean;
  locations: Array<{ id: string; name: string }>;
  permissions: string[];
  sensitivePermissions: string[];
}

interface RoleReviewResponse {
  employees: ReviewEmployee[];
  roleDefinitions: RoleSummary[];
  sensitivePermissions: string[];
  summary: {
    totalEmployees: number;
    ownerCount: number;
    inactivePrivilegedCount: number;
    sensitiveEmployeeCount: number;
  };
}

export default function RolePermissionReviewPage() {
  const [data, setData] = useState<RoleReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [riskOnly, setRiskOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/roles/review', { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? 'Failed to load role review');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load role review');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const employees = useMemo(() => {
    const rows = data?.employees ?? [];
    return rows.filter((employee) => {
      if (roleFilter !== 'all' && employee.roleKey !== roleFilter) return false;
      if (riskOnly && employee.sensitivePermissions.length === 0 && employee.isActive) return false;
      return true;
    });
  }, [data?.employees, riskOnly, roleFilter]);

  const allPermissions = data?.roleDefinitions.reduce<string[]>((acc, role) => {
    for (const permission of role.permissions) {
      if (!acc.includes(permission)) acc.push(permission);
    }
    return acc;
  }, []) ?? [];

  const sensitiveSet = new Set(data?.sensitivePermissions ?? []);
  const summary = data?.summary ?? { totalEmployees: 0, ownerCount: 0, inactivePrivilegedCount: 0, sensitiveEmployeeCount: 0 };

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-7xl space-y-6 px-8 py-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-purple-700">Access controls</p>
            <h1 className="mt-2 text-4xl font-bold text-slate-900">Role & Permission Review</h1>
            <p className="mt-2 max-w-3xl text-slate-600">Audit employees, role assignments, sensitive permissions, inactive privileged users, and location coverage from one matrix.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={load} disabled={loading} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:bg-slate-300">Refresh</button>
            <Link href="/admin/employees" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Back to Employees</Link>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{error}</div>}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Metric label="Employees" value={summary.totalEmployees} />
          <Metric label="Active owners" value={summary.ownerCount} tone={summary.ownerCount > 1 ? 'warn' : 'neutral'} />
          <Metric label="Sensitive permission holders" value={summary.sensitiveEmployeeCount} tone="warn" />
          <Metric label="Inactive privileged users" value={summary.inactivePrivilegedCount} tone={summary.inactivePrivilegedCount > 0 ? 'alert' : 'neutral'} />
        </div>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-xl font-bold text-slate-900">Permission matrix</h2>
            <p className="text-sm text-slate-500">Sensitive permissions are highlighted to make owner/manager blast radius easy to review.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="sticky left-0 bg-slate-100 px-4 py-3">Role</th>
                  <th className="px-4 py-3 text-right">Active</th>
                  <th className="px-4 py-3 text-right">Inactive</th>
                  {allPermissions.map((permission) => (
                    <th key={permission} className="px-3 py-3 text-center">{permission}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={allPermissions.length + 3} className="px-4 py-8 text-center text-slate-500">Loading permission matrix…</td></tr>
                ) : data?.roleDefinitions.map((role) => (
                  <tr key={role.key} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="sticky left-0 bg-white px-4 py-3">
                      <div className="font-semibold text-slate-900">{role.label}</div>
                      <div className="max-w-xs text-xs text-slate-500">{role.description}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700">{role.activeCount}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700">{role.inactiveCount}</td>
                    {allPermissions.map((permission) => {
                      const hasPermission = role.permissions.includes(permission);
                      const sensitive = sensitiveSet.has(permission);
                      return (
                        <td key={permission} className="px-3 py-3 text-center">
                          <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${hasPermission ? sensitive ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-300'}`}>
                            {hasPermission ? '✓' : '–'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Employee access review</h2>
              <p className="text-sm text-slate-500">Filter down to sensitive permission holders or inactive privileged users before staff audits.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <option value="all">All roles</option>
                {data?.roleDefinitions.map((role) => <option key={role.key} value={role.key}>{role.label}</option>)}
              </select>
              <label className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
                <input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} />
                Sensitive permissions
              </label>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Locations</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sensitive permissions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Loading employee access…</td></tr>
                ) : employees.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No employees match this review filter.</td></tr>
                ) : employees.map((employee) => (
                  <tr key={employee.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{employee.displayName}</div>
                      <div className="text-xs text-slate-500">{employee.email || 'No email'}</div>
                    </td>
                    <td className="px-4 py-3"><span className="rounded-full bg-purple-100 px-2 py-1 text-xs font-semibold text-purple-800">{employee.roleLabel}</span></td>
                    <td className="px-4 py-3 text-slate-700">{employee.locations.length ? employee.locations.map((loc) => loc.name).join(', ') : 'No assigned locations'}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${employee.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{employee.isActive ? 'Active' : 'Inactive'}</span>
                      {!employee.isActive && employee.sensitivePermissions.length > 0 && <div className="mt-1 text-xs font-semibold text-red-700">Inactive privileged users</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {employee.sensitivePermissions.length === 0 ? <span className="text-xs text-slate-400">None</span> : employee.sensitivePermissions.map((permission) => (
                          <span key={permission} className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">{permission}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: number | string; tone?: 'neutral' | 'warn' | 'alert' }) {
  const colors = {
    neutral: 'bg-white text-slate-900 border-slate-200',
    warn: 'bg-amber-50 text-amber-900 border-amber-200',
    alert: 'bg-red-50 text-red-900 border-red-200',
  }[tone];
  return <div className={`rounded-xl border p-5 shadow-sm ${colors}`}><div className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</div><div className="mt-2 text-3xl font-bold">{value}</div></div>;
}
