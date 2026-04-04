import { NextRequest, NextResponse } from "next/server";
import { orgQuery, orgTx, pool } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { requireAdminPermission } from "@/lib/authz";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/transfers
 *
 * Query params:
 *   id       — single transfer detail with lines
 *   status   — filter by status (requested, in_transit, received, cancelled)
 *   location — filter by source or destination location
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    // ── Single transfer detail ──
    const id = sp.get("id");
    if (id) {
      const transfer = await orgQuery(
        ORG_ID,
        `SELECT t.*,
                sl.name AS source_location_name,
                dl.name AS destination_location_name,
                req.display_name AS requested_by_name,
                ship.display_name AS shipped_by_name,
                recv.display_name AS received_by_name,
                canc.display_name AS cancelled_by_name
         FROM transfers t
         LEFT JOIN locations sl ON sl.id = t.source_location_id
         LEFT JOIN locations dl ON dl.id = t.destination_location_id
         LEFT JOIN employees req ON req.id = t.requested_by
         LEFT JOIN employees ship ON ship.id = t.shipped_by
         LEFT JOIN employees recv ON recv.id = t.received_by
         LEFT JOIN employees canc ON canc.id = t.cancelled_by
         WHERE t.id = $1`,
        [id],
      );

      if (transfer.rows.length === 0) {
        return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
      }

      const lines = await orgQuery(
        ORG_ID,
        `SELECT tl.*,
                p.name AS product_name,
                pv.sku, pv.barcode,
                pv.size_label AS size, pv.color_label AS color
         FROM transfer_lines tl
         LEFT JOIN product_variants pv ON pv.id = tl.product_variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         WHERE tl.transfer_id = $1
         ORDER BY tl.created_at`,
        [id],
      );

      return NextResponse.json({ transfer: transfer.rows[0], lines: lines.rows });
    }

    // ── List all ──
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;

    const status = sp.get("status");
    if (status) {
      idx++;
      conditions.push(`t.status = $${idx}`);
      values.push(status);
    }

    const location = sp.get("location");
    if (location) {
      idx++;
      conditions.push(`(t.source_location_id = $${idx} OR t.destination_location_id = $${idx})`);
      values.push(location);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const transfers = await orgQuery(
      ORG_ID,
      `SELECT t.*,
              sl.name AS source_location_name,
              dl.name AS destination_location_name,
              req.display_name AS requested_by_name,
              (SELECT COUNT(*)::int FROM transfer_lines tl WHERE tl.transfer_id = t.id) AS line_count,
              (SELECT COALESCE(SUM(quantity_requested), 0)::int FROM transfer_lines tl WHERE tl.transfer_id = t.id) AS total_units
       FROM transfers t
       LEFT JOIN locations sl ON sl.id = t.source_location_id
       LEFT JOIN locations dl ON dl.id = t.destination_location_id
       LEFT JOIN employees req ON req.id = t.requested_by
       ${where}
       ORDER BY t.created_at DESC`,
      values,
    );

    return NextResponse.json({ transfers: transfers.rows });
  } catch (err) {
    console.error("GET /api/transfers error:", err);
    return NextResponse.json({ error: "Failed to fetch transfers" }, { status: 500 });
  }
}

