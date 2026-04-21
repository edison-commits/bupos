/**
 * R25-ops-H-2: structured logging for Next.js server actions.
 *
 * API routes go through `withAdminAuth` / `withDualAuth` which
 * generate a reqId + emit `api_route_error` JSON on 500. Server
 * actions (checkout-action.ts, return-action.ts, layaway-action.ts,
 * shift-actions.ts, time-clock-action.ts, approval-action.ts,
 * event-action.ts) don't flow through those wrappers — prior to R25
 * they had ZERO console.error calls, so every checkout failure on
 * prod was an invisible 500 from the user's perspective with nothing
 * in the Worker log to correlate.
 *
 * `mintActionReqId()` → uuid, logged once at entry if you want.
 * `logActionError()`  → structured JSON line matching the shape
 *                       api_route_error uses, so log queries can
 *                       join across API + action surfaces.
 */

import { safeErr } from "@/lib/logging/safe-err";
import { randomUUID } from "@/lib/uuid";

export function mintActionReqId(): string {
  return randomUUID();
}

export interface ActionLogContext {
  action: string;
  reqId: string;
  orgId?: string;
  employeeId?: string;
  roleKey?: string;
  // Free-form fields that help diagnose a specific action failure.
  // Callers pass whatever's relevant (cart totals, layaway id, etc.)
  [k: string]: unknown;
}

export function logActionError(ctx: ActionLogContext, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      at: new Date().toISOString(),
      event: "server_action_error",
      ...ctx,
      error: safeErr(err),
    }),
  );
}
