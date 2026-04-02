import { orgQuery, pool } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

export async function GET(request: NextRequest) {
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
        ORG_ID,
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
        [LOCATION_ID, ...params]
      ),

      // Get all categories
      orgQuery(
        ORG_ID,
        `
        SELECT id, name, slug
        FROM categories
        ORDER BY name
        `,
        []
      ),

      // Get summary statistics
      orgQuery(
        ORG_ID,
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

    return NextResponse.json({
      products,
      categories,
      summary,
    });
  } catch (error) {
    console.error('Products GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch products' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const client = await pool.connect();
  try {
    const body = await request.json();

    // Set RLS context
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${ORG_ID}'`);

    // Handle category creation
    if (body.category) {
      const { name, slug } = body.category;
      const result = await client.query(
        `INSERT INTO categories (id, organization_id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
         RETURNING id, name, slug`,
        [ORG_ID, name, slug]
      );
      await client.query('COMMIT');
      return NextResponse.json(result.rows[0]);
    }

    // Handle variant creation
    if (body.product_id && body.variant) {
      const { sku, barcode, name, size_label, color_label, price, compare_at_price, cost } = body.variant;
      const result = await client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW(), NOW())
         RETURNING id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active`,
        [ORG_ID, body.product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost]
      );
      await client.query('COMMIT');
      return NextResponse.json(result.rows[0]);
    }

    // Handle product creation
    const { name, slug, category_id, description, image_url, is_active = true, is_touch_favorite = false } = body;
    const result = await client.query(
      `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, is_touch_favorite, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id, name, slug, category_id, description, image_url, is_active, is_touch_favorite`,
      [ORG_ID, category_id || null, name, slug, description || null, image_url || null, is_active, is_touch_favorite]
    );
    await client.query('COMMIT');
    return NextResponse.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function PUT(request: NextRequest) {
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 });
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${ORG_ID}'`);

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
        `UPDATE products SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        [...values, id]
      );

      await client.query('COMMIT');
      return NextResponse.json(result.rows[0]);
    }

    // Handle variant update
    if (updates.variant_id && (updates.price !== undefined || updates.cost !== undefined)) {
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
        `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        [...values, updates.variant_id]
      );

      await client.query('COMMIT');
      return NextResponse.json(result.rows[0]);
    }

    await client.query('COMMIT');
    return NextResponse.json({ message: 'No updates made' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function DELETE(request: NextRequest) {
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 });
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${ORG_ID}'`);

    // Soft delete: set is_active to false
    const result = await client.query(
      `UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );

    await client.query('COMMIT');
    return NextResponse.json({ message: 'Product deleted', id: result.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products DELETE error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'import_csv') {
      const { rows } = body; // array of product rows from CSV
      if (!Array.isArray(rows)) {
        return NextResponse.json({ error: 'Invalid CSV data' }, { status: 400 });
      }

      const results: { row: number; status: 'created' | 'updated' | 'skipped'; name: string; message?: string }[] = [];
      let created = 0;
      let skipped = 0;

      // Build category lookup map
      const catsResult = await orgQuery(ORG_ID, `SELECT id, name FROM categories WHERE organization_id = $1`, [ORG_ID]);
      const catMap = new Map(catsResult.rows.map((r: any) => [r.name.toLowerCase(), r.id]));

      // Get existing products by name (within this org)
      const existingResult = await orgQuery(ORG_ID, `SELECT id, name, category_id FROM products WHERE organization_id = $1`, [ORG_ID]);
      const productMap = new Map(existingResult.rows.map((r: any) => [r.name.toLowerCase(), r]));

      // Get existing variants by SKU
      const variantResult = await orgQuery(ORG_ID, `SELECT id, sku FROM product_variants WHERE organization_id = $1 AND sku IS NOT NULL AND sku != ''`, [ORG_ID]);
      const skuMap = new Map(variantResult.rows.map((r: any) => [r.sku.toLowerCase(), r.id]));

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +2 for 1-indexed + header row

        try {
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

          if (!name) {
            results.push({ row: rowNum, status: 'skipped', name: '(empty)', message: 'Missing product name' });
            skipped++;
            continue;
          }
          if (!sku) {
            results.push({ row: rowNum, status: 'skipped', name, message: 'Missing SKU' });
            skipped++;
            continue;
          }
          if (isNaN(price) || price <= 0) {
            results.push({ row: rowNum, status: 'skipped', name, message: 'Invalid price' });
            skipped++;
            continue;
          }

          // Look up or create category
          let categoryId: string | null = null;
          if (categoryName) {
            if (catMap.has(categoryName)) {
              categoryId = catMap.get(categoryName)!;
            } else {
              const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
              const catInsert = await orgQuery(
                ORG_ID,
                `INSERT INTO categories (id, organization_id, name, slug, created_at, updated_at)
                 VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
                 RETURNING id`,
                [ORG_ID, categoryName.charAt(0).toUpperCase() + categoryName.slice(1), slug]
              );
              categoryId = catInsert.rows[0].id;
              catMap.set(categoryName, categoryId);
            }
          }

          // Check if variant with this SKU already exists
          if (skuMap.has(sku)) {
            results.push({ row: rowNum, status: 'skipped', name, message: `SKU "${sku}" already exists` });
            skipped++;
            continue;
          }

          // Get or create product by name
          let productId: string;
          if (productMap.has(name.toLowerCase())) {
            productId = productMap.get(name.toLowerCase())!.id;
          } else {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const prodInsert = await orgQuery(
              ORG_ID,
              `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, is_touch_favorite, created_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, false, NOW(), NOW())
               RETURNING id`,
              [ORG_ID, categoryId, name, slug, description || null, imageUrl || null, isActive]
            );
            productId = prodInsert.rows[0].id;
            productMap.set(name.toLowerCase(), { id: productId });
          }

          // Insert variant
          const variantName = [sizeLabel, colorLabel].filter(Boolean).join(' / ') || name;
          const varInsert = await orgQuery(
            ORG_ID,
            `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, cost, is_active, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
             RETURNING id`,
            [ORG_ID, productId, sku, barcode || null, variantName, sizeLabel || null, colorLabel || null, price, cost, isActive]
          );
          skuMap.set(sku, varInsert.rows[0].id);
          results.push({ row: rowNum, status: 'created', name });
          created++;
        } catch (rowErr) {
          results.push({ row: rowNum, status: 'skipped', name: String(row.name || '?'), message: String((rowErr as Error).message) });
          skipped++;
        }
      }

      return NextResponse.json({ created, skipped, total: rows.length, results });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Products PATCH error:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
