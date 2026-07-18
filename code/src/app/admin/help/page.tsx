"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/api/client";
import { safeErr } from "@/lib/logging/safe-err";

type DiagnosticStatus = "ok" | "warning" | "critical";

type DiagnosticCheck = {
  id: string;
  label: string;
  category: string;
  status: DiagnosticStatus;
  summary: string;
  recommendedAction?: string;
  details?: Record<string, unknown>;
};

type ShiftConflictCard = {
  shiftId: string;
  employeeId: string;
  locationId: string;
  registerSessionId: string | null;
  openedAt: string;
  ageHours: number;
  duplicateOpenShiftCount: number;
  reason: "duplicate_open_shift" | "stale_open_shift" | "open_shift_review";
};

type DiagnosticsResponse = {
  status: DiagnosticStatus;
  checkedAt: string;
  reqId: string;
  locationId?: string;
  roleKey: string;
  checks: DiagnosticCheck[];
};

type AuditEvent = {
  id: string;
  event_kind: string;
  actor_name?: string;
  created_at: string;
  payload?: Record<string, unknown>;
};

type AuditResponse = {
  events?: AuditEvent[];
};

const statusStyles: Record<DiagnosticStatus, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  critical: "border-red-200 bg-red-50 text-red-800",
};

const statusLabels: Record<DiagnosticStatus, string> = {
  ok: "OK",
  warning: "Needs review",
  critical: "Critical",
};

function statusRank(status: DiagnosticStatus): number {
  return status === "critical" ? 3 : status === "warning" ? 2 : 1;
}

function shiftConflictCards(check: DiagnosticCheck): ShiftConflictCard[] {
  const raw = check.details?.shiftConflictCards;
  return Array.isArray(raw) ? raw.filter((card): card is ShiftConflictCard => typeof card === "object" && card !== null && "shiftId" in card) : [];
}

