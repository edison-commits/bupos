"use server";

import { randomUUID } from "node:crypto";
import { mutateStore } from "@/lib/persistence/store";
import pool, { orgTx } from "@/lib/db";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";

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
  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  if (isPg()) {
    const client = await orgTx(input.organizationId);
    try {
      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eventId,
          input.referenceId,
          input.employeeId,
          input.eventType,
          `${input.eventType} by employee ${input.employeeId}`,
          JSON.stringify(input.payload),
          timestamp,
        ],
      );

      await pgInsertAuditEvent(
        input.organizationId,
        input.locationId,
        input.employeeId,
        "transaction",
        input.referenceId,
        input.eventType as "transaction_placeholder",
        input.payload,
      );
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      store.transactionEventPlaceholders.unshift({
        id: eventId,
        transactionId: input.referenceId,
        eventKind: input.eventType as "transaction_placeholder",
        actorEmployeeId: input.employeeId,
        notes: `${input.eventType} by employee ${input.employeeId}`,
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
