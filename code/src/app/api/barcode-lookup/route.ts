import pool from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb'
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313'

export async function GET(request: NextRequest) {
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
    const { rows } = await pool.query(
      `SELECT pv.id as variant_id, pv.sku, pv.size_label, pv.color_label, pv.price, pv.cost,
              p.id as product_id, p.name as product_name, p.slug as product_slug, p.category_id
       FROM product_variants pv
       JOIN products p ON pv.product_id = p.id
       WHERE p.organization_id = $1 AND LOWER(pv.sku) = $2
       LIMIT 1`,
      [ORG_ID, normalizedCode]
    )

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    const r = rows[0]

    // Get inventory for this variant + location
    const invRes = await pool.query(
      `SELECT on_hand FROM inventory_levels
       WHERE product_variant_id = $1 AND location_id = $2
       LIMIT 1`,
      [r.variant_id, LOCATION_ID]
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
        cost: Number(r.cost),
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
}
