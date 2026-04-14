"use server";

import { randomUUID } from "@/lib/uuid";
import { readStore, mutateStore } from "@/lib/persistence/store";
import { hasPermission } from "@/lib/domain/permissions";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { verifySecret } from "@/lib/auth/crypto";
import { requireRegisterPermission } from "@/lib/authz";
import type { PermissionKey } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

export interface ApprovalRequest {
  /** The action that requires approval */
  actionType: "discount_threshold" | "item_void" | "transaction_void" | "store_credit" | "price_override" | "return";
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
  price_override: "approval.price_override",
  return: "approval.void_transaction", // returns use void_transaction permission
};

/**
 * Verify a manager PIN and record the approval/denial.
 * Called from the client when a threshold is exceeded.
 */
export async function verifyManagerApproval(pin: string, request: ApprovalRequest): Promise<ApprovalResult> {
  const authCtx = await requireRegisterPermission("register.open");
  const organizationId = authCtx.employee.organizationId;
  const locationId = authCtx.location.id;
  const cashierEmployeeId = authCtx.employee.id;

  // Rate-limit manager approval PINs (5 attempts/min per location)
  const rl = checkRateLimit(`approval:${locationId}`);
  if (!rl.allowed) {
    return { approved: false, reason: "Too many attempts. Please wait before trying again." };
  }

  // 1. Resolve the PIN to an employee
  const store = await readStore(organizationId);

  // Find employee by PIN — resolve via the hashed PIN credentials in the authCredentials table.
  // No hardcoded dev PINs; every approver must use their real stored credential.
  let approverEmployee = null;

  for (const cred of store.authCredentials) {
    if (cred.pinHash && await verifySecret(pin, cred.pinHash)) {
      approverEmployee = store.employees.find(
        (e) => e.id === cred.employeeId && e.isActive,
      );
      break;
    }
  }

  if (!approverEmployee) {
    return { approved: false, reason: "Invalid manager PIN." };
  }

  // 2. Check the approver has the right permission
  const requiredPermission = approvalPermissionMap[request.actionType];
  if (!requiredPermission || !hasPermission(approverEmployee.roleKey, requiredPermission)) {
    return { approved: false, reason: `${approverEmployee.displayName} does not have ${request.actionType} approval permission.` };
  }

  // 3. Approver must not be the same as the cashier (unless they are an owner)
  if (approverEmployee.id === cashierEmployeeId && approverEmployee.roleKey !== "owner") {
    return { approved: false, reason: "A different manager must approve this action." };
  }

  // 4. Record the approval as a transaction exception
  const exceptionId = randomUUID();
  const timestamp = new Date().toISOString();

  if (isPg()) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      // Supabase REST path — single RPC handles exception + audit atomically
      const sbHeaders = {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      };
      await fetch(`${supabaseUrl}/rest/v1/rpc/register_insert_exception`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          p_exception_id: exceptionId,
          p_action_type: request.actionType,
          p_approver_id: approverEmployee.id,
          p_reason_code: request.reasonCode ?? null,
          p_trigger_amount: request.triggerAmount,
          p_threshold_amount: request.thresholdAmount,
          p_details: request.details ?? null,
          p_org_id: organizationId,
          p_location_id: locationId,
          p_cashier_id: cashierEmployeeId,
        }),
      });
    } else {
      // Pool fallback (local dev)
      const { orgTx } = await import("@/lib/db");
      const client = await orgTx(organizationId);
      try {
        await client.query(
          `INSERT INTO transaction_exceptions (id, transaction_id, exception_code, requires_manager_approval, approved_by_employee_id, reason_code, trigger_amount, threshold_amount, resolved_at, details)
           VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9)`,
          [exceptionId, "pending_" + exceptionId, request.actionType, approverEmployee.id,
            request.reasonCode ?? null, request.triggerAmount, request.thresholdAmount, timestamp, request.details ?? null],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      try {
        const { default: pool } = await import("@/lib/db");
        await pool.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [randomUUID(), organizationId, locationId, approverEmployee.id, "transaction_exception", exceptionId,
            "manager_override", JSON.stringify({
              action_type: request.actionType, cashier_employee_id: cashierEmployeeId,
              approver_employee_id: approverEmployee.id,
              trigger_amount: request.triggerAmount.toFixed(2), threshold_amount: request.thresholdAmount.toFixed(2),
              reason_code: request.reasonCode ?? "none",
            })],
        );
      } catch (err) {
        console.error("[approval-action] audit event failed:", err);
      }
    }
  } else {
    await mutateStore((s) => {
      s.transactionExceptionPlaceholders.unshift({
        id: exceptionId,
        transactionId: "pending_" + exceptionId,
        exceptionCode: request.actionType as "discount_threshold",
        requiresManagerApproval: true,
        resolvedAt: timestamp,
      });

      s.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "pending_" + exceptionId,
        eventKind: "manager_override",
        actorEmployeeId: approverEmployee!.id,
        notes: `Manager ${approverEmployee!.displayName} approved ${request.actionType} for cashier ${cashierEmployeeId}`,
        payload: {
          action_type: request.actionType,
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
