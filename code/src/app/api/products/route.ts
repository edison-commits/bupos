import { orgQuery, pool } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPermission } from '@/lib/authz';
import { invalidateProductsCache, invalidateVariantsCache } from '@/lib/persistence/postgres-store';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
import { BUPOS_LOCATION_ID, BUPOS_ORG_ID } from '@/lib/env';

// 30-second response cache
const _productsCache = new Map<string, { data: unknown; expiresAt: number }>();
const PROD_CACHE_TTL = 30_000;
const MAX_CACHE_SIZE = 50;

export async function GET(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId ?? BUPOS_ORG_ID;

  const cacheKey = request.nextUrl.toString();
  const cached = _productsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    const hit = NextResponse.json(cached.data);
    hit.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return hit;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search')?.toLowerCase() || '';
    const category = searchParams.get('category') || '';
    const active = searchParams.get('active');

    // Build WHERE clause conditions
    const conditions: string[] = [];
    const params: (string | boolean)[] = [];

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

    if (active !== null) {
      conditions.push(`p.is_active = $${params.length + 1}`);
      params.push(active === 'true');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use Promise.all for parallel queries
    const [productsResult, categoriesResult, summaryResult] = await Promise.all([
      // Get products with variants and inventory
      orgQuery(
        orgId,
        `
        SELECT
          p.id,
          p.name,
          p.slug,
          p.category_id,
          c.name as category_name,
          p.description,
          p.image_url,
          p.is_active,
          p.is_touch_favorite,
          p.supplier_id,
          s.name as supplier_name,
          pv.id as variant_id,
          pv.sku,
          pv.barcode,
          pv.name as variant_name,
          pv.size_label,
          pv.color_label,
          pv.price,
          pv.compare_at_price,
          pv.cost,
          pv.is_active as variant_is_active,
          COALESCE(i.on_hand, 0) as stock
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id AND i.location_id = $1
        ${whereClause}
        ORDER BY p.name, pv.sku
        `,
        [BUPOS_LOCATION_ID, ...params]
      ),

      // Get all categories
      orgQuery(
        orgId,
        `
        SELECT id, name, slug
        FROM categories
        ORDER BY name
        `,
        []
      ),

      // Get summary statistics
      orgQuery(
        orgId,
        `
        SELECT
          COUNT(DISTINCT p.id) as total_products,
          COUNT(DISTINCT CASE WHEN p.is_active THEN p.id END) as active_products,
          COUNT(DISTINCT pv.id) as total_variants,
          COUNT(DISTINCT c.id) as categories_count
        FROM products p
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN categories c ON p.category_id = c.id
        `,
        []
      ),
    ]);

    // Transform raw rows into product hierarchy
    const productsMap = new Map();
    const priceRanges = new Map();

    productsResult.rows.forEach((row: any) => {
      if (!productsMap.has(row.id)) {
        productsMap.set(row.id, {
          id: row.id,
          name: row.name,
          slug: row.slug,
          category_id: row.category_id,
          category_name: row.category_name,
          description: row.description,
          image_url: row.image_url,
          is_active: row.is_active,
          is_touch_favorite: row.is_touch_favorite,
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name,
          variants: [],
        });
        priceRanges.set(row.id, []);
      }

      if (row.variant_id) {
        productsMap.get(row.id).variants.push({
          id: row.variant_id,
          sku: row.sku,
          barcode: row.barcode,
          name: row.variant_name,
          size_label: row.size_label,
          color_label: row.color_label,
          price: parseFloat(row.price),
          compare_at_price: row.compare_at_price ? parseFloat(row.compare_at_price) : null,
          cost: parseFloat(row.cost),
          is_active: row.variant_is_active,
          stock: row.stock,
        });
        priceRanges.get(row.id).push(parseFloat(row.price));
      }
    });

    // Calculate aggregates
    const products = Array.from(productsMap.values()).map(product => {
      const prices = priceRanges.get(product.id) || [];
      return {
        ...product,
        variant_count: product.variants.length,
        price_range:
          prices.length > 0
            ? { min: Math.min(...prices), max: Math.max(...prices) }
            : null,
        total_stock: product.variants.reduce((sum: number, v: any) => sum + v.stock, 0),
      };
    });

    const categories = categoriesResult.rows;
    const summary = summaryResult.rows[0];

    const response = {
      products,
      categories,
      summary,
    };
    _productsCache.set(cacheKey, { data: response, expiresAt: Date.now() + PROD_CACHE_TTL });
    if (_productsCache.size > MAX_CACHE_SIZE) {
      const firstKey = _productsCache.keys().next().value;
      if (firstKey) _productsCache.delete(firstKey);
    }
    const resp = NextResponse.json(response);
    resp.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return resp;
  } catch (error) {
    console.error('Products GET error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = await pool.connect();
  try {
    const body = await request.json();

    // Set RLS context
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);

    // Handle category creation
    if (body.category) {
      const { name, slug } = body.category;
      const result = await client.query(
        `INSERT INTO categories (id, organization_id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
         RETURNING id, name, slug`,
        [orgId, name, slug]
      );
      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      return NextResponse.json(result.rows[0], { status: 201 });
    }

    // Handle variant creation
    if (body.product_id && body.variant) {
      const { sku, barcode, name, size_label, color_label, price, compare_at_price, cost } = body.variant;
      if (!sku) {
        return NextResponse.json({ error: 'SKU is required for variants' }, { status: 400 });
      }
      if (typeof price === 'number' && price < 0) {
        return NextResponse.json({ error: 'Price cannot be negative' }, { status: 400 });
      }
      // Reject duplicate SKU within this org
      const dupCheck = await client.query(
        `SELECT id FROM product_variants WHERE organization_id = $1 AND LOWER(sku) = LOWER($2) LIMIT 1`,
        [orgId, sku],
      );
      if (dupCheck.rows.length > 0) {
        return NextResponse.json({ error: `SKU "${sku}" already exists` }, { status: 409 });
      }
      const result = await client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW(), NOW())
         RETURNING id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active`,
        [orgId, body.product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost]
      );
      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json(result.rows[0], { status: 201 });
    }

    // Handle product creation
    const { name, slug, category_id, description, image_url, is_active = true, is_touch_favorite = false } = body;
    const result = await client.query(
      `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, is_touch_favorite, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id, name, slug, category_id, description, image_url, is_active, is_touch_favorite`,
      [orgId, category_id || null, name, slug, description || null, image_url || null, is_active, is_touch_favorite]
    );
    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products POST error:', error);
    return NextResponse.json(
      { error: 'Failed to create product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 });
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);

    // Handle product update
    if (updates.name || updates.slug || updates.description !== undefined || updates.image_url !== undefined || updates.is_active !== undefined || updates.is_touch_favorite !== undefined) {
      const fields = [];
      const values = [];
      let paramIndex = 1;

      if (updates.name) {
        fields.push(`name = $${paramIndex}`);
        values.push(updates.name);
        paramIndex++;
      }
      if (updates.slug) {
        fields.push(`slug = $${paramIndex}`);
        values.push(updates.slug);
        paramIndex++;
      }
      if (updates.description !== undefined) {
        fields.push(`description = $${paramIndex}`);
        values.push(updates.description);
        paramIndex++;
      }
      if (updates.image_url !== undefined) {
        fields.push(`image_url = $${paramIndex}`);
        values.push(updates.image_url);
        paramIndex++;
      }
      if (updates.is_active !== undefined) {
        fields.push(`is_active = $${paramIndex}`);
        values.push(updates.is_active);
        paramIndex++;
      }
      if (updates.is_touch_favorite !== undefined) {
        fields.push(`is_touch_favorite = $${paramIndex}`);
        values.push(updates.is_touch_favorite);
        paramIndex++;
      }
      if (updates.category_id !== undefined) {
        fields.push(`category_id = $${paramIndex}`);
        values.push(updates.category_id);
        paramIndex++;
      }

      fields.push('updated_at = NOW()');

      const result = await client.query(
        `UPDATE products SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, name, slug, category_id, description, image_url, is_active, is_touch_favorite, updated_at`,
        [...values, id]
      );

      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      return NextResponse.json(result.rows[0]);
    }

    // Handle variant update
    if (updates.variant_id && (updates.price !== undefined || updates.cost !== undefined)) {
      if (typeof updates.price === 'number' && updates.price < 0) {
        return NextResponse.json({ error: 'Price cannot be negative' }, { status: 400 });
      }
      if (typeof updates.cost === 'number' && updates.cost < 0) {
        return NextResponse.json({ error: 'Cost cannot be negative' }, { status: 400 });
      }
      const fields = [];
      const values = [];
      let paramIndex = 1;

      if (updates.price !== undefined) {
        fields.push(`price = $${paramIndex}`);
        values.push(updates.price);
        paramIndex++;
      }
      if (updates.cost !== undefined) {
        fields.push(`cost = $${paramIndex}`);
        values.push(updates.cost);
        paramIndex++;
      }

      fields.push('updated_at = NOW()');

      const result = await client.query(
        `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, sku, price, cost, updated_at`,
        [...values, updates.variant_id]
      );

      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json(result.rows[0]);
    }

    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    return NextResponse.json({ message: 'No updates made' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products PUT error:', error);
    return NextResponse.json(
      { error: 'Failed to update product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 });
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);

    // Soft delete: set is_active to false
    const result = await client.query(
      `UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );

    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    return NextResponse.json({ message: 'Product deleted', id: result.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products DELETE error:', error);
    return NextResponse.json(
      { error: 'Failed to delete product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function PATCH(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'import_csv') {
      const { rows } = body;
      if (!Array.isArray(rows)) {
        return NextResponse.json({ error: 'Invalid CSV data' }, { status: 400 });
      }

      const results: { row: number; status: 'created' | 'updated' | 'skipped'; name: string; message?: string }[] = [];
      let created = 0;
      let skipped = 0;

      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);

      // Build lookup maps
      const catsResult = await client.query(
        `SELECT id, name FROM categories WHERE organization_id = $1`,
        [orgId]
      );
      const catMap = new Map(catsResult.rows.map((r: any) => [r.name.toLowerCase(), r.id]));

      const existingResult = await client.query(
        `SELECT id, name, category_id FROM products WHERE organization_id = $1`,
        [orgId]
      );
      const productsByName = new Map(existingResult.rows.map((r: any) => [r.name.toLowerCase(), { id: r.id, categoryId: r.category_id }]));

      const variantResult = await client.query(
        `SELECT id, sku FROM product_variants WHERE organization_id = $1 AND sku IS NOT NULL AND sku != ''`,
        [orgId]
      );
      const skuMap = new Map(variantResult.rows.map((r: any) => [r.sku.toLowerCase(), r.id]));

      // Pre-collect new categories to batch insert
      const newCategories: { displayName: string; slug: string }[] = [];
      for (const row of rows) {
        const categoryName = String(row.category || row.Category || row.CATEGORY_NAME || '').trim().toLowerCase();
        if (categoryName && !catMap.has(categoryName) && !newCategories.some(c => c.displayName.toLowerCase() === categoryName)) {
          const displayName = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
          const slug = categoryName.replace(/[^a-z0-9]+/g, '-');
          newCategories.push({ displayName, slug });
        }
      }

      // Pre-collect new products to batch insert
      const newProducts: { name: string; slug: string; categoryId: string | null; description: string | null; imageUrl: string | null; isActive: boolean }[] = [];
      for (const row of rows) {
        const name = String(row.name || row.Name || row.PRODUCT_NAME || '').trim();
        const categoryName = String(row.category || row.Category || row.CATEGORY_NAME || '').trim().toLowerCase();
        const description = String(row.description || row.Description || row.DESCRIPTION || '').trim();
        const imageUrl = String(row.image_url || row.imageUrl || row.IMAGE_URL || '').trim();
        const isActive = String(row.is_active || row.isActive || row.IS_ACTIVE || 'true').toLowerCase() !== 'false';
        const nameKey = name.toLowerCase();
        if (!name || productsByName.has(nameKey) || newProducts.some(p => p.name.toLowerCase() === nameKey)) continue;
        let categoryId: string | null = null;
        if (categoryName) {
          if (catMap.has(categoryName)) {
            categoryId = catMap.get(categoryName)!;
          } else {
            categoryId = `new:${categoryName}`;
          }
        }
        newProducts.push({
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          categoryId,
          description: description || null,
          imageUrl: imageUrl || null,
          isActive,
        });
      }

      // Pre-collect SKUs in this batch to detect within-batch duplicates
      const skusInBatch = new Set<string>();
      for (const row of rows) {
        const sku = String(row.sku || row.SKU || row.Variant_SKU || '').trim().toLowerCase();
        if (sku) skusInBatch.add(sku);
      }

      const variantsToInsert: { productId: string; sku: string; barcode: string | null; variantName: string; sizeLabel: string | null; colorLabel: string | null; price: number; cost: number; isActive: boolean; row: number; name: string }[] = [];

      // Validate rows and collect variants (no INSERTs yet)
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +2 for 1-indexed + header row
        const name = String(row.name || row.Name || row.PRODUCT_NAME || '').trim();
        const sku = String(row.sku || row.SKU || row.Variant_SKU || '').trim().toLowerCase();
        const price = parseFloat(row.price || row.Price || row.PRICE || '0');
        const categoryName = String(row.category || row.Category || row.CATEGORY_NAME || '').trim().toLowerCase();
        const sizeLabel = String(row.size || row.Size || row.SIZE_LABEL || '').trim();
        const colorLabel = String(row.color || row.Color || row.COLOR_LABEL || '').trim();
        const cost = parseFloat(row.cost || row.Cost || row.COST || '0') || 0;
        const barcode = String(row.barcode || row.Barcode || row.BARCODE || '').trim();
        const description = String(row.description || row.Description || row.DESCRIPTION || '').trim();
        const imageUrl = String(row.image_url || row.imageUrl || row.IMAGE_URL || '').trim();
        const isActive = String(row.is_active || row.isActive || row.IS_ACTIVE || 'true').toLowerCase() !== 'false';

        if (!name) { results.push({ row: rowNum, status: 'skipped', name: '(empty)', message: 'Missing product name' }); skipped++; continue; }
        if (!sku) { results.push({ row: rowNum, status: 'skipped', name, message: 'Missing SKU' }); skipped++; continue; }
        if (isNaN(price) || price <= 0) { results.push({ row: rowNum, status: 'skipped', name, message: 'Invalid price' }); skipped++; continue; }

        // Resolve category
        let categoryId: string | null = null;
        if (categoryName) {
          if (catMap.has(categoryName)) {
            categoryId = catMap.get(categoryName)!;
          } else {
            results.push({ row: rowNum, status: 'skipped', name, message: `Category "${categoryName}" not found after batch insert` }); skipped++; continue;
          }
        }

        // Resolve product
        const nameKey = name.toLowerCase();
        let productId: string;
        const existingProd = productsByName.get(nameKey);
        if (existingProd) {
          productId = existingProd.id;
        } else {
          const newProd = newProducts.find(p => p.name.toLowerCase() === nameKey);
          if (newProd) {
            productId = `new:${newProducts.indexOf(newProd)}`;
          } else {
            results.push({ row: rowNum, status: 'skipped', name, message: 'Product not found in batch context' }); skipped++; continue;
          }
        }

        // Check SKU duplicates
        if (skuMap.has(sku)) {
          results.push({ row: rowNum, status: 'skipped', name, message: `SKU "${sku}" already exists in database` }); skipped++; continue;
        }
        // Deduplicate within this batch — keep first occurrence
        if (skusInBatch.has(sku)) {
          skusInBatch.delete(sku);
        } else {
          results.push({ row: rowNum, status: 'skipped', name, message: `Duplicate SKU "${sku}" in import batch` }); skipped++; continue;
        }

        const variantName = [sizeLabel, colorLabel].filter(Boolean).join(' / ') || name;
        variantsToInsert.push({ productId, sku, barcode: barcode || null, variantName, sizeLabel: sizeLabel || null, colorLabel: colorLabel || null, price, cost, isActive, row: rowNum, name });
        skuMap.set(sku, sku);
        created++;
        results.push({ row: rowNum, status: 'created', name });
      }

      // Batch insert categories
      if (newCategories.length > 0) {
        const catValues: string[] = [];
        const catParams: string[] = [];
        let idx = 1;
        for (const cat of newCategories) {
          catValues.push(`(gen_random_uuid(), $1, $${idx}, $${idx + 1}, NOW(), NOW())`);
          catParams.push(cat.displayName, cat.slug);
          idx += 2;
        }
        await client.query(
          `INSERT INTO categories (id, organization_id, name, slug, created_at, updated_at) VALUES ${catValues.join(', ')}`,
          [orgId, ...catParams]
        );
        // Refresh catMap with newly inserted categories
        const newCatResult = await client.query(
          `SELECT id, name FROM categories WHERE organization_id = $1 AND name = ANY($2)`,
          [orgId, newCategories.map(c => c.displayName)]
        );
        for (const r of newCatResult.rows) catMap.set(r.name.toLowerCase(), r.id);
      }

      // Resolve product categoryIds and batch insert products
      for (const p of newProducts) {
        if (p.categoryId && (p.categoryId as string).startsWith('new:')) {
          const catName = (p.categoryId as string).slice(4);
          p.categoryId = catMap.get(catName) || null;
        }
      }
      if (newProducts.length > 0) {
        const prodValues: string[] = [];
        const prodParams: (string | number | boolean | null)[] = [];
        let idx = 1;
        for (const p of newProducts) {
          prodValues.push(`(gen_random_uuid(), $1, $${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, false, NOW(), NOW())`);
          prodParams.push(p.categoryId, p.name, p.slug, p.description, p.imageUrl, p.isActive);
          idx += 6;
        }
        await client.query(
          `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, is_touch_favorite, created_at, updated_at) VALUES ${prodValues.join(', ')}`,
          [orgId, ...prodParams]
        );
        // Refresh product map with newly inserted products
        const newProdResult = await client.query(
          `SELECT id, name FROM products WHERE organization_id = $1 AND name = ANY($2)`,
          [orgId, newProducts.map(p => p.name)]
        );
        for (const r of newProdResult.rows) {
          const key = r.name.toLowerCase();
          const existing = productsByName.get(key);
          if (!existing || typeof existing.id !== 'string' || !existing.id.startsWith('new:')) {
            productsByName.set(key, { id: r.id, categoryId: null });
          } else {
            existing.id = r.id;
          }
        }
      }

      // Resolve final product IDs for variants
      for (const v of variantsToInsert) {
        if ((v.productId as string).startsWith('new:')) {
          const idx = parseInt((v.productId as string).slice(4), 10);
          v.productId = newProducts[idx] ? (productsByName.get(newProducts[idx].name.toLowerCase())?.id || 'unknown') : 'unknown';
        }
      }

      // Batch insert variants in chunks of 500
      const CHUNK_SIZE = 500;
      for (let c = 0; c < variantsToInsert.length; c += CHUNK_SIZE) {
        const chunk = variantsToInsert.slice(c, c + CHUNK_SIZE);
        const varValues: string[] = [];
        const varParams: (string | number | boolean | null)[] = [];
        let idx = 1;
        for (const v of chunk) {
          varValues.push(`(gen_random_uuid(), $1, $2, $${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, NOW(), NOW())`);
          varParams.push(v.productId, v.sku, v.barcode, v.variantName, v.sizeLabel, v.colorLabel, v.price, v.cost, v.isActive);
          idx += 8;
        }
        await client.query(
          `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, cost, is_active, created_at, updated_at) VALUES ${varValues.join(', ')}`,
          [orgId, ...varParams]
        );
      }

      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json({ created, skipped, total: rows.length, results });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products PATCH error:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  } finally {
    client.release();
  }
}
