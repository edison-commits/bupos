import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withAdminAuth } from '@/lib/api/with-auth';
import { safeErr } from '@/lib/logging/safe-err';

export const GET = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  const allowedLocations = ctx.allowedLocations;
  const search = request.nextUrl.searchParams.get('search')?.trim() ?? '';
  const reason = request.nextUrl.searchParams.get('reason')?.trim() ?? '';
  const variantId = request.nextUrl.searchParams.get('variantId')?.trim() ?? '';
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get('pageSize') ?? 50)));
  const offset = (page - 1) * pageSize;

  const params: unknown[] = [orgId];
  const where = ['ia.organization_id = $1'];
  if (allowedLocations !== null) {
    if (allowedLocations.length === 0) return NextResponse.json({ movements: [], pagination: { page, pageSize, total: 0, totalPages: 0 } });
    params.push(allowedLocations);
    where.push(`ia.location_id = ANY($${params.length}::uuid[])`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(pv.sku ILIKE $${params.length} OR p.name ILIKE $${params.length} OR pv.name ILIKE $${params.length})`);
  }
  if (reason) {
    params.push(reason);
    where.push(`ia.reason = $${params.length}`);
  }
  if (variantId) {
    params.push(variantId);
    where.push(`ia.product_variant_id = $${params.length}`);
  }

  try {
    const countResult = await orgQuery(orgId, `
      SELECT COUNT(*)::int AS total
      FROM inventory_adjustments ia
      JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
      JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
      WHERE ${where.join(' AND ')}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    params.push(pageSize, offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;
    const { rows: movements } = await orgQuery(orgId, `
      SELECT ia.id, ia.product_variant_id, pv.sku, pv.name AS variant_name, p.name AS product_name,
             ia.location_id, l.name AS location_name, ia.employee_id, e.display_name AS employee_name,
             ia.reason, ia.delta,
             (ia.resulting_on_hand - ia.delta)::int AS previous_on_hand,
             ia.resulting_on_hand::int AS resulting_on_hand,
             ia.created_at
      FROM inventory_adjustments ia
      JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
      JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
      JOIN locations l ON l.id = ia.location_id AND l.organization_id = $1
      JOIN employees e ON e.id = ia.employee_id AND e.organization_id = $1
      WHERE ${where.join(' AND ')}
      ORDER BY ia.created_at DESC, ia.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    );
    return NextResponse.json({ movements, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (error) {
    console.error('Inventory ledger GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch inventory ledger' }, { status: 500 });
  }
});
