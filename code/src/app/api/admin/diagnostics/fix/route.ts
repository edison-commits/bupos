import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { safeErr } from "@/lib/logging/safe-err";
import { createActionReceipt, evaluateHelpAction, type HelpActionReceipt } from "@/lib/safety/action-kernel";
import { orgTx } from "@/lib/supabase-rest";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, private, max-age=0" };

type HelpActionEvidence = {
  sourceCheckId?: string;
  shiftId?: string;
  employeeId?: string;
  locationId?: string;
  registerSessionId?: string | null;
  reason?: string;
  ageHours?: number;
};

type HelpActionApprovalRequest = {
  id: string;
  status: "pending";
  actionId: string;
  orgId: string;
  locationId?: string;
  requestedBy: string;
  requestedAt: string;
  receiptId: string;
  receiptFingerprint: string;
  evidence?: HelpActionEvidence;
};

type HelpApprovalReviewDecision = "acknowledged" | "denied" | "manual_review_required";

type HelpActionApprovalReview = {
  approvalRequestId: string;
  decision: HelpApprovalReviewDecision;
  status: HelpApprovalReviewDecision;
  orgId: string;
  locationId?: string;
  reviewedBy: string;
  roleKey: string;
  reviewedAt: string;
  receiptFingerprint: string;
  note?: string;
};

const HELP_APPROVAL_REVIEW_DECISIONS = [
  "acknowledged",
  "denied",
  "manual_review_required",
] as const satisfies readonly HelpApprovalReviewDecision[];

function isHelpApprovalReviewDecision(value: unknown): value is HelpApprovalReviewDecision {
  return typeof value === "string" && HELP_APPROVAL_REVIEW_DECISIONS.includes(value as HelpApprovalReviewDecision);
}

function helpActionKillSwitch() {
  return {
    killed: process.env.BUPOS_HELP_ACTIONS_KILLED === "1" || process.env.BUPOS_HELP_ACTIONS_KILLED === "true",
    killedBy: process.env.BUPOS_HELP_ACTIONS_KILLED_BY,
    killReason: process.env.BUPOS_HELP_ACTIONS_KILL_REASON,
  };
}

function responseStatus(verdict: "allow" | "require_approval" | "deny") {
  if (verdict === "allow") return 200;
  if (verdict === "require_approval") return 409;
  return 403;
}

function safeEvidence(input: unknown): HelpActionEvidence | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const evidence: HelpActionEvidence = {};
  for (const key of ["sourceCheckId", "shiftId", "employeeId", "locationId", "reason"] as const) {
    if (typeof raw[key] === "string") evidence[key] = raw[key].replace(/[\r\n\t]+/g, " ").slice(0, 96);
  }
  evidence.registerSessionId = typeof raw.registerSessionId === "string" ? raw.registerSessionId.slice(0, 96) : null;
  if (Number.isFinite(Number(raw.ageHours))) evidence.ageHours = Number(raw.ageHours);
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function buildApprovalRequest(receipt: HelpActionReceipt, evidence?: HelpActionEvidence): HelpActionApprovalRequest | null {
  if (receipt.decision.verdict !== "require_approval") return null;
  return {
    id: `approval:${receipt.id}`,
    status: "pending",
    actionId: receipt.request.actionId,
    orgId: receipt.request.orgId,
    locationId: receipt.request.locationId,
    requestedBy: receipt.request.actorId,
    requestedAt: receipt.createdAt,
    receiptId: receipt.id,
    receiptFingerprint: receipt.fingerprint,
    evidence,
  };
}

