import { orgQuery } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPermission } from '@/lib/authz';

const ORG_ID = process.env.BUPOS_ORG_ID || '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = process.env.BUPOS_LOCATION_ID || 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

// 30-second response cache — keyed by URL so search params are included
const _inventoryCache = new Map<string, { data: unknown; expiresAt: number }>();
const INV_CACHE_TTL = 30_000;

export async function GET(request: NextRequest) {
  await requireAdminPermission('inventory.adjust');
  const cacheKey = request.nextUrl.toString();
  const cached = _inventoryCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return NextResponse.json(cached.data);
  }
  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search')?.toLowerCase() || '';
    const category = searchParams.get('category') || '';
    const productType = searchParams.get('type') || '';
    const brand = searchParams.get('brand') || '';
    const stockFilter = searchParams.get('stock') || 'all';

    // Build WHERE clause conditions
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      conditions.push(
        `(LOWER(p.name) ILIKE $${params.length + 1} OR LOWER(pv.sku) ILIKE $${params.length + 1})`
      );
      params.push(`%${search}%`);
    }

    if (category) {
      conditions.push(`p.category_id = $${params.length + 1}`);
      params.push(category);
    }

    if (productType) {
      conditions.push(`LOWER(p.product_type) = $${params.length + 1}`);
      params.push(productType.toLowerCase());
    }

    if (brand) {
      conditions.push(`LOWER(p.product_brand) = $${params.length + 1}`);
      params.push(brand.toLowerCase());
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Query all in parallel: products, categories, types, brands, summary
    const [productsResult, categoriesResult, typesResult, brandsResult, summaryResult] = await Promise.all([
      // Get products with variants and inventory
      orgQuery(
        ORG_ID,
        `
        SELECT
          p.id as product_id,
          p.name,
          p.slug as product_slug,
          p.category_id,
          p.product_brand,
          p.product_type,
          pv.id as variant_id,
          pv.sku,
          pv.size_label,
          pv.color_label,
          pv.price,
          pv.cost,
          COALESCE(i.on_hand, 0) as quantity
        FROM products p
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id AND i.location_id = $1
        ${whereClause}
        ORDER BY p.name, pv.sku
        `,
        [LOCATION_ID, ...params]
      ),

      // Get all categories
      orgQuery(
        ORG_ID,
        `
        SELECT DISTINCT c.id, c.name
        FROM categories c
        INNER JOIN products p ON p.category_id = c.id
        ORDER BY c.name
        `,
        []
      ),

      // Get all distinct product types
      orgQuery(
        ORG_ID,
        `
        SELECT DISTINCT LOWER(product_type) as value
        FROM products
        WHERE product_type IS NOT NULL AND product_type != ''
        ORDER BY LOWER(product_type)
        `,
        []
      ),

      // Get all distinct brands
      orgQuery(
        ORG_ID,
        `
        SELECT DISTINCT LOWER(product_brand) as value
        FROM products
        WHERE product_brand IS NOT NULL AND product_brand != ''
        ORDER BY LOWER(product_brand)
        `,
        []
      ),

      // Get summary statistics
      orgQuery(
        ORG_ID,
        `
        SELECT
          COUNT(DISTINCT p.id) as total_products,
          COUNT(DISTINCT pv.id) as total_variants,
          COUNT(DISTINCT CASE WHEN COALESCE(i.on_hand, 0) <= 5 AND COALESCE(i.on_hand, 0) > 0 THEN pv.id END) as low_stock_count,
          COUNT(DISTINCT CASE WHEN COALESCE(i.on_hand, 0) = 0 THEN pv.id END) as out_of_stock_count
        FROM products p
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id AND i.location_id = $1
        ${whereClause}
        `,
        [LOCATION_ID, ...params]
      ),
    ]);

    // Process products data to group variants by product
    interface ProductVariant {
      variant_id: string | null;
      sku: string | null;
      size_label: string | null;
      color_label: string | null;
      price: number | null;
      cost: number | null;
      quantity: number;
    }

    interface ProcessedProduct {
      id: string;
      name: string;
      slug: string;
      categoryId: string | null;
      productBrand: string;
      productType: string;
      variants: ProductVariant[];
    }

    const productsMap = new Map<string, ProcessedProduct>();

    for (const row of productsResult.rows as any[]) {
      if (!productsMap.has(row.product_id)) {
        productsMap.set(row.product_id, {
          id: row.product_id,
          name: row.name,
          slug: row.product_slug,
          categoryId: row.category_id,
          productBrand: row.product_brand ?? '',
          productType: row.product_type ?? '',
          variants: [],
        });
      }

      if (row.variant_id) {
        productsMap.get(row.product_id)!.variants.push({
          variant_id: row.variant_id,
          sku: row.sku,
          size_label: row.size_label,
          color_label: row.color_label,
          price: row.price,
          cost: row.cost,
          quantity: row.quantity,
        });
      }
    }

    // Apply stock filter
    let filteredProducts = Array.from(productsMap.values());

    if (stockFilter === 'low') {
      filteredProducts = filteredProducts
        .map((p) => ({
          ...p,
          variants: p.variants.filter((v) => v.quantity <= 5 && v.quantity > 0),
        }))
        .filter((p) => p.variants.length > 0);
    } else if (stockFilter === 'out') {
      filteredProducts = filteredProducts
        .map((p) => ({
          ...p,
          variants: p.variants.filter((v) => v.quantity === 0),
        }))
        .filter((p) => p.variants.length > 0);
    }

    const summary = summaryResult.rows[0] as any;
    const types = typesResult.rows.map((r: any) => r.value).filter(Boolean);
    const brands = brandsResult.rows.map((r: any) => r.value).filter(Boolean);

    const response = {
      products: filteredProducts,
      categories: categoriesResult.rows,
      types,
      brands,
      summary: {
        totalProducts: parseInt(summary.total_products) || 0,
        totalVariants: parseInt(summary.total_variants) || 0,
        lowStockCount: parseInt(summary.low_stock_count) || 0,
        outOfStockCount: parseInt(summary.out_of_stock_count) || 0,
      },
    };
    _inventoryCache.set(cacheKey, { data: response, expiresAt: Date.now() + INV_CACHE_TTL });
    return NextResponse.json(response);
  } catch (error) {
    console.error('Inventory API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory data' },
      { status: 500 }
    );
  }
}
