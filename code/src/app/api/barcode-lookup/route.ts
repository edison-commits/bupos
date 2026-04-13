import { orgQuery } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withDualAuth } from '@/lib/api/with-auth';

export const GET = withDualAuth("catalog.manage", async (request, ctx) => {
  const { orgId, locationId } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  const code = request.nextUrl.searchParams.get('code')

  if (!code || typeof code !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid code parameter' },
      { status: 400 }
    )
  }

  const normalizedCode = code.toLowerCase().trim()

  try {
    // SKU lives on product_variants, not products — search variants joined with products
    const { rows } = await orgQuery(
      orgId,
      `SELECT pv.id as variant_id, pv.sku, pv.size_label, pv.color_label, pv.price,
              p.id as product_id, p.name as product_name, p.slug as product_slug, p.category_id
       FROM product_variants pv
       JOIN products p ON pv.product_id = p.id
       WHERE p.organization_id = $1 AND LOWER(pv.sku) = $2
       LIMIT 1`,
      [orgId, normalizedCode]
    )

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    const r = rows[0]

    // Get inventory for this variant + location
    const invRes = await orgQuery(
      orgId,
      `SELECT on_hand FROM inventory_levels
       WHERE product_variant_id = $1 AND location_id = $2
       LIMIT 1`,
      [r.variant_id, locationId]
    )

    const quantity = invRes.rows[0]?.on_hand ?? 0

    return NextResponse.json({
      product: {
        id: r.product_id,
        name: r.product_name,
        slug: r.product_slug,
        categoryId: r.category_id,
      },
      variant: {
        id: r.variant_id,
        sku: r.sku,
        sizeLabel: r.size_label,
        colorLabel: r.color_label,
        price: Number(r.price),
      },
      inventory: { quantity: Number(quantity) },
    })
  } catch (error) {
    console.error('[barcode-lookup] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
});
