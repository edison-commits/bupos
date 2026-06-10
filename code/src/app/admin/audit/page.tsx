'use client';


import { useState, useEffect, useRef, Fragment } from 'react';
// R42-F: RoleGate removed. The component read `bupos_employee_role` from
// localStorage, but no code path ever wrote that key, so every
// authenticated admin saw "Sign In Required" and the audit page was
// inaccessible. The server-side `/api/audit-events` route already
// enforces `audit.view` via withAdminAuth, and AdminLayout handles
// redirect for non-admins. Client-side role gating is redundant when
// the server gate is authoritative.
import { authFetch } from '@/lib/api/client';

import { safeErr } from "@/lib/logging/safe-err";
interface AuditEvent {
  id: string;
  transaction_id: string;
  actor_employee_id: string | null;
  actor_name: string;
  role_key: string | null;
  event_kind: string;
  notes: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

interface PaginationState {
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

const EVENT_KIND_COLORS: Record<string, string> = {
  'item_added': 'bg-blue-100 text-blue-800',
  'item_removed': 'bg-red-100 text-red-800',
  'discount_applied': 'bg-green-100 text-green-800',
  'payment_started': 'bg-purple-100 text-purple-800',
  'cart_voided': 'bg-red-200 text-red-900',
  'cart_held': 'bg-yellow-100 text-yellow-800',
  'cart_recalled': 'bg-emerald-100 text-emerald-800',
  'quantity_changed': 'bg-orange-100 text-orange-800',
  'pin_login': 'bg-slate-100 text-slate-800',
  'register_session_started': 'bg-teal-100 text-teal-800',
  'register_session_ended': 'bg-slate-200 text-slate-900',
  'transaction_placeholder': 'bg-indigo-100 text-indigo-800',
};

const getEventColor = (eventKind: string): string => {
  return EVENT_KIND_COLORS[eventKind] || 'bg-gray-100 text-gray-800';
};

const formatDate = (isoString: string): string => {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
};

const formatTime = (isoString: string): string => {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [employees, setEmployees] = useState<Array<{ id: string; display_name: string }>>([]);
  const [eventKinds, setEventKinds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pagination, setPagination] = useState<PaginationState>({
    pageSize: 50,
    nextCursor: null,
    hasMore: true,
  });

  const [filters, setFilters] = useState({
    fromDate: '',
    toDate: '',
    employeeId: '',
    eventKind: '',
  });

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // R36-FE13: AbortController per list fetch so rapid filter changes
  // can't race. A later-fired fetch could otherwise return BEFORE an
  // earlier one, and setEvents gets clobbered back to stale data.
  // Matches the pattern customer-database.tsx adopted in R34-D11.
  const listAbortRef = useRef<AbortController | null>(null);



  const loadEmployees = async () => {
    try {
      const response = await authFetch('/api/employees?pageSize=999');
      if (response.ok) {
        const data = await response.json();
        setEmployees(data.employees || []);
      }
    } catch (err) {
      console.error('Failed to load employees:', safeErr(err));
    }
  };

  const loadEventKinds = async () => {
    try {
      const response = await authFetch('/api/audit?page=1&pageSize=1');
      if (response.ok) {
        const data = await response.json();
        const kinds = new Set<string>();
        data.events.forEach((event: AuditEvent) => {
          kinds.add(event.event_kind);
        });
        setEventKinds(Array.from(kinds).sort());
      }
    } catch (err) {
      console.error('Failed to load event kinds:', safeErr(err));
    }
  };

  const loadAuditEvents = async () => {
    // R36-FE13: cancel any prior in-flight list fetch before starting a new one.
    listAbortRef.current?.abort();
    const ctrl = new AbortController();
    listAbortRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        pageSize: pagination.pageSize.toString(),
        ...(filters.fromDate && { from: filters.fromDate }),
        ...(filters.toDate && { to: filters.toDate }),
        ...(filters.employeeId && { employee_id: filters.employeeId }),
        ...(filters.eventKind && { event_kind: filters.eventKind }),
      });

      const response = await authFetch(`/api/audit?${params}`, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (!response.ok) {
        throw new Error('Failed to load audit events');
      }

      const data = await response.json();
      if (ctrl.signal.aborted) return;
      setEvents(data.events || []);
      setPagination({ pageSize: pagination.pageSize, nextCursor: data.nextCursor, hasMore: data.hasMore });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(
        err instanceof Error ? err.message : 'Failed to load audit events'
      );
    } finally {
      if (listAbortRef.current === ctrl) setLoading(false);
    }
  };