async function persistHelpActionReceipt(receipt: HelpActionReceipt, approvalRequest: HelpActionApprovalRequest | null): Promise<boolean> {
  let client: Awaited<ReturnType<typeof orgTx>> | null = null;
  try {
    client = await orgTx(receipt.request.orgId);
    await client.query(
      `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        receipt.request.orgId,
        receipt.request.locationId ?? null,
        receipt.request.actorId,
        "help_action",
        null,
        "help_action_decided",
        JSON.stringify({
          actionId: receipt.request.actionId,
          reqId: receipt.request.reqId,
          roleKey: receipt.request.roleKey,
          verdict: receipt.decision.verdict,
          band: receipt.decision.band,
          reason: receipt.decision.reason,
          executed: receipt.outcome.executed === true,
          receiptId: receipt.id,
          receiptFingerprint: receipt.fingerprint,
        }),
      ],
    );
    if (approvalRequest) {
      await client.query(
        `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          approvalRequest.orgId,
          approvalRequest.locationId ?? null,
          approvalRequest.requestedBy,
          "help_action_approval_request",
          approvalRequest.id,
          "help_action_approval_requested",
          JSON.stringify({
            status: approvalRequest.status,
            approvalRequestId: approvalRequest.id,
            actionId: approvalRequest.actionId,
            reqId: receipt.request.reqId,
            roleKey: receipt.request.roleKey,
            verdict: receipt.decision.verdict,
            band: receipt.decision.band,
            reason: receipt.decision.reason,
            requestedBy: approvalRequest.requestedBy,
            requestedAt: approvalRequest.requestedAt,
            receiptId: approvalRequest.receiptId,
            receiptFingerprint: approvalRequest.receiptFingerprint,
            evidence: approvalRequest.evidence,
            executed: false,
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(JSON.stringify({
      event: "audit_insert_failed",
      surface: "admin_diagnostics_fix",
      orgId: receipt.request.orgId,
      eventKind: "help_action_decided",
      actionId: receipt.request.actionId,
      receiptFingerprint: receipt.fingerprint,
      error: safeErr(err),
    }));
    return false;
  } finally {
    client?.release();
  }
}

async function persistApprovalReview(review: HelpActionApprovalReview): Promise<boolean> {
  let client: Awaited<ReturnType<typeof orgTx>> | null = null;
  try {
    client = await orgTx(review.orgId);
    await client.query(
      `INSERT INTO audit_events (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        review.orgId,
        review.locationId ?? null,
        review.reviewedBy,
        "help_action_approval_request",
        review.approvalRequestId,
        "help_action_approval_reviewed",
        JSON.stringify({
          status: review.status,
          approvalRequestId: review.approvalRequestId,
          decision: review.decision,
          reviewedBy: review.reviewedBy,
          roleKey: review.roleKey,
          reviewedAt: review.reviewedAt,
          receiptFingerprint: review.receiptFingerprint,
          note: review.note,
          executed: false,
        }),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(JSON.stringify({
      event: "audit_insert_failed",
      surface: "admin_diagnostics_fix_review",
      orgId: review.orgId,
      eventKind: "help_action_approval_reviewed",
      approvalRequestId: review.approvalRequestId,
      receiptFingerprint: review.receiptFingerprint,
      error: safeErr(err),
    }));
    return false;
  } finally {
    client?.release();
  }
}

export const POST = withAdminAuth("audit.view", async (req, ctx) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const actionId = typeof (body as { actionId?: unknown }).actionId === "string"
    ? (body as { actionId: string }).actionId.trim()
    : "";
  if (!actionId) {
    return NextResponse.json({ error: "Invalid actionId" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const actionRequest = {
    actionId,
    actorId: ctx.employee.id,
    roleKey: ctx.employee.roleKey,
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    reqId: ctx.reqId,
  };
  const decision = evaluateHelpAction(actionRequest, helpActionKillSwitch());
  const executed = decision.allowedToExecute;
  const outcome = executed
    ? {
        executed: true,
        message: actionId === "refresh-diagnostics-cache"
          ? "Diagnostics state refreshed. No store data was changed."
          : "Read-only action completed. No store data was changed.",
      }
    : {
        executed: false,
        message: decision.verdict === "require_approval"
          ? "Action requires manager approval before any repair workflow can run."
          : "Action denied by BUPOS Help Action Kernel.",
      };
  const receipt = createActionReceipt(actionRequest, decision, outcome);
  const approvalRequest = buildApprovalRequest(receipt, safeEvidence((body as { evidence?: unknown }).evidence));
  const auditPersisted = await persistHelpActionReceipt(receipt, approvalRequest);

  return NextResponse.json(
    {
      executed,
      decision,
      receipt,
      approvalRequest,
      auditPersisted,
    },
    { status: responseStatus(decision.verdict), headers: NO_STORE_HEADERS },
  );
});

export const PATCH = withAdminAuth("audit.view", async (req, ctx) => {
  if (!["owner", "manager"].includes(ctx.employee.roleKey)) {
    return NextResponse.json({ error: "Manager approval review required" }, { status: 403, headers: NO_STORE_HEADERS });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const approvalRequestId = typeof (body as { approvalRequestId?: unknown }).approvalRequestId === "string"
    ? (body as { approvalRequestId: string }).approvalRequestId.trim()
    : "";
  const decisionRaw = typeof (body as { decision?: unknown }).decision === "string"
    ? (body as { decision: string }).decision.trim()
    : "";
  const receiptFingerprint = typeof (body as { receiptFingerprint?: unknown }).receiptFingerprint === "string"
    ? (body as { receiptFingerprint: string }).receiptFingerprint.trim()
    : "";
  const note = typeof (body as { note?: unknown }).note === "string"
    ? (body as { note: string }).note.replace(/[\r\n\t]+/g, " ").slice(0, 280)
    : undefined;

  if (!approvalRequestId.startsWith("approval:")) {
    return NextResponse.json({ error: "Invalid approvalRequestId" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!isHelpApprovalReviewDecision(decisionRaw)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!/^[a-f0-9]{64}$/i.test(receiptFingerprint)) {
    return NextResponse.json({ error: "Invalid receiptFingerprint" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const approvalReview: HelpActionApprovalReview = {
    approvalRequestId,
    decision: decisionRaw as HelpApprovalReviewDecision,
    status: decisionRaw as HelpApprovalReviewDecision,
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    reviewedBy: ctx.employee.id,
    roleKey: ctx.employee.roleKey,
    reviewedAt: new Date().toISOString(),
    receiptFingerprint,
    note,
  };
  const auditPersisted = await persistApprovalReview(approvalReview);

  return NextResponse.json({
    reviewed: true,
    executed: false,
    approvalReview,
    auditPersisted,
  }, { status: 200, headers: NO_STORE_HEADERS });
});