/**
 * POST /api/transfers
 *
 * Body: { action, ... }
 *   action: "create"  — { sourceLocationId, destinationLocationId, notes?, lines: [{ productVariantId, quantity }], employeeId }
 *   action: "ship"    — { transferId, employeeId }
 *   action: "receive" — { transferId, employeeId }
 *   action: "cancel"  — { transferId, employeeId }
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdminPermission("catalog.manage");

    const body = await req.json();
    const { action } = body;

    if (action === "create") {
      const { sourceLocationId, destinationLocationId, notes, lines, employeeId } = body;

      if (!sourceLocationId || !destinationLocationId) {
        return NextResponse.json({ error: "Source and destination locations required" }, { status: 400 });
      }
      if (sourceLocationId === destinationLocationId) {
        return NextResponse.json({ error: "Source and destination must be different" }, { status: 400 });
      }
      if (!lines || lines.length === 0) {
        return NextResponse.json({ error: "At least one line item required" }, { status: 400 });
      }

      const transferId = randomUUID();
      const client = await orgTx(ORG_ID);
      try {
        await client.query(
          `INSERT INTO transfers (id, organization_id, source_location_id, destination_location_id, status, requested_by, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'requested', $5, $6, now(), now())`,
          [transferId, ORG_ID, sourceLocationId, destinationLocationId, employeeId, notes || null],
        );

        for (const line of lines) {
          await client.query(
            `INSERT INTO transfer_lines (id, transfer_id, product_variant_id, quantity_requested, created_at)
             VALUES ($1, $2, $3, $4, now())`,
            [randomUUID(), transferId, line.productVariantId, line.quantity],
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      // Audit event — outside transaction
      try {
        await pool.query(
          `INSERT INTO audit_events (id, organization_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, 'transfer', $4, 'transfer_created', $5, now())`,
          [randomUUID(), ORG_ID, employeeId, transferId, JSON.stringify({ source: sourceLocationId, destination: destinationLocationId, line_count: lines.length })],
        );
      } catch (err) {
        console.error("[transfers] audit event failed:", err);
      }

      return NextResponse.json({ id: transferId, status: "requested" }, { status: 201 });
    }

    if (action === "ship") {
      const { transferId, employeeId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      const client = await orgTx(ORG_ID);
      try {
        const t = await client.query(
          `SELECT * FROM transfers WHERE id = $1 AND status = 'requested' FOR UPDATE`,
          [transferId],
        );
        if (t.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Transfer not found or not in requested status" }, { status: 400 });
        }
        const transfer = t.rows[0];

        await client.query(
          `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = now(), updated_at = now() WHERE id = $2`,
          [employeeId || null, transferId],
        );

        // Update transfer lines: shipped = requested
        await client.query(
          `UPDATE transfer_lines SET quantity_shipped = quantity_requested WHERE transfer_id = $1`,
          [transferId],
        );

        // Deduct inventory from source location
        const lines = await client.query(
          `SELECT product_variant_id, quantity_requested FROM transfer_lines WHERE transfer_id = $1`,
          [transferId],
        );
        for (const line of lines.rows) {
          await client.query(
            `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand - $1), updated_at = now()
             WHERE product_variant_id = $2 AND location_id = $3`,
            [line.quantity_requested, line.product_variant_id, transfer.source_location_id],
          );
        }

        await client.query("COMMIT");
        return NextResponse.json({ id: transferId, status: "in_transit" });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "receive") {
      const { transferId, employeeId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      const client = await orgTx(ORG_ID);
      try {
        const t = await client.query(
          `SELECT * FROM transfers WHERE id = $1 AND status = 'in_transit' FOR UPDATE`,
          [transferId],
        );
        if (t.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Transfer not found or not in transit" }, { status: 400 });
        }
        const transfer = t.rows[0];

        await client.query(
          `UPDATE transfers SET status = 'received', received_by = $1, received_at = now(), updated_at = now() WHERE id = $2`,
          [employeeId || null, transferId],
        );

        // Update lines: received = shipped
        await client.query(
          `UPDATE transfer_lines SET quantity_received = COALESCE(quantity_shipped, quantity_requested) WHERE transfer_id = $1`,
          [transferId],
        );

        // Add inventory to destination location
        const lines = await client.query(
          `SELECT product_variant_id, COALESCE(quantity_shipped, quantity_requested) AS qty FROM transfer_lines WHERE transfer_id = $1`,
          [transferId],
        );
        for (const line of lines.rows) {
          // Upsert: increment if exists, insert if not
          await client.query(
            `INSERT INTO inventory_levels (id, organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 0, 0, now(), now())
             ON CONFLICT (product_variant_id, location_id)
             DO UPDATE SET on_hand = inventory_levels.on_hand + $5, updated_at = now()`,
            [randomUUID(), ORG_ID, line.product_variant_id, transfer.destination_location_id, line.qty],
          );
        }

        await client.query("COMMIT");
        return NextResponse.json({ id: transferId, status: "received" });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "cancel") {
      const { transferId, employeeId } = body;
      if (!transferId) return NextResponse.json({ error: "transferId required" }, { status: 400 });

      const result = await orgQuery(
        ORG_ID,
        `UPDATE transfers SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), updated_at = now()
         WHERE id = $2 AND status = 'requested'
         RETURNING id`,
        [employeeId || null, transferId],
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ error: "Transfer not found or not in requested status" }, { status: 400 });
      }
      return NextResponse.json({ id: transferId, status: "cancelled" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/transfers error:", err);
    return NextResponse.json({ error: "Failed to process transfer" }, { status: 500 });
  }
}
