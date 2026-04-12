import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/db";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { validateBody, promoCodeSchema } from "@/lib/validation/schemas";

export const runtime = "edge";


/**
 * GET /api/promo-codes
 *
 * Query params:
 *   code     — validate a specific code (returns validity + discount calc)
 *   subtotal — cart subtotal for validation (used with code)
 *   status   — filter by status (active, expired, disabled)
 *   id       — lookup by ID with redemption history
 *
 * Without params returns all promo codes.
 */
export const GET = withDualAuth("catalog.manage", async (req, ctx) => {
  const { orgId } = ctx;
  try {

    const sp = req.nextUrl.searchParams;

    // ── Validate a code (for register use) ──
    const code = sp.get("code");
    if (code) {
      const result = await orgQuery(
        orgId,
        `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at FROM promo_codes WHERE LOWER(code) = LOWER($1)`,
        [code],
      );

      if (result.rows.length === 0) {
        return NextResponse.json({ valid: false, reason: "Code not found" });
      }

      const promo = result.rows[0];
      const now = new Date().toISOString();

      // Validation checks
      if (promo.status !== "active") {
        return NextResponse.json({ valid: false, reason: `Code is ${promo.status}`, promo });
      }
      if (promo.starts_at > now) {
        return NextResponse.json({ valid: false, reason: "Code is not yet active", promo });
      }
      if (promo.expires_at && promo.expires_at < now) {
        return NextResponse.json({ valid: false, reason: "Code has expired", promo });
      }
      if (promo.current_redemptions >= promo.max_redemptions) {
        return NextResponse.json({ valid: false, reason: "Code has reached maximum redemptions", promo });
      }

      const subtotal = Number(sp.get("subtotal")) || 0;
      if (subtotal > 0 && subtotal < Number(promo.minimum_purchase)) {
        return NextResponse.json({
          valid: false,
          reason: `Minimum purchase of $${Number(promo.minimum_purchase).toFixed(2)} required`,
          promo,
        });
      }

      // Calculate discount
      let discountAmount = 0;
      if (subtotal > 0) {
        if (promo.type === "fixed") {
          discountAmount = Math.min(Number(promo.value), subtotal);
        } else if (promo.type === "percent") {
          discountAmount = Number((subtotal * Number(promo.value) / 100).toFixed(2));
        } else if (promo.type === "bogo") {
          discountAmount = Number((subtotal * 0.5).toFixed(2));
        }
      }

      return NextResponse.json({ valid: true, promo, discountAmount });
    }

    // ── Lookup by ID with redemptions ──
    const id = sp.get("id");
    if (id) {
      const promo = await orgQuery(orgId, `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at FROM promo_codes WHERE id = $1`, [id]);
      if (promo.rows.length === 0) {
        return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
      }

      const redemptions = await orgQuery(
        orgId,
        `SELECT pr.*, e.display_name AS employee_name
         FROM promo_redemptions pr
         LEFT JOIN employees e ON e.id = pr.employee_id
         WHERE pr.promo_code_id = $1
         ORDER BY pr.created_at DESC`,
        [id],
      );

      return NextResponse.json({ promo: promo.rows[0], redemptions: redemptions.rows });
    }

    // ── List all ──
    const status = sp.get("status");
    const where = status ? "WHERE status = $1" : "";
    const params = status ? [status] : [];

    const codes = await orgQuery(
      orgId,
      `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at, created_at FROM promo_codes ${where} ORDER BY created_at DESC`,
      params,
    );

    return NextResponse.json({ promoCodes: codes.rows });
  } catch (err) {
    console.error("GET /api/promo-codes error:", err);
    return NextResponse.json({ error: "Failed to fetch promo codes" }, { status: 500 });
  }
});

/**
 * POST /api/promo-codes
 *
 * Body: { action, ... }
 *   action: "create" — { code, description?, type (fixed|percent|bogo), value, minimumPurchase, maxRedemptions, startsAt, expiresAt? }
 *   action: "redeem" — { promoCodeId, transactionId, employeeId, discountAmount }
 *   action: "disable" — { promoCodeId }
 */
export const POST = withAdminAuth("catalog.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "create") {
      const v = validateBody(promoCodeSchema, body);
      if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
      const { code, description, type, value, minimumPurchase, maxRedemptions, startsAt, expiresAt } = v.data;

      // Check for duplicate
      const existing = await orgQuery(orgId, `SELECT id FROM promo_codes WHERE LOWER(code) = LOWER($1)`, [code]);
      if (existing.rows.length > 0) {
        return NextResponse.json({ error: `Promo code "${code}" already exists` }, { status: 409 });
      }

      const promoId = crypto.randomUUID();
      await orgQuery(
        orgId,
        `INSERT INTO promo_codes (id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'active', $9, $10, now(), now())`,
        [promoId, orgId, code.toUpperCase(), description || null, type, value, minimumPurchase || 0, maxRedemptions, startsAt, expiresAt || null],
      );

      return NextResponse.json({ id: promoId, code: code.toUpperCase(), status: "active" }, { status: 201 });
    }

    if (action === "redeem") {
      const { promoCodeId, transactionId, discountAmount } = body;
      if (!promoCodeId || !transactionId || !discountAmount) {
        return NextResponse.json({ error: "promoCodeId, transactionId, and discountAmount required" }, { status: 400 });
      }

      const client = await orgTx(orgId);
      try {
        // Lock and increment
        const pc = await client.query(
          `UPDATE promo_codes SET current_redemptions = current_redemptions + 1, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_redemptions < max_redemptions
           RETURNING *`,
          [promoCodeId],
        );
        if (pc.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code not valid or maxed out" }, { status: 400 });
        }

        await client.query(
          `INSERT INTO promo_redemptions (id, promo_code_id, transaction_id, employee_id, discount_amount, created_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [crypto.randomUUID(), promoCodeId, transactionId, employee.id, discountAmount],
        );

        // Auto-disable if maxed out
        if (pc.rows[0].current_redemptions >= pc.rows[0].max_redemptions) {
          await client.query(
            `UPDATE promo_codes SET status = 'maxed', updated_at = now() WHERE id = $1`,
            [promoCodeId],
          );
        }

        await client.query("COMMIT");
        return NextResponse.json({ redeemed: true, remainingUses: pc.rows[0].max_redemptions - pc.rows[0].current_redemptions });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "disable") {
      const { promoCodeId } = body;
      if (!promoCodeId) {
        return NextResponse.json({ error: "promoCodeId required" }, { status: 400 });
      }

      await orgQuery(
        orgId,
        `UPDATE promo_codes SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [promoCodeId],
      );
      return NextResponse.json({ id: promoCodeId, status: "disabled" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/promo-codes error:", err);
    return NextResponse.json({ error: "Failed to process promo code action" }, { status: 500 });
  }
});
