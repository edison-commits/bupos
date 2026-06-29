import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api/with-auth';
import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { randomUUID } from '@/lib/uuid';
import { invalidateInventoryCache } from '@/lib/cache/inventory-cache';
import { safeErr } from '@/lib/logging/safe-err';

interface ReturnLineInput { product_variant_id: string; quantity: number; unit_cost?: number; reason?: string }

export const GET = withAdminAuth("inventory.adjust", async (_request, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const { rows } = await orgQuery(orgId, `
      SELECT sr.*, s.name AS supplier_name,
             COUNT(srl.id)::int AS line_count,
             COALESCE(SUM(srl.quantity), 0)::int AS total_units
      FROM supplier_returns sr
      JOIN suppliers s ON s.id = sr.supplier_id AND s.organization_id = $1
      LEFT JOIN supplier_return_lines srl ON srl.supplier_return_id = sr.id
      WHERE sr.organization_id = $1 AND sr.location_id = $2
      GROUP BY sr.id, s.name
      ORDER BY sr.created_at DESC
      LIMIT 100`, [orgId, locationId]);
    return NextResponse.json({ returns: rows });
  } catch (error) {
    console.error('Supplier returns GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to load supplier returns' }, { status: 500 });
  }
});

export const POST = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, locationId, employee } = ctx;
  const body = await request.json().catch(() => null) as { supplier_id?: string; reason?: string; notes?: string; lines?: ReturnLineInput[] } | null;
  if (!body?.supplier_id || !Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: 'supplier_id and at least one line are required' }, { status: 400 });
  }
  const lines = body.lines.filter((line) => line.product_variant_id && Number(line.quantity) > 0);
  if (lines.length === 0) return NextResponse.json({ error: 'At least one positive return quantity is required' }, { status: 400 });

  const client = await orgTx(orgId);
  try {
    const supplier = await client.query(`SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2 AND is_active = true`, [body.supplier_id, orgId]);
    if (supplier.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });
    }
    const variantIds = Array.from(new Set(lines.map((line) => line.product_variant_id)));
    const variants = await client.query(`SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true`, [variantIds, orgId]);
    if (variants.rows.length !== variantIds.length) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'One or more variants do not belong to this organization' }, { status: 400 });
    }

    const rtvId = randomUUID();
    const rtvNumber = `RTV-${Date.now().toString(36).toUpperCase()}`;
    await client.query(`INSERT INTO supplier_returns (id, organization_id, supplier_id, location_id, rtv_number, status, reason, notes, created_by_employee_id) VALUES ($1,$2,$3,$4,$5,'submitted',$6,$7,$8)`, [rtvId, orgId, body.supplier_id, locationId, rtvNumber, body.reason ?? 'supplier_return', body.notes ?? null, employee.id]);

    for (const line of lines) {
      const qty = Math.floor(Number(line.quantity));
      await client.query(`INSERT INTO supplier_return_lines (supplier_return_id, product_variant_id, quantity, unit_cost, reason) VALUES ($1,$2,$3,$4,$5)`, [rtvId, line.product_variant_id, qty, Number(line.unit_cost ?? 0), line.reason ?? body.reason ?? 'return_to_vendor']);
      const level = await client.query(`SELECT id, on_hand FROM inventory_levels WHERE organization_id = $1 AND location_id = $2 AND product_variant_id = $3 FOR UPDATE`, [orgId, locationId, line.product_variant_id]);
      if (level.rows.length === 0) continue;
      const current = Number(level.rows[0].on_hand);
      const newOnHand = Math.max(0, current - qty);
      const delta = newOnHand - current;
      if (delta === 0) continue;
      await client.query(`UPDATE inventory_levels SET on_hand = $1, updated_at = now() WHERE id = $2 AND organization_id = $3`, [newOnHand, level.rows[0].id, orgId]);
      await client.query(`INSERT INTO inventory_adjustments (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand) VALUES ($1,$2,$3,$4,$5,'supplier_return',$6,$7)`, [orgId, level.rows[0].id, line.product_variant_id, locationId, employee.id, delta, newOnHand]);
    }

    await client.query('COMMIT');
    invalidateInventoryCache(orgId);
    return NextResponse.json({ ok: true, return: { id: rtvId, rtv_number: rtvNumber } }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Supplier returns POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create supplier return' }, { status: 500 });
  } finally {
    client.release();
  }
});
