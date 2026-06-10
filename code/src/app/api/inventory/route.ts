/**
 * BuPOS Inventory API
 * @tags inventory
 */
import { NextResponse } from 'next/server';
import { orgTx } from '@/lib/supabase-rest';
import { withAdminAuth } from '@/lib/api/with-auth';
import { _inventoryCache, INV_CACHE_TTL, MAX_INV_CACHE_SIZE } from '@/lib/cache/inventory-cache';
import { safeErr } from "@/lib/logging/safe-err";
export { invalidateInventoryCache } from '@/lib/cache/inventory-cache';

interface ProductRow {
  product_id: string;
  name: string;
  product_slug: string;
  category_id: string | null;
  product_brand: string | null;
  product_type: string | null;
  variant_id: string | null;
  sku: string | null;
  size_label: string | null;
  color_label: string | null;
  price: string | null;
  cost: string | null;
  quantity: number;
}

interface SummaryRow {
  total_products: string;
  total_variants: string;
  low_stock_count: string;
  out_of_stock_count: string;
}

// Response cache — keyed by URL so search params are included. See
// src/lib/cache/inventory-cache.ts. Write paths invalidate via
// invalidateInventoryCache(orgId).

export const GET = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  const locationId = ctx.locationId;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }
  // SECURITY: include locationId AND roleKey in the cache key. Without
  // locationId, two admins with different `locationIds[0]` would clobber
  // each other's cached inventory. Role is included so any future
  // role-based column filtering (e.g., support sees only public fields)
  // can't serve a higher-privilege cached row to a lower-privilege caller.
  const cacheKey = `${orgId}:${locationId}:${ctx.employee.roleKey}:${request.nextUrl.toString()}`;
  const cached = _inventoryCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    const hit = NextResponse.json(cached.data);
    hit.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return hit;
  }
  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search')?.toLowerCase() || '';
    const category = searchParams.get('category') || '';
    const productType = searchParams.get('type') || '';
    const brand = searchParams.get('brand') || '';
    const stockFilter = searchParams.get('stock') || 'all';
    // Opt-in pagination + sorting, applied AFTER the JS-side stock filter
    // below (so they compose). Absent `page`, the legacy full list returns.
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0); // 0 = not requested
    const pageSize = Math.min(200, Math.max(10, parseInt(searchParams.get('pageSize') ?? '50', 10) || 50));
    const sortKey = searchParams.get('sort') === 'stock' ? 'stock' : 'name';
    const sortDir = searchParams.get('dir') === 'desc' ? -1 : 1;

    // R27-C7: explicit organization_id filter prepended to the conditions
    // list. $1 is locationId, $2 is orgId, filter placeholders start at $3.
    // Without this, an owner at any tenant listed every tenant's catalog.
    const conditions: string[] = ['p.organization_id = $2'];
    const params: (string | number)[] = [];

    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        `(LOWER(p.name) ILIKE $${params.length + 3} OR LOWER(pv.sku) ILIKE $${params.length + 3})`
      );
      params.push(`%${escaped}%`);
    }

    if (category) {
      conditions.push(`p.category_id = $${params.length + 3}`);
      params.push(category);
    }

    if (productType) {
      conditions.push(`LOWER(p.product_type) = $${params.length + 3}`);
      params.push(productType.toLowerCase());
    }

    if (brand) {
      conditions.push(`LOWER(p.product_brand) = $${params.length + 3}`);
      params.push(brand.toLowerCase());
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Run all 5 reads on ONE shared Neon client instead of 5 parallel
    // orgQuery() calls. Each orgQuery opens a fresh one-shot Pool on
    // Cloudflare Workers (per-call facade), so Promise.all of 5 = 5
    // concurrent TLS+WebSocket handshakes. On cold-start that burst can
    // briefly exceed Neon's per-project connection limit and yields a
    // transient 500 on the first inventory load. Serialising the reads on
    // a single client keeps handshake count at 1 while keeping the total
    // wall time in the same order of magnitude (the small metadata
    // queries run in milliseconds on the hot client).
    const sharedClient = await orgTx(orgId);
    let productsResult, categoriesResult, typesResult, brandsResult, summaryResult;
    try {
      productsResult = await sharedClient.query(
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
        LEFT JOIN product_variants pv ON p.id = pv.product_id AND pv.organization_id = $2
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id
          AND i.organization_id = $2
          AND i.location_id = $1
        ${whereClause}
        ORDER BY p.name, pv.sku
        `,
        [locationId, orgId, ...params]
      );

      categoriesResult = await sharedClient.query(
        `
        SELECT DISTINCT c.id, c.name
        FROM categories c
        INNER JOIN products p ON p.category_id = c.id AND p.organization_id = $1
        WHERE c.organization_id = $1
        ORDER BY c.name
        `,
        [orgId]
      );

      typesResult = await sharedClient.query(
        `
        SELECT DISTINCT LOWER(product_type) as value
        FROM products
        WHERE organization_id = $1 AND product_type IS NOT NULL AND product_type != ''
        ORDER BY LOWER(product_type)
        `,
        [orgId]
      );

      brandsResult = await sharedClient.query(
        `
        SELECT DISTINCT LOWER(product_brand) as value
        FROM products
        WHERE organization_id = $1 AND product_brand IS NOT NULL AND product_brand != ''
        ORDER BY LOWER(product_brand)
        `,
        [orgId]
      );

      summaryResult = await sharedClient.query(
        `
        SELECT
          COUNT(DISTINCT p.id) as total_products,
          COUNT(DISTINCT pv.id) as total_variants,
          COUNT(DISTINCT CASE WHEN COALESCE(i.on_hand, 0) <= 5 AND COALESCE(i.on_hand, 0) > 0 THEN pv.id END) as low_stock_count,
          COUNT(DISTINCT CASE WHEN COALESCE(i.on_hand, 0) = 0 THEN pv.id END) as out_of_stock_count
        FROM products p
        LEFT JOIN product_variants pv ON p.id = pv.product_id AND pv.organization_id = $2
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id
          AND i.organization_id = $2
          AND i.location_id = $1
        ${whereClause}
        `,
        [locationId, orgId, ...params]
      );

      await sharedClient.query("COMMIT");
    } catch (e) {
      await sharedClient.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      sharedClient.release();
    }

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

    for (const row of productsResult.rows as ProductRow[]) {
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
          price: row.price != null ? Number(row.price) : null,
          cost: row.cost != null ? Number(row.cost) : null,
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

    // Sort (name asc default; stock = total on-hand across variants), then
    // slice the requested page. SQL already ordered by name, so the name
    // sort only matters for `desc`.
    if (sortKey === 'stock') {
      const totalQty = (p: ProcessedProduct) => p.variants.reduce((s, v) => s + v.quantity, 0);
      filteredProducts.sort((a, b) => (totalQty(a) - totalQty(b)) * sortDir || a.name.localeCompare(b.name));
    } else if (sortDir === -1) {
      filteredProducts.reverse();
    }

    let pagination: { page: number; pageSize: number; total: number; totalPages: number } | null = null;
    if (page > 0) {
      const total = filteredProducts.length;
      pagination = { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
      filteredProducts = filteredProducts.slice((page - 1) * pageSize, page * pageSize);
    }

    const summary = summaryResult.rows[0] as SummaryRow;
    const types = typesResult.rows.map((r: Record<string, string>) => r.value).filter(Boolean);
    const brands = brandsResult.rows.map((r: Record<string, string>) => r.value).filter(Boolean);

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
      ...(pagination ? { pagination } : {}),
    };
    _inventoryCache.set(cacheKey, { data: response, expiresAt: Date.now() + INV_CACHE_TTL });
    if (_inventoryCache.size > MAX_INV_CACHE_SIZE) {
      const firstKey = _inventoryCache.keys().next().value;
      if (firstKey) _inventoryCache.delete(firstKey);
    }
    const resp = NextResponse.json(response);
    resp.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return resp;
  } catch (error) {
    console.error('Inventory API error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to fetch inventory data' },
      { status: 500 }
    );
  }
});
