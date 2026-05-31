"use server";

import { randomUUID } from "@/lib/uuid";
import { readStore, mutateStore } from "@/lib/persistence/store";
import { hasPermission } from "@/lib/domain/permissions";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { verifySecret } from "@/lib/auth/crypto";
import { requireRegisterPermission } from "@/lib/authz";
import { getRegisterConfig } from "@/lib/config/register-config";
import type { PermissionKey, RoleKey } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

export interface ApprovalRequest {
  /** The action that requires approval */
  actionType: "discount_threshold" | "item_void" | "transaction_void" | "store_credit" | "price_override" | "return" | "store_credit_threshold" | "cash_payout";
  /** Amount that triggered the threshold */
  triggerAmount: number;
  /** Threshold value that was exceeded */
  thresholdAmount: number;
  /** Cashier performing the action */
  cashierEmployeeId: string;
  /** Location context */
  locationId: string;
  /** Organization context */
  organizationId: string;
  /** Optional reason code */
  reasonCode?: string;
  /** Additional context */
  details?: string;
}

export interface ApprovalResult {
  approved: boolean;
  approverEmployeeId?: string;
  approverName?: string;
  exceptionId?: string;
  reason?: string;
}

/** Permission needed to approve each exception type */
const approvalPermissionMap: Record<string, PermissionKey> = {
  discount_threshold: "approval.discount",
  item_void: "approval.void_item",
  transaction_void: "approval.void_transaction",
  store_credit: "approval.store_credit",
  store_credit_threshold: "approval.store_credit",
  price_override: "approval.price_override",
  return: "approval.void_transaction", // returns use void_transaction permission
  cash_payout: "approval.cash_payout",
};

/**
 * Mapping from the UI actionType to the exception_code that checkout-action
 * looks for in register_session_exceptions. These codes MUST match what
 * checkout-action.ts checks (e.g. "discount_threshold", "price_override",
 * "store_credit_threshold").
 */
function exceptionCodeFor(actionType: ApprovalRequest["actionType"]): string {
  switch (actionType) {
    case "store_credit": return "store_credit_threshold";
    default: return actionType;
  }
}

/**
 * Which threshold field on `ApprovalThresholds` applies to a given action.
 * Returns null for actions that always need approval regardless of amount
 * (item voids, transaction voids, returns).
 */
function thresholdForAction(
  actionType: ApprovalRequest["actionType"],
  thresholds: { discountOver: number; storeCreditIssuanceOver: number; manualPriceOverrideOver: number; returnWithoutManagerOver: number; itemVoidOver: number; transactionVoidOver: number },
): number | null {
  switch (actionType) {
    case "discount_threshold": return thresholds.discountOver;
    case "store_credit":
    case "store_credit_threshold": return thresholds.storeCreditIssuanceOver;
    case "price_override": return thresholds.manualPriceOverrideOver;
    case "return": return thresholds.returnWithoutManagerOver;
    case "item_void": return thresholds.itemVoidOver;
    case "transaction_void": return thresholds.transactionVoidOver;
    // Pay-out uses the transactionVoidOver threshold today (same $50 default)
    // but maps to a distinct exception code so a transaction_void approval
    // can't be reused for a cash pay-out, and vice versa.
    case "cash_payout": return thresholds.transactionVoidOver;
    default: return null;
  }
}

/**
 * Verify a manager PIN and record the approval/denial.
 * Called from the client when a threshold is exceeded.
 */
