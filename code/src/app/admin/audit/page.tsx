'use client';


import { useState, useEffect, useRef, Fragment, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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
  'help_action_decided': 'bg-cyan-100 text-cyan-800',
  'help_action_approval_requested': 'bg-amber-100 text-amber-800',
  'help_action_approval_reviewed': 'bg-emerald-100 text-emerald-800',
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

const helpActionLabel = (event: AuditEvent): string => {
  const isHelpEvent = event.event_kind === 'help_action_decided'
    || event.event_kind === 'help_action_approval_requested'
    || event.event_kind === 'help_action_approval_reviewed';
  if (!isHelpEvent) return event.notes || '—';
  const payload = event.payload ?? {};
  const actionId = typeof payload.actionId === 'string' ? payload.actionId : 'unknown-action';
  const verdict = typeof payload.verdict === 'string' ? payload.verdict : 'unknown';
  const band = typeof payload.band === 'string' ? payload.band : 'unknown';
  const executed = payload.executed === true ? 'executed' : 'not executed';
  if (event.event_kind === 'help_action_approval_reviewed') {
    const decision = typeof payload.decision === 'string' ? payload.decision : 'unknown';
    const status = typeof payload.status === 'string' ? payload.status : decision;
    return `Manager Review Outcome: ${status} · ${decision} · not executed`;
  }
  if (event.event_kind === 'help_action_approval_requested') {
    const status = typeof payload.status === 'string' ? payload.status : 'pending';
    return `Manager Approval Request: ${actionId} · ${status} · ${band} · ${verdict}`;
  }
  return `Help Action: ${actionId} · ${verdict} · ${band} · ${executed}`;
};

const helpActionEvidenceDetails = (payload: Record<string, unknown>) => {
  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== 'object') return null;
  const data = evidence as Record<string, unknown>;
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-white p-3 text-xs text-amber-950">
      <div className="mb-1 font-semibold">Shift evidence</div>
      <div>Source check: {String(data.sourceCheckId ?? 'unknown')}</div>
      <div>Shift: {String(data.shiftId ?? 'unknown')}</div>
      <div>Employee: {String(data.employeeId ?? 'unknown')}</div>
      <div>Location: {String(data.locationId ?? 'unknown')}</div>
      <div>Register session: {String(data.registerSessionId ?? 'none')}</div>
      <div>Reason: {String(data.reason ?? 'unknown')}</div>
      <div>Age hours: {String(data.ageHours ?? 'unknown')}</div>
    </div>
  );
};

const helpApprovalCorrelationDetails = (event: AuditEvent, payload: Record<string, unknown>) => {
  const rows = [
    { label: 'Approval request ID', value: String(payload.approvalRequestId ?? event.id) },
    ...(typeof payload.reqId === 'string' ? [{ label: 'Diagnostics request ID', value: payload.reqId }] : []),
    ...(typeof payload.receiptFingerprint === 'string' ? [{ label: 'Receipt fingerprint', value: payload.receiptFingerprint }] : []),
  ];
  return (
    <div className="mt-3 rounded-md border border-cyan-200 bg-white p-3 text-xs text-cyan-950">
      <div className="mb-1 font-semibold">Approval correlation</div>
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1 sm:grid-cols-[160px_1fr]">
          <span className="font-semibold">{row.label}</span>
          <span className="break-all font-mono">{row.value}</span>
        </div>
      ))}
    </div>
  );
};

const helpApprovalLifecycleDetails = (event: AuditEvent, payload: Record<string, unknown>) => {
  const status = typeof payload.status === 'string' ? payload.status : typeof payload.decision === 'string' ? payload.decision : 'pending';
  const reviewedLifecycleLabel = status === 'manual_review_required'
    ? 'Manual review required'
    : status === 'denied'
      ? 'Manager reviewed: denied'
      : 'Manager reviewed: acknowledged';
  const steps = event.event_kind === 'help_action_approval_reviewed'
    ? ['Detected', 'Evidence shown', reviewedLifecycleLabel]
    : ['Detected', 'Evidence shown', 'Manager review requested'];
  return (
    <div aria-label="Help lifecycle audit details" className="mt-3 rounded-md border border-indigo-200 bg-white p-3 text-xs text-indigo-950">
      <div className="mb-1 font-semibold">Help lifecycle</div>
      <ol className="grid gap-1">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-2 text-indigo-900">Reviewed/acknowledged does not mean repaired.</p>
    </div>
  );
};

const helpApprovalReviewNoteDetails = (event: AuditEvent, payload: Record<string, unknown>) => {
  if (event.event_kind === 'help_action_approval_requested') {
    return (
      <div aria-label="Help review note audit details" className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-800">
        <div className="font-semibold">Manager note</div>
        <div className="mt-1">No manager note recorded</div>
        <p className="mt-1 text-slate-600">A note appears after a manager reviews this request.</p>
      </div>
    );
  }
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  if (!note) {
    return (
      <div aria-label="Help review note audit details" className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-800">
        <div className="font-semibold">Manager note</div>
        <div className="mt-1">No manager note recorded</div>
        <p className="mt-1 text-slate-600">The manager decision was recorded without an added note.</p>
      </div>
    );
  }
  const isSystemManualReviewNote = note === 'Manager marked Help request for manual review.';
  return (
    <div aria-label="Help review note audit details" className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-800">
      <div className="font-semibold">{isSystemManualReviewNote ? 'System manual-review note' : 'Manager note'}</div>
      <div className="mt-1 break-words">{note}</div>
      <p className="mt-1 text-slate-600">
        {isSystemManualReviewNote
          ? 'System-generated because the manager selected Manual review required.'
          : 'Manager-entered note captured with the review outcome.'}
      </p>
    </div>
  );
};