function ShiftEvidenceCards({
  check,
  onCreateReviewRequest,
  busy,
}: {
  check: DiagnosticCheck;
  onCreateReviewRequest: (check: DiagnosticCheck, card: ShiftConflictCard) => void;
  busy: boolean;
}) {
  const cards = shiftConflictCards(check);
  if (cards.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-semibold text-amber-950">Shift evidence cards</div>
      <p className="mt-1 text-xs leading-5 text-amber-900">
        Read-only evidence only. Use this before requesting manager approval; no shift was closed or changed.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {cards.map((card) => (
          <div key={card.shiftId} className="rounded-lg border border-amber-200 bg-white p-3 text-xs text-slate-700">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-950">{card.reason === "duplicate_open_shift" ? "Duplicate open shift" : card.reason === "stale_open_shift" ? "Stale open shift" : "Open shift review"}</span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-amber-800">{card.reason}</span>
            </div>
            <div className="mt-2 grid gap-1">
              <div>Shift: <span className="font-mono">{card.shiftId}</span></div>
              <div>Employee: <span className="font-mono">{card.employeeId}</span></div>
              <div>Location: <span className="font-mono">{card.locationId}</span></div>
              <div>Register session: <span className="font-mono">{card.registerSessionId ?? "none"}</span></div>
              <div>Opened: {card.openedAt}</div>
              <div>Age: {card.ageHours}h · open shifts for employee/location: {card.duplicateOpenShiftCount}</div>
              <p className="mt-2 rounded-md border border-amber-100 bg-amber-50 px-2 py-1 text-[11px] leading-4 text-amber-900">
                Creates an audit request only. It will not close or edit this shift.
              </p>
              <button
                type="button"
                onClick={() => onCreateReviewRequest(check, card)}
                disabled={busy}
                className="mt-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Creating request…" : "Request manager review — no shift changes"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatAuditEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function helpTrailStatusBadge(rawStatus: unknown, fallback: "pending" | "reviewed"): { label: string; className: string } {
  const status = typeof rawStatus === "string" ? rawStatus : fallback;
  switch (status) {
    case "pending":
      return { label: "Pending review", className: "border-amber-200 bg-amber-100 text-amber-900" };
    case "acknowledged":
      return { label: "Acknowledged", className: "border-emerald-200 bg-emerald-100 text-emerald-900" };
    case "denied":
      return { label: "Denied", className: "border-red-200 bg-red-100 text-red-900" };
    case "manual_review_required":
      return { label: "Manual review required", className: "border-sky-200 bg-sky-100 text-sky-900" };
    case "reviewed":
      return { label: "Reviewed", className: "border-emerald-200 bg-emerald-100 text-emerald-900" };
    default:
      return { label: status, className: "border-slate-200 bg-slate-100 text-slate-800" };
  }
}

function helpTrailStatusRank(rawStatus: unknown): number {
  const status = typeof rawStatus === "string" ? rawStatus : "pending";
  if (status === "pending") return 0;
  if (status === "manual_review_required") return 1;
  if (status === "denied") return 2;
  if (status === "acknowledged" || status === "reviewed") return 3;
  return 4;
}

function helpTrailEventTime(event: AuditEvent): number {
  const timestamp = Date.parse(event.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortHelpTrailEvents(events: AuditEvent[], groupByStatus = false): AuditEvent[] {
  return [...events].sort((a, b) => {
    if (groupByStatus) {
      const statusDelta = helpTrailStatusRank(a.payload?.status) - helpTrailStatusRank(b.payload?.status);
      if (statusDelta !== 0) return statusDelta;
    }
    return helpTrailEventTime(b) - helpTrailEventTime(a);
  });
}

function helpTrailCorrelationDetails(payload: Record<string, unknown>, event: AuditEvent): Array<{ label: string; value: string }> {
  const originalRequestId = typeof payload.approvalRequestId === "string" ? payload.approvalRequestId : event.id;
  const diagnosticsRequestId = typeof payload.reqId === "string" ? payload.reqId : null;
  const receiptFingerprint = typeof payload.receiptFingerprint === "string" ? payload.receiptFingerprint : null;
  return [
    { label: "Original request ID", value: originalRequestId },
    ...(diagnosticsRequestId ? [{ label: "Diagnostics request", value: diagnosticsRequestId }] : []),
    ...(receiptFingerprint ? [{ label: "Receipt correlation", value: `${receiptFingerprint.slice(0, 12)}…` }] : []),
  ];
}

function helpTrailLifecycleBadge(payload: Record<string, unknown>, tone: "request" | "review"): { label: string; className: string; note: string } {
  if (tone === "request") {
    return {
      label: "Manager review requested",
      className: "border-amber-200 bg-amber-100 text-amber-900",
      note: "Evidence shown; waiting for manager review. No repair has executed.",
    };
  }
  const status = typeof payload.status === "string" ? payload.status : typeof payload.decision === "string" ? payload.decision : "reviewed";
  if (status === "manual_review_required") {
    return {
      label: "Manual review required",
      className: "border-sky-200 bg-sky-100 text-sky-900",
      note: "Reviewed does not mean repaired; this needs manual follow-up.",
    };
  }
  if (status === "denied") {
    return {
      label: "Manager reviewed: denied",
      className: "border-red-200 bg-red-100 text-red-900",
      note: "Reviewed does not mean repaired; the request was denied.",
    };
  }
  return {
    label: "Manager reviewed: acknowledged",
    className: "border-emerald-200 bg-emerald-100 text-emerald-900",
    note: "Reviewed does not mean repaired; acknowledgment only records the manager decision.",
  };
}

function helpTrailReviewNoteDetails(payload: Record<string, unknown>, tone: "request" | "review"): { label: string; value: string; helper: string } {
  if (tone === "request") {
    return {
      label: "Manager note",
      value: "No manager note recorded",
      helper: "A note appears after a manager reviews this request.",
    };
  }
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (!note) {
    return {
      label: "Manager note",
      value: "No manager note recorded",
      helper: "The manager decision was recorded without an added note.",
    };
  }
  const isSystemManualReviewNote = note === "Manager marked Help request for manual review.";
  return {
    label: isSystemManualReviewNote ? "System manual-review note" : "Manager note",
    value: note,
    helper: isSystemManualReviewNote
      ? "System-generated because the manager selected Manual review required."
      : "Manager-entered note captured with the review outcome.",
  };
}

function HelpTrailErrorCard({ message, href, linkLabel }: { message: string; href: string; linkLabel: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="font-semibold">{message}</div>
      <p className="mt-1 text-xs">Try Refresh review trail first. If this keeps failing, open the full Audit view below.</p>
      <a className="mt-2 inline-block text-xs font-semibold underline underline-offset-4" href={href}>
        {linkLabel}
      </a>
    </div>
  );
}

function HelpAuditEventCard({ event, tone }: { event: AuditEvent; tone: "request" | "review" }) {
  const isReview = tone === "review";
  const payload = event.payload ?? {};
  const receiptFingerprint = typeof payload.receiptFingerprint === "string" ? payload.receiptFingerprint : null;
  const statusBadge = helpTrailStatusBadge(payload.status, isReview ? "reviewed" : "pending");
  const lifecycleBadge = helpTrailLifecycleBadge(payload, tone);
  const noteDetails = helpTrailReviewNoteDetails(payload, tone);
  const correlationDetails = helpTrailCorrelationDetails(payload, event);
  return (
    <div aria-label={`Help ${isReview ? "review outcome" : "approval request"} ${event.id}`} className={`rounded-xl border px-4 py-3 ${isReview ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {isReview
            ? typeof payload.decision === "string" ? payload.decision : "Manager review outcome"
            : typeof payload.actionId === "string" ? payload.actionId : "Help approval request"}
        </span>
        <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${isReview ? "bg-emerald-100" : "bg-amber-100"}`}>{event.event_kind}</span>
      </div>
      <div className={`mt-2 grid gap-1 text-xs md:grid-cols-2 ${isReview ? "text-emerald-900" : "text-amber-900"}`}>
        <span>
          Status: <span aria-label={`Help status: ${statusBadge.label}`} className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${statusBadge.className}`}>{statusBadge.label}</span>
        </span>
        <span>
          {isReview ? "Reviewed" : "Requested"}: <time dateTime={event.created_at}>{formatAuditEventTime(event.created_at)}</time>
        </span>
        <span>{isReview ? "Reviewed by" : "Actor"}: {isReview && typeof payload.reviewedBy === "string" ? payload.reviewedBy : event.actor_name ?? "Unknown"}</span>
        <span>Compact receipt: {receiptFingerprint ? `${receiptFingerprint.slice(0, 12)}…` : "not available"}</span>
      </div>
      <div className={`mt-3 rounded-lg border bg-white/60 px-3 py-2 text-xs ${isReview ? "border-emerald-200 text-emerald-900" : "border-amber-200 text-amber-900"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">Lifecycle</span>
          <span aria-label={`Help lifecycle: ${lifecycleBadge.label}`} className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${lifecycleBadge.className}`}>{lifecycleBadge.label}</span>
        </div>
        <p className="mt-1">{lifecycleBadge.note}</p>
      </div>
      <div aria-label={`Help review note: ${noteDetails.label}`} className={`mt-3 rounded-lg border bg-white/60 px-3 py-2 text-xs ${isReview ? "border-emerald-200 text-emerald-900" : "border-amber-200 text-amber-900"}`}>
        <div className="font-semibold">{noteDetails.label}</div>
        <div className="mt-1 break-words">{noteDetails.value}</div>
        <p className="mt-1 opacity-80">{noteDetails.helper}</p>
      </div>
      <div className={`mt-3 grid gap-1 rounded-lg border bg-white/60 px-3 py-2 text-xs ${isReview ? "border-emerald-200 text-emerald-900" : "border-amber-200 text-amber-900"}`}>
        {correlationDetails.map((item) => (
          <div key={item.label} className="flex flex-wrap justify-between gap-2">
            <span className="font-semibold">{item.label}</span>
            <span className="font-mono break-all">{item.value}</span>
          </div>
        ))}
      </div>
      {receiptFingerprint && (
        <details aria-label="Help receipt full fingerprint" className={`mt-3 rounded-lg border bg-white/70 px-3 py-2 text-xs ${isReview ? "border-emerald-200" : "border-amber-200"}`}>
          <summary className="cursor-pointer font-semibold">Full receipt fingerprint</summary>
          <div className="mt-2 break-all font-mono">{receiptFingerprint}</div>
        </details>
      )}
    </div>
  );
}

export default function AdminHelpPage() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [packetLoading, setPacketLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionAuditHref, setActionAuditHref] = useState("/admin/audit?event_kind=help_action_decided");
  const [actionAuditLabel, setActionAuditLabel] = useState("View in audit trail");
  const [approvalRequests, setApprovalRequests] = useState<AuditEvent[]>([]);
  const [approvalRequestsLoading, setApprovalRequestsLoading] = useState(true);
  const [approvalRequestsError, setApprovalRequestsError] = useState<string | null>(null);
  const [reviewOutcomes, setReviewOutcomes] = useState<AuditEvent[]>([]);
  const [reviewOutcomesLoading, setReviewOutcomesLoading] = useState(true);
  const [reviewOutcomesError, setReviewOutcomesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/admin/diagnostics");
      if (!res.ok) throw new Error(`Diagnostics failed (${res.status})`);
      setData(await res.json());
    } catch (err) {
      console.error("Failed to run diagnostics", safeErr(err));
      setError("Could not run diagnostics. Try again, then contact technical support if it keeps failing.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApprovalRequests = useCallback(async () => {
    setApprovalRequestsLoading(true);
    setApprovalRequestsError(null);
    try {
      const res = await authFetch("/api/audit?event_kind=help_action_approval_requested&pageSize=5");
      if (!res.ok) throw new Error(`Approval request lookup failed (${res.status})`);
      const body = (await res.json()) as AuditResponse;
      setApprovalRequests((body.events ?? []).filter((event) => event.event_kind === "help_action_approval_requested"));
    } catch (err) {
      console.error("Failed to load Help approval requests", safeErr(err));
      setApprovalRequests([]);
      setApprovalRequestsError("Could not load manager requests. Use Audit if this keeps failing.");
    } finally {
      setApprovalRequestsLoading(false);
    }
  }, []);

  const loadReviewOutcomes = useCallback(async () => {
    setReviewOutcomesLoading(true);
    setReviewOutcomesError(null);
    try {
      const res = await authFetch("/api/audit?event_kind=help_action_approval_reviewed&pageSize=5");
      if (!res.ok) throw new Error(`Review outcome lookup failed (${res.status})`);
      const body = (await res.json()) as AuditResponse;
      setReviewOutcomes((body.events ?? []).filter((event) => event.event_kind === "help_action_approval_reviewed"));
    } catch (err) {
      console.error("Failed to load Help review outcomes", safeErr(err));
      setReviewOutcomes([]);
      setReviewOutcomesError("Could not load review outcomes. Use Audit if this keeps failing.");
    } finally {
      setReviewOutcomesLoading(false);
    }
  }, []);

  const refreshReviewTrail = useCallback(async () => {
    setError(null);
    await Promise.all([loadApprovalRequests(), loadReviewOutcomes()]);
  }, [loadApprovalRequests, loadReviewOutcomes]);

  useEffect(() => {
    runChecks();
    loadApprovalRequests();
    loadReviewOutcomes();
  }, [loadApprovalRequests, loadReviewOutcomes, runChecks]);

  const sortedChecks = useMemo(
    () => [...(data?.checks ?? [])].sort((a, b) => statusRank(b.status) - statusRank(a.status)),
    [data],
  );

  const sortedApprovalRequests = useMemo(() => sortHelpTrailEvents(approvalRequests, true), [approvalRequests]);
  const sortedReviewOutcomes = useMemo(() => sortHelpTrailEvents(reviewOutcomes), [reviewOutcomes]);

  const generatePacket = async () => {
    setPacketLoading(true);
    setActionMessage(null);
    setError(null);
    try {
      const res = await authFetch("/api/admin/diagnostics?format=packet");
      if (!res.ok) throw new Error(`Support packet failed (${res.status})`);
      const packet = await res.json();
      const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bupos-support-packet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to generate support packet", safeErr(err));
      setError("Could not generate the support packet. The checks are still read-only; try again before escalating.");
    } finally {
      setPacketLoading(false);
    }
  };

  const runSafeRefreshAction = async () => {
    setActionLoading(true);
    setActionMessage(null);
    setActionAuditHref("/admin/audit?event_kind=help_action_decided");
    setActionAuditLabel("View in audit trail");
    setError(null);
    try {
      const res = await authFetch("/api/admin/diagnostics/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "refresh-diagnostics-cache" }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.decision?.reason ?? `Help action failed (${res.status})`);
      setActionMessage(`${result.receipt.decision.reason} Receipt ${result.receipt.fingerprint.slice(0, 12)}…`);
      await runChecks();
    } catch (err) {
      console.error("Failed to run safe help action", safeErr(err));
      setError(err instanceof Error ? err.message : "Could not run the safe help action.");
    } finally {
      setActionLoading(false);
    }
  };

  const createShiftManagerReviewRequest = async (check: DiagnosticCheck, card: ShiftConflictCard) => {
    setActionLoading(true);
    setActionMessage(null);
    setActionAuditHref("/admin/audit?event_kind=help_action_approval_requested");
    setActionAuditLabel("Open manager requests in Audit");
    setError(null);
    try {
      const res = await authFetch("/api/admin/diagnostics/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "review-open-shift-conflicts",
          evidence: {
            sourceCheckId: check.id,
            shiftId: card.shiftId,
            employeeId: card.employeeId,
            locationId: card.locationId,
            registerSessionId: card.registerSessionId,
            reason: card.reason,
            ageHours: card.ageHours,
          },
        }),
      });
      const result = await res.json();
      if (res.status !== 409 || result?.decision?.verdict !== "require_approval") {
        throw new Error(result?.decision?.reason ?? `Manager review request failed (${res.status})`);
      }
      setActionMessage(`Manager review request created. Open Audit to review it. Receipt ${result.receipt.fingerprint.slice(0, 12)}… No shift was changed.`);
      await Promise.all([runChecks(), refreshReviewTrail()]);
    } catch (err) {
      console.error("Failed to create shift manager review request", safeErr(err));
      setError(err instanceof Error ? err.message : "Could not create manager review request.");
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pt-6">
      <div className="mx-auto max-w-6xl space-y-6 px-6 pb-12 lg:px-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700">BUPOS Help</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Something wrong?</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Run read-only store health checks before trying fixes. BUPOS will check database reachability,
                register shift conflicts, inventory risk, and recent transaction exceptions without changing store data.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={runChecks}
                disabled={loading}
                className="rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Running checks…" : "Run checks"}
              </button>
              <button
                type="button"
                onClick={generatePacket}
                disabled={packetLoading || !data}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {packetLoading ? "Preparing packet…" : "Generate support packet"}
              </button>
              <button
                type="button"
                onClick={runSafeRefreshAction}
                disabled={actionLoading}
                className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm font-semibold text-teal-800 shadow-sm transition hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {actionLoading ? "Running safe action…" : "Safe refresh"}
              </button>
            </div>
          </div>
          {data && (
            <div className="mt-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className={`rounded-full border px-3 py-1 font-semibold ${statusStyles[data.status]}`}>{statusLabels[data.status]}</span>
              <span>Last checked {new Date(data.checkedAt).toLocaleString()}</span>
              {data.locationId && <span>Location context: {data.locationId}</span>}
              <span>Request ID: {data.reqId}</span>
            </div>
          )}
          {actionMessage && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <div>{actionMessage}</div>
              <a className="mt-2 inline-block font-semibold underline underline-offset-4" href={actionAuditHref}>
                {actionAuditLabel}
              </a>
            </div>
          )}
          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
        </section>

        <section className="rounded-2xl border border-teal-200 bg-white p-5 text-sm leading-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Store recovery cheat sheet</p>
              <h2 className="mt-1 text-base font-semibold text-slate-950">Keep this near the register or manager workstation</h2>
              <p className="mt-2 text-slate-600">
                BUPOS Help diagnoses first. It shows read-only checks, shift evidence, manager review requests, and Audit links before anyone guesses at a fix.
              </p>
              <p className="mt-2 font-medium text-slate-800">
                It will not close shifts, change inventory, retry payments, send customer messages, run migrations, or change credentials.
              </p>
            </div>
            <a
              href="/docs/bupos-help-cheat-sheet.md"
              className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm font-semibold text-teal-800 shadow-sm transition hover:bg-teal-100"
            >
              Read full cheat sheet
            </a>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 text-sm shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">Manager review trail</h2>
              <p className="mt-1 text-sm text-slate-600">Open requests and reviewed outcomes from Help audit events. Repairs still do not run from this trail; use Audit for controls and the full event history.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50" href="/admin/audit?event_kind=help_action_approval_requested">
                View all manager requests in Audit
              </a>
              <a className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50" href="/admin/audit?event_kind=help_action_approval_reviewed">
                View all review outcomes in Audit
              </a>
              <button
                type="button"
                onClick={refreshReviewTrail}
                disabled={approvalRequestsLoading || reviewOutcomesLoading}
                className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {approvalRequestsLoading || reviewOutcomesLoading ? "Refreshing trail…" : "Refresh review trail"}
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Open requests</h3>
              <p className="mt-1 text-xs text-slate-500">Pending manager review requests: Open requests are waiting for a manager decision; no fix has run yet.</p>
              <div className="mt-3 grid gap-3">
                {approvalRequestsLoading ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">Loading manager requests…</div>
                ) : approvalRequestsError ? (
                  <HelpTrailErrorCard
                    message={approvalRequestsError}
                    href="/admin/audit?event_kind=help_action_approval_requested"
                    linkLabel="Open manager requests in Audit"
                  />
                ) : sortedApprovalRequests.length > 0 ? (
                  sortedApprovalRequests.map((request) => <HelpAuditEventCard key={request.id} event={request} tone="request" />)
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">
                    <div className="font-semibold text-slate-800">No requests are waiting for manager review.</div>
                    <p className="mt-1 text-xs">When a Help action needs approval, it will appear here.</p>
                  </div>
                )}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Reviewed outcomes</h3>
              <p className="mt-1 text-xs text-slate-500">Recent manager review outcomes: Review outcomes record manager decisions only; they do not close shifts or perform repairs.</p>
              <div className="mt-3 grid gap-3">
                {reviewOutcomesLoading ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">Loading review outcomes…</div>
                ) : reviewOutcomesError ? (
                  <HelpTrailErrorCard
                    message={reviewOutcomesError}
                    href="/admin/audit?event_kind=help_action_approval_reviewed"
                    linkLabel="Open review outcomes in Audit"
                  />
                ) : sortedReviewOutcomes.length > 0 ? (
                  sortedReviewOutcomes.map((outcome) => <HelpAuditEventCard key={outcome.id} event={outcome} tone="review" />)
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">
                    <div className="font-semibold text-slate-800">No reviewed Help outcomes yet.</div>
                    <p className="mt-1 text-xs">Reviewed requests will show here after a manager acknowledges, denies, or marks them for manual review.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4">
          {loading && !data ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">Checking store health…</div>
          ) : sortedChecks.length > 0 ? (
            sortedChecks.map((check) => (
              <article key={check.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyles[check.status]}`}>{statusLabels[check.status]}</span>
                      <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">{check.category}</span>
                    </div>
                    <h2 className="mt-3 text-lg font-semibold text-slate-950">{check.label}</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{check.summary}</p>
                  </div>
                </div>
                {check.recommendedAction && (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <strong>Recommended next step:</strong> {check.recommendedAction}
                  </div>
                )}
                <ShiftEvidenceCards check={check} onCreateReviewRequest={createShiftManagerReviewRequest} busy={actionLoading} />
                {check.details && (
                  <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    <summary className="cursor-pointer font-medium text-slate-800">Technical details</summary>
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(check.details, null, 2)}</pre>
                  </details>
                )}
              </article>
            ))
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">No checks returned.</div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 text-sm leading-6 text-slate-600 shadow-sm">
          <h2 className="text-base font-semibold text-slate-950">What this button does not do yet</h2>
          <p className="mt-2">
            It does not close shifts, change inventory, retry payments, update Shopify, send email, run migrations,
            or modify customer data. Fix actions should be added only after each diagnostic is trusted and gated by
            manager confirmation/audit where needed.
          </p>
        </section>
      </div>
    </div>
  );
}