export async function verifyManagerApproval(pin: string, request: ApprovalRequest): Promise<ApprovalResult> {
  const authCtx = await requireRegisterPermission("register.open");
  const organizationId = authCtx.employee.organizationId;
  const locationId = authCtx.location.id;
  const cashierEmployeeId = authCtx.employee.id;

  // R16-L-3: rate-limit per (location, cashier) so one cashier's mistypes
  // don't lock out every cashier at the location. Previously keyed on just
  // `approval:${locationId}` — 5 attempts/min shared across the whole
  // store meant one confused cashier could block all approvals for a
  // minute. Per-cashier scope preserves DoS defense without cross-impact.
  //
  // AUTH-AUDIT6-MED3: layer KV + DB + an org-aggregate cap on top of the
  // in-memory bucket, mirroring requireStepUp. The PIN verify below runs
  // pgFindCredentialByPin, which serially PBKDF2-verifies the submitted
  // PIN against EVERY active PIN credential in the org — so each attempt
  // is both a brute-force probe of MANAGER PINs (a compromised register
  // session self-approving discounts / voids / cash payouts) AND a CPU
  // amplifier proportional to org headcount. The in-memory bucket alone
  // is per-isolate; ~32 isolates/colo gave ~96/5min/cashier with no
  // cross-isolate coherence and no org-wide ceiling.
  const { logRateLimited } = await import("@/lib/logging/rate-limit-log");
  const rl = checkRateLimit(`approval:${locationId}:${cashierEmployeeId}`);
  if (!rl.allowed) {
    logRateLimited({ bucket: "approval", layer: "mem", actor: `${locationId.slice(0, 8)}|${cashierEmployeeId.slice(0, 8)}` });
    return { approved: false, reason: "Too many attempts. Please wait before trying again." };
  }
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvRl = await checkKvRateLimit(`approval:${organizationId}:${cashierEmployeeId}`, { maxAttempts: 4, windowMs: 300_000 });
    if (!kvRl.allowed) {
      logRateLimited({ bucket: "approval", layer: "kv", actor: cashierEmployeeId.slice(0, 8) });
      return { approved: false, reason: "Too many attempts. Please wait before trying again." };
    }
    // Org-aggregate cap: one compromised terminal must not be able to
    // spread guesses across many cashier identities to multiply the
    // per-cashier budget. Mirrors step-up's `stepup-aggregate`.
    const kvAgg = await checkKvRateLimit(`approval-agg:${organizationId}`, { maxAttempts: 20, windowMs: 300_000 });
    if (!kvAgg.allowed) {
      logRateLimited({ bucket: "approval-agg", layer: "kv", actor: organizationId.slice(0, 8) });
      return { approved: false, reason: "Too many approval attempts at this store. Please wait before trying again." };
    }
  } catch {
    // Fail-open on KV error — the mem layer above + DB layer below gate.
  }
  try {
    const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
    const dbRl = await checkDbRateLimit(`approval:${organizationId}:${cashierEmployeeId}`, { maxAttempts: 10, windowMs: 1_800_000 });
    if (!dbRl.allowed) {
      logRateLimited({ bucket: "approval", layer: "db", actor: cashierEmployeeId.slice(0, 8) });
      return { approved: false, reason: "Too many attempts. Please try again later." };
    }
  } catch {
    // Fail-open on DB error — the mem + KV layers above still gate.
  }

  // 1. Resolve the PIN to an employee.
  // PG path: targeted SELECT instead of the full-store RPC — the previous
  // `readStore(organizationId)` call parsed the entire org store (~all
  // products/variants/inventory/customers) just to look up a single
  // employee. Every manager-approval fire paid that CPU cost, which on
  // large orgs was enough to trip Cloudflare's error-1102 CPU limit
  // during back-to-back checkouts. The JSON dev path still uses readStore
  // because the credential hashes live in the in-memory store there.
  let approverEmployee: { id: string; displayName: string; roleKey: RoleKey; isActive: boolean } | null = null;

  if (isPg()) {
    const { pgFindCredentialByPin } = await import("@/lib/persistence/postgres-store");
    const cred = await pgFindCredentialByPin(pin, organizationId);
    if (cred) {
      const { orgQuery } = await import("@/lib/supabase-rest");
      const { rows } = await orgQuery(
        organizationId,
        `SELECT id, role_key, display_name, is_active
         FROM employees
         WHERE id = $1 AND organization_id = $2 AND is_active = true
         LIMIT 1`,
        [cred.employeeId, organizationId],
      );
      const r = rows[0] as Record<string, unknown> | undefined;
      if (r) {
        approverEmployee = {
          id: r.id as string,
          displayName: r.display_name as string,
          roleKey: r.role_key as RoleKey,
          isActive: r.is_active as boolean,
        };
      }
    }
  } else {
    // JSON fallback path — store.authCredentials has hashes in JSON mode
    const store = await readStore(organizationId);
    for (const cred of store.authCredentials) {
      if (cred.pinHash && await verifySecret(pin, cred.pinHash)) {
        const emp = store.employees.find((e) => e.id === cred.employeeId && e.isActive);
        if (emp) {
          approverEmployee = { id: emp.id, displayName: emp.displayName, roleKey: emp.roleKey, isActive: emp.isActive };
        }
        break;
      }
    }
  }

  if (!approverEmployee) {
    return { approved: false, reason: "Invalid manager PIN." };
  }

  // 2. Check the approver has the right permission.
  //
  // R14-M-4: do NOT echo the employee's display_name in the failure message.
  // That leaked the name when an attacker brute-forced PINs — a valid-but-
  // non-permitted PIN would return a name, a wrong PIN returned "Invalid
  // manager PIN". Attackers could scan PINs and build a {pin → name} map.
  // Generic permission message says nothing about WHICH employee the PIN
  // belonged to.
  const requiredPermission = approvalPermissionMap[request.actionType];
  if (!requiredPermission || !hasPermission(approverEmployee.roleKey, requiredPermission)) {
    return { approved: false, reason: "That PIN does not have approval permission for this action." };
  }

  // 3. Approver must not be the same as the cashier (unless they are an owner)
  if (approverEmployee.id === cashierEmployeeId && approverEmployee.roleKey !== "owner") {
    return { approved: false, reason: "A different manager must approve this action." };
  }

  // 3b. SERVER-SIDE threshold verification — never trust client-supplied
  // triggerAmount/thresholdAmount values. The cashier (or compromised client)
  // could claim triggerAmount: 10, thresholdAmount: 9 to get a manager PIN
  // approval for a trivial amount, then later reuse that approval for a
  // $10,000 discount. Look up the real threshold for this action type.
  const regConfig = await getRegisterConfig(organizationId);
  const realThreshold = thresholdForAction(request.actionType, regConfig.approvalThresholds);
  if (realThreshold === null) {
    // Not a threshold-bounded action (e.g. item_void, transaction_void, return) —
    // those always require approval regardless of amount, so no numeric check needed.
  } else if (request.triggerAmount < realThreshold - 0.005) {
    return { approved: false, reason: "This action does not exceed the approval threshold." };
  }

  // 4. Record the approval in register_session_exceptions so the NEXT checkout
  //    in this register session sees it as a pending approval. checkout-action
  //    queries this table with status='pending' and (expires_at IS NULL OR expires_at > now()).
  const exceptionId = randomUUID();
  const timestamp = new Date().toISOString();
  const exceptionCode = exceptionCodeFor(request.actionType);
  // Approvals are valid for 10 minutes — plenty of time to finish the checkout.
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const registerSessionId = authCtx.registerSession.id;

  if (isPg()) {
    const { orgTx } = await import("@/lib/supabase-rest");
    const client = await orgTx(organizationId);
    try {
      // R38-A-F2: persist the approved amount so the consumer can
      // verify the actual applied amount doesn't exceed it. Prior
      // shape only stored `exception_code`, letting a $55 approval
      // unlock a $5,000 discount at checkout. Action types that
      // aren't amount-scoped (item_void / transaction_void / return)
      // persist NULL and the consumer treats NULL as "unbounded"
      // (preserves legacy behavior for those flows).
      const amountScoped =
        request.actionType === "discount_threshold" ||
        request.actionType === "store_credit" ||
        request.actionType === "store_credit_threshold" ||
        request.actionType === "price_override" ||
        request.actionType === "cash_payout";
      const approvedAmount = amountScoped ? request.triggerAmount : null;
      await client.query(
        `INSERT INTO register_session_exceptions
           (id, register_session_id, exception_code, status, approved_by, approved_amount, expires_at, created_at)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
        [exceptionId, registerSessionId, exceptionCode, approverEmployee.id, approvedAmount, expiresAt, timestamp],
      );

      // R49: audit INSIDE the tx. manager_override is the primary
      // audit trail for every discount / void / price-override / cash-
      // payout approval. Post-commit audit via pgInsertAuditEvent was
      // lossy on Worker eviction — manager_override drops are the
      // worst audit drops because they're the evidence the exception
      // was authorized at all.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'register_session_exception', $5, 'manager_override', $6, now())`,
        [
          randomUUID(), organizationId, locationId, approverEmployee.id, exceptionId,
          JSON.stringify({
            action_type: request.actionType,
            exception_code: exceptionCode,
            register_session_id: registerSessionId,
            cashier_employee_id: cashierEmployeeId,
            approver_employee_id: approverEmployee.id,
            trigger_amount: request.triggerAmount.toFixed(2),
            threshold_amount: request.thresholdAmount.toFixed(2),
            reason_code: request.reasonCode ?? "none",
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((s) => {
      s.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "pending_" + exceptionId,
        eventKind: "manager_override",
        actorEmployeeId: approverEmployee!.id,
        notes: `Manager ${approverEmployee!.displayName} approved ${request.actionType} for cashier ${cashierEmployeeId}`,
        payload: {
          action_type: request.actionType,
          exception_code: exceptionCode,
          register_session_id: registerSessionId,
          cashier_employee_id: cashierEmployeeId,
          trigger_amount: request.triggerAmount.toFixed(2),
          threshold_amount: request.thresholdAmount.toFixed(2),
          reason_code: request.reasonCode ?? "none",
        },
        createdAt: timestamp,
      });
    });
  }

  return {
    approved: true,
    approverEmployeeId: approverEmployee.id,
    approverName: approverEmployee.displayName,
    exceptionId,
  };
}