const helpActionDetails = (
  event: AuditEvent,
  onApprovalReview?: (event: AuditEvent, decision: 'acknowledged' | 'denied' | 'manual_review_required') => void,
) => {
  // approvalRequest payloads are created by the Help fix route and rendered here for manager review.
  if (
    event.event_kind !== 'help_action_decided'
    && event.event_kind !== 'help_action_approval_requested'
    && event.event_kind !== 'help_action_approval_reviewed'
  ) return null;
  const payload = event.payload ?? {};
  const isApprovalRequest = event.event_kind === 'help_action_approval_requested';
  const isApprovalReview = event.event_kind === 'help_action_approval_reviewed';
  return (
    <div aria-label="Help action audit details" className="rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-sm text-cyan-950">
      <div className="font-semibold">
        {isApprovalReview ? 'Manager Review Outcome' : isApprovalRequest ? 'Manager Approval Request' : 'Help Action Decision'}
      </div>
      <div>Action: {String(payload.actionId ?? 'unknown')}</div>
      <div>Verdict: {String(payload.verdict ?? 'unknown')} · Band: {String(payload.band ?? 'unknown')}</div>
      {isApprovalRequest && <div>Status: {String(payload.status ?? 'pending')}</div>}
      {isApprovalReview && (
        <>
          <div>Decision: {String(payload.decision ?? payload.status ?? 'unknown')}</div>
          <div>Review status: {String(payload.status ?? payload.decision ?? 'unknown')}</div>
          <div>Original request: {String(payload.approvalRequestId ?? event.id)}</div>
          {typeof payload.reviewedBy === 'string' && <div>Reviewed by: {payload.reviewedBy}</div>}
          {typeof payload.reviewedAt === 'string' && <div>Reviewed at: {payload.reviewedAt}</div>}
        </>
      )}
      <div>Executed: {payload.executed === true ? 'yes' : 'no'}</div>
      {(isApprovalRequest || isApprovalReview) && helpApprovalLifecycleDetails(event, payload)}
      {(isApprovalRequest || isApprovalReview) && helpApprovalReviewNoteDetails(event, payload)}
      {(isApprovalRequest || isApprovalReview) && helpApprovalCorrelationDetails(event, payload)}
      {isApprovalRequest && typeof payload.requestedBy === 'string' && <div>Requested by: {payload.requestedBy}</div>}
      {typeof payload.receiptFingerprint === 'string' && (
        <div className="break-all font-mono text-xs">Receipt: {payload.receiptFingerprint}</div>
      )}
      {isApprovalRequest && helpActionEvidenceDetails(payload)}
      {isApprovalRequest && onApprovalReview && (
        <div className="mt-3 rounded-md border border-cyan-200 bg-white/80 p-3">
          <p className="mb-2 text-xs text-cyan-900">These buttons record the manager review outcome only; they never run the repair.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-label="Acknowledge Help manager review request" onClick={() => onApprovalReview(event, 'acknowledged')} className="rounded-md border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
              Acknowledge
              <span className="block text-[10px] font-medium text-emerald-600">Records that the manager saw the evidence. No repair runs.</span>
            </button>
            <button type="button" aria-label="Deny Help manager review request" onClick={() => onApprovalReview(event, 'denied')} className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700">
              Deny
              <span className="block text-[10px] font-medium text-red-600">Records that this request should not proceed. No data changes.</span>
            </button>
            <button type="button" aria-label="Mark Help request for manual review" onClick={() => onApprovalReview(event, 'manual_review_required')} className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-700">
              Manual review required
              <span className="block text-[10px] font-medium text-amber-600">Flags this for off-screen/manual follow-up. No repair runs.</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

function AuditPageInner() {
  const searchParams = useSearchParams();
  const initialEventKind = searchParams.get('event_kind') ?? '';
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
    eventKind: initialEventKind,
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
        const kinds = new Set<string>(['help_action_decided', 'help_action_approval_requested', 'help_action_approval_reviewed']);
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

  const reviewHelpApproval = async (event: AuditEvent, decision: 'acknowledged' | 'denied' | 'manual_review_required') => {
    const payload = event.payload ?? {};
    const receiptFingerprint = typeof payload.receiptFingerprint === 'string' ? payload.receiptFingerprint : '';
    try {
      const response = await authFetch('/api/admin/diagnostics/fix', {
        method: "PATCH",
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: typeof payload.approvalRequestId === 'string' ? payload.approvalRequestId : event.id,
          decision,
          receiptFingerprint,
          note: decision === 'manual_review_required' ? 'Manager marked Help request for manual review.' : undefined,
        }),
      });
      if (!response.ok) throw new Error(`Approval review failed (${response.status})`);
      await loadAuditEvents();
    } catch (err) {
      console.error('Failed to review Help approval request:', safeErr(err));
      setError(err instanceof Error ? err.message : 'Failed to review Help approval request');
    }
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
                          {helpActionLabel(event)}
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
                              {helpActionDetails(event, reviewHelpApproval)}
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

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-600">Loading audit trail…</div>}>
      <AuditPageInner />
    </Suspense>
  );
}
