"use server";

import { randomUUID } from "@/lib/uuid";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx } from "@/lib/supabase-rest";
import { requireRegisterPermission } from "@/lib/authz";

const isPg = () => !!process.env.USE_POSTGRES;

/**
 * Transaction lifecycle event types as specified in the BasicUniformPOS spec.
 * Each register action should log its corresponding event.
 */
export type TransactionEventType =
  | "cart_created"
  | "item_added"
  | "item_removed"
  | "quantity_changed"
  | "discount_applied"
  | "cart_voided"
  | "payment_started"
  | "tender_added"
  | "transaction_completed"
  | "transaction_voided"
  | "cart_held"
  | "cart_recalled";

// Cart-phase events fire before a transactions row exists, so their
// referenceId is a client-generated cart UUID, not a real transaction id.
// These used to always fail the ownership check and ROLLBACK, burning two
// Neon WebSocket handshakes per cart keystroke (~400ms–1.6s) while the
// caller silently swallowed the error. Short-circuit them here.
const CART_PHASE_EVENTS = new Set<TransactionEventType>([
  "cart_created",
  "item_added",
  "item_removed",
  "quantity_changed",
  "discount_applied",
  "cart_voided",
  "payment_started",
  "cart_held",
  "cart_recalled",
]);

export interface TransactionEventInput {
  organizationId: string;
  locationId: string;
  employeeId: string;
  registerSessionId: string;
  /** Cart ID or transaction ID depending on lifecycle stage */
  referenceId: string;
  eventType: TransactionEventType;
  payload: Record<string, string>;
}

/**
 * Log a transaction lifecycle event for audit trail.
 * Called from the client at key points in the checkout flow.
 */
export async function logTransactionEvent(input: TransactionEventInput): Promise<void> {
  // PERF: skip DB work for cart-phase events on PG — their referenceId is a
  // client-side cart UUID, not a transactions.id, so the ownership check
  // (and the transaction_events FK) always fails. Previously every cart
  // keystroke opened 2 Neon WebSocket pools before ROLLBACK. Skipping here
  // preserves today's observable behaviour (these events are discarded
  // silently on PG already) while cutting the pool-cost per click to zero.
  if (isPg() && CART_PHASE_EVENTS.has(input.eventType)) {
    return;
  }

  const authCtx = await requireRegisterPermission("register.open");
  const organizationId = authCtx.employee.organizationId;
  const employeeId = authCtx.employee.id;
  const locationId = authCtx.location.id;

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  if (isPg()) {
    const client = await orgTx(organizationId);
    try {
      // Defense-in-depth: verify the referenced transaction belongs to the
      // caller's org before writing the event. RLS WITH CHECK on
      // transaction_events already prevents cross-org writes, but validating
      // here yields a clearer error to the caller.
      const { rows: ownership } = await client.query(
        `SELECT id FROM transactions WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [input.referenceId, organizationId],
      );
      if (ownership.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Referenced transaction not found in your organization");
      }

      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eventId,
          input.referenceId,
          employeeId,
          input.eventType,
          `${input.eventType} by employee ${employeeId}`,
          JSON.stringify(input.payload),
          timestamp,
        ],
      );

      // Audit event — same transaction so it inherits org context from SET LOCAL.
      // Previously written via raw pool.query which had no org_id set, causing
      // silent RLS drop in forced-RLS environments.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          organizationId,
          locationId,
          employeeId,
          "transaction",
          input.referenceId,
          input.eventType as "transaction_placeholder",
          JSON.stringify(input.payload),
        ],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      store.transactionEventPlaceholders.unshift({
        id: eventId,
        transactionId: input.referenceId,
        eventKind: input.eventType as "transaction_placeholder",
        actorEmployeeId: employeeId,
        notes: `${input.eventType} by employee ${employeeId}`,
        payload: input.payload,
        createdAt: timestamp,
      });
    });
  }
}

/**
 * Batch log multiple events (for efficiency when multiple things happen at once)
 */
export async function logTransactionEvents(inputs: TransactionEventInput[]): Promise<void> {
  for (const input of inputs) {
    await logTransactionEvent(input);
  }
}