  const loadMoreAuditEvents = async () => {
    if (!pagination.nextCursor) return;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        pageSize: pagination.pageSize.toString(),
        cursor: pagination.nextCursor,
        ...(filters.fromDate && { from: filters.fromDate }),
        ...(filters.toDate && { to: filters.toDate }),
        ...(filters.employeeId && { employee_id: filters.employeeId }),
        ...(filters.eventKind && { event_kind: filters.eventKind }),
      });

      const response = await authFetch(`/api/audit?${params}`);
      if (!response.ok) {
        throw new Error('Failed to load more audit events');
      }

      const data = await response.json();
      setEvents((prev) => [...prev, ...(data.events || [])]);
      setPagination({ pageSize: pagination.pageSize, nextCursor: data.nextCursor, hasMore: data.hasMore });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load more audit events'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEmployees();
    loadEventKinds();
    loadAuditEvents();
    // R36-FE13: abort any pending list fetch on unmount.
    return () => { listAbortRef.current?.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    loadAuditEvents();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.fromDate,
    filters.toDate,
    filters.employeeId,
    filters.eventKind,
  ]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => ({ ...prev, nextCursor: null, hasMore: true }));
  };

  const clearFilters = () => {
    setFilters({
      fromDate: '',
      toDate: '',
      employeeId: '',
      eventKind: '',
    });
    // R36-FE14: pagination is cursor-based (see PaginationState) — the
    // old `page: 1` set a non-existent property and was dead code. Reset
    // the cursor instead so the filter-change effect re-fetches from
    // the start.
    setPagination((prev) => ({ ...prev, nextCursor: null, hasMore: true }));
  };

  const toggleRowExpansion = (eventId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  return (
    <>
      <div className="space-y-6 p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Trail</h1>
          <p className="text-slate-600 mt-1">
            Track all transaction-related events and activities
          </p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
            {Object.values(filters).some((f) => f) && (
              <button
                onClick={clearFilters}
                className="text-sm text-emerald-600 hover:text-emerald-700 font-medium"
              >
                Clear Filters
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                From Date
              </label>
              <input
                type="date"
                value={filters.fromDate}
                onChange={(e) =>
                  handleFilterChange('fromDate', e.target.value)
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                To Date
              </label>
              <input
                type="date"
                value={filters.toDate}
                onChange={(e) => handleFilterChange('toDate', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Employee
              </label>
              <select
                value={filters.employeeId}
                onChange={(e) =>
                  handleFilterChange('employeeId', e.target.value)
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
              >
                <option value="">All Employees</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Event Type
              </label>
              <select
                value={filters.eventKind}
                onChange={(e) =>
                  handleFilterChange('eventKind', e.target.value)
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
              >
                <option value="">All Events</option>
                {eventKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replace(/_/g, ' ').toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
            {error}
          </div>
        )}

        {/* Results */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                    Timestamp
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                    Employee
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                    Event Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                    Transaction
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                    Notes
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-700">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center">
                      <div className="inline-block">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
                      </div>
                    </td>
                  </tr>
                ) : events.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                      No audit events found
                    </td>
                  </tr>
                ) : (
                  events.map((event) => (
                    // R36-FE1: was `<tbody key={...}>` nested inside the
                    // outer <tbody> — invalid DOM. Browsers auto-close
                    // the outer tbody and hoist inner ones, which broke
                    // the `divide-y` class and triggered hydration
                    // warnings. `<Fragment>` renders both sibling rows
                    // without adding a wrapper element.
                    <Fragment key={event.id}>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-sm whitespace-nowrap">
                          <div className="font-medium text-slate-900">
                            {formatDate(event.created_at)}
                          </div>
                          <div className="text-xs text-slate-500">
                            {formatTime(event.created_at)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="font-medium text-slate-900">
                            {event.actor_name}
                          </div>
                          {event.role_key && (
                            <div className="text-xs text-slate-500">
                              {event.role_key}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span
                            className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${getEventColor(
                              event.event_kind
                            )}`}
                          >
                            {event.event_kind.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 font-mono">
                          {/* event.transaction_id is null for non-
                              transaction events (e.g. admin_logout,
                              employee_activated, password_change).
                              Render an em-dash instead of crashing
                              the whole page on `.slice(...)` of null. */}
                          {event.transaction_id ? `${event.transaction_id.slice(0, 8)}…` : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 max-w-xs truncate">
                          {event.notes || '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => toggleRowExpansion(event.id)}
                            className="text-emerald-600 hover:text-emerald-700 transition-colors"
                            title={
                              expandedRows.has(event.id)
                                ? 'Hide details'
                                : 'Show details'
                            }
                          >
                            {expandedRows.has(event.id) ? '▼' : '▶'}
                          </button>
                        </td>
                      </tr>
                      {expandedRows.has(event.id) && (
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <td colSpan={6} className="px-4 py-4">
                            <div className="space-y-3">
                              <div>
                                <h4 className="text-sm font-semibold text-slate-900 mb-2">
                                  Full Payload
                                </h4>
                                <pre className="bg-slate-900 text-slate-100 p-3 rounded text-xs overflow-x-auto max-h-64 overflow-y-auto">
                                  {JSON.stringify(event.payload, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Load More */}
          <div className="bg-slate-50 border-t border-slate-200 px-4 py-4 flex items-center justify-center">
            {pagination.hasMore ? (
              <button
                onClick={loadMoreAuditEvents}
                className="px-6 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-white transition-colors"
              >
                Load More
              </button>
            ) : (
              <p className="text-sm text-slate-500">No more events</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
