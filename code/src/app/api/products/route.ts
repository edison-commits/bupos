/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * BuPOS Product Catalog API
 * @tags products
 */
import { orgQuery, orgTx, getPool } from '@/lib/supabase-rest';
import { NextResponse } from 'next/server';
import { invalidateProductsCache, invalidateVariantsCache } from '@/lib/persistence/postgres-store';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { randomUUID } from '@/lib/uuid';
import { validateBody, productCreateSchema, productUpdateSchema, productDeleteSchema, productImportSchema } from '@/lib/validation/schemas';
import { checkRateLimit } from '@/lib/auth/rate-limit';

import { safeErr } from "@/lib/logging/safe-err";
// R14-L-2: the route-level 30s in-memory response cache was removed.
// Cross-route mutations (inventory adjust, transfer receive, PO receive,
// bundle admin actions) never invalidated it, so admin UIs saw stale
// data for up to 30s after legitimate writes. The cross-org cardinality
// (N orgs × M query strings) also churned past MAX_CACHE_SIZE=50 so the
// cache mostly thrashed anyway. The underlying store has its own
// per-org TTL cache (postgres-store.ts invalidateProductsCache) that IS
// correctly invalidated by every mutating path.

export const GET = withDualAuth("catalog.manage", async (request, ctx) => {
  const { orgId, locationId } = ctx;

  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search')?.toLowerCase() || '';
    const category = searchParams.get('category') || '';
    const active = searchParams.get('active');

    // R26-F1: explicit organization_id filter. The `postgres` role has
    // BYPASSRLS in prod, so the RLS policy on products DOES NOT fire.
    // Without this filter the GET /api/products handler leaks every
    // product across every org. Same applies to the summary + CSV
    // paths below — they all MUST include `p.organization_id = $` (or
    // equivalent) in the WHERE clause, NEVER rely on RLS.
    //
    // R30-C3: split extra-filters (`extra`) from the static org + loc
    // predicates. Prior shape prepended locationId to `[orgId, …]` at
    // call-site, clashing with `p.organization_id = $1` — the `$1` slot
    // at runtime actually bound locationId (since it was prepended),
    // so the org filter failed to match any row and products GET
    // silently returned empty. Pin slot-ordering explicitly: $1 = orgId,
    // $2 = locationId, $3+ = extras.
    const extra: string[] = [];
    // locationId may be null for admin contexts without a location
    // attached; cast to string for the slot (LEFT JOIN with
    // `i.location_id = $2` then never matches — OK, stock returns 0).
    const params: (string | boolean)[] = [orgId, (locationId ?? "") as string];

    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      extra.push(
        `(LOWER(p.name) ILIKE $${params.length + 1} OR LOWER(pv.sku) ILIKE $${params.length + 1})`
      );
      params.push(`%${escaped}%`);
    }

    if (category) {
      extra.push(`p.category_id = $${params.length + 1}`);
      params.push(category);
    }

    if (active !== null) {
      extra.push(`p.is_active = $${params.length + 1}`);
      params.push(active === 'true');
    }

    const andClause = extra.length > 0 ? ` AND ${extra.join(' AND ')}` : '';

    // Run all 3 queries on ONE shared Neon client. Parallel orgQuery ×3 was
    // opening 3 concurrent one-shot pools per request; serialising on a
    // single orgTx client cuts the handshake count to 1 without materially
    // increasing wall time (the metadata queries are fast).
    // R30-M2: defense-in-depth org filters on every LEFT JOIN — categories,
    // suppliers, product_variants. A cross-tenant category/supplier/variant
    // FK (shouldn't exist given p.organization_id gate, but cheap insurance)
    // can't splice foreign rows into this tenant's list.
    const client = await orgTx(orgId);
    let productsResult, categoriesResult, summaryResult;
    try {
      productsResult = await client.query(
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
          p.updated_at as product_updated_at,
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
          pv.updated_at as variant_updated_at,
          COALESCE(i.on_hand, 0) as stock
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id AND c.organization_id = $1
        LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.organization_id = $1
        LEFT JOIN product_variants pv ON p.id = pv.product_id AND pv.organization_id = $1
        LEFT JOIN inventory_levels i ON pv.id = i.product_variant_id AND i.location_id = $2 AND i.organization_id = $1
        WHERE p.organization_id = $1${andClause}
        ORDER BY p.name, pv.sku
        `,
        params
      );

      // R26-F1: explicit org filters on the metadata queries too.
      categoriesResult = await client.query(
        `SELECT id, name, slug FROM categories WHERE organization_id = $1 ORDER BY name`,
        [orgId]
      );

      summaryResult = await client.query(
        `
        SELECT
          COUNT(DISTINCT p.id) as total_products,
          COUNT(DISTINCT CASE WHEN p.is_active THEN p.id END) as active_products,
          COUNT(DISTINCT pv.id) as total_variants,
          COUNT(DISTINCT c.id) as categories_count
        FROM products p
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.organization_id = $1
        `,
        [orgId]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Transform raw rows into product hierarchy
    const productsMap = new Map();
    const priceRanges = new Map();

    productsResult.rows.forEach((row: Record<string, unknown>) => {
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
          updatedAt: row.product_updated_at,
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
          price: parseFloat(row.price as string),
          compare_at_price: row.compare_at_price ? parseFloat(row.compare_at_price as string) : null,
          cost: parseFloat(row.cost as string),
          is_active: row.variant_is_active as boolean,
          stock: row.stock as number,
          updatedAt: row.variant_updated_at as string,
        });
        priceRanges.get(row.id as string)!.push(parseFloat(row.price as string));
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
        total_stock: product.variants.reduce((sum: number, v: { stock: number }) => sum + v.stock, 0),
      };
    });

    const categories = categoriesResult.rows;
    const summary = summaryResult.rows[0];

    const response = {
      products,
      categories,
      summary,
    };
    const resp = NextResponse.json(response);
    resp.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return resp;
  } catch (error) {
    console.error('Products GET error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
});

// R27-H2: products mutations are admin-only. A manager-PIN register
// session should NOT be able to create / update / delete the catalog
// — those flows belong in the admin panel only. GET stays withDualAuth
// since the register terminal legitimately renders the catalog.
export const POST = withAdminAuth("catalog.manage", async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`products:post:${orgId}:${employee.id}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const body = await request.json();

    // Set RLS context
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

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
      const { sku, barcode, name, size_label, color_label, price: rawPrice, compare_at_price, cost: rawCost } = body.variant;
      if (!sku) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'SKU is required for variants' }, { status: 400 });
      }
      // R58-1 / R60-B2: coerce via Number() + Number.isFinite, but
      // first REJECT non-numeric types. Prior R58-1 accepted
      // `Number(null)=0`, `Number([])=0`, `Number("")=0`,
      // `Number(false)=0` which all pass Number.isFinite — so a
      // request like `{"price":null}` would silently reprice to $0
      // rather than being a no-op. Acceptable inputs are `number`
      // and `string` (the original string-coercion use case);
      // everything else becomes a 400.
      const isAcceptablePriceInput = (v: unknown): v is number | string | undefined =>
        v === undefined || typeof v === 'number' || typeof v === 'string';
      if (!isAcceptablePriceInput(rawPrice)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Price must be a number' }, { status: 400 });
      }
      if (!isAcceptablePriceInput(rawCost)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Cost must be a number' }, { status: 400 });
      }
      if (!isAcceptablePriceInput(compare_at_price)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'compare_at_price must be a number' }, { status: 400 });
      }
      const priceNum = rawPrice !== undefined ? Number(rawPrice) : undefined;
      const costNum = rawCost !== undefined ? Number(rawCost) : undefined;
      if (priceNum !== undefined && (!Number.isFinite(priceNum) || priceNum < 0)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Price must be a non-negative number' }, { status: 400 });
      }
      if (costNum !== undefined && (!Number.isFinite(costNum) || costNum < 0)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Cost must be a non-negative number' }, { status: 400 });
      }
      // R56-A2: variant creation carries a `price` (and optional
      // `cost`) — same fraud-relevant surface as a reprice.
      const { hasPermission } = await import("@/lib/domain/permissions");
      if (!hasPermission(employee.roleKey, "pricing.manage")) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Variant creation requires pricing.manage (owner / manager) because it sets a price.' },
          { status: 403 },
        );
      }
      // R58-5 (was R56-A2): unconditional step-up on variant-create.
      // Prior shape skipped step-up when `price === 0` — a stolen
      // cookie could still mint $0 variants (accounting noise /
      // shoplifting-cover via zero-dollar rings at checkout). Variant
      // create is low-frequency (setup / catalog expansion) so
      // always-gating is acceptable UX.
      {
        const { requireStepUp } = await import('@/lib/auth/step-up');
        const stepUp = await requireStepUp({
          actorId: employee.id,
          orgId,
          actorPassword: (body as { actorPassword?: string })?.actorPassword,
          bucketKey: 'variant-price-stepup',
        });
        if (!stepUp.ok) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
        }
      }
      // Verify the parent product belongs to THIS org. Without this, an
      // attacker with catalog.manage on org X who knows (or guesses) a
      // product UUID from org Y could attach a variant to that foreign
      // product — the variant's own organization_id stays X, but the FK
      // dangles a pointer into org Y's catalog, silently polluting any
      // report that joins product_variants → products.
      //
      // R62-M3: also reject when the parent product is
      // soft-deleted. A "deleted" product should accept no further
      // mutations; otherwise you can re-populate the catalog via
      // variant-create after deletion, which bypasses the intent of
      // R58-2's soft-delete model. The new variant would be
      // is_active=true by default and reachable from any code path
      // that trusts variant.is_active alone.
      const parentCheck = await client.query(
        `SELECT is_active FROM products WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [body.product_id, orgId],
      );
      if (parentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'product_id does not exist in this organization' }, { status: 400 });
      }
      if (parentCheck.rows[0].is_active === false) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Cannot add a variant to a deleted product. Reactivate the product first.' },
          { status: 400 },
        );
      }
      // Reject duplicate SKU within this org
      const dupCheck = await client.query(
        `SELECT id FROM product_variants WHERE organization_id = $1 AND LOWER(sku) = LOWER($2) LIMIT 1`,
        [orgId, sku],
      );
      if (dupCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: `SKU "${sku}" already exists` }, { status: 409 });
      }
      // R58-1 / R60-B1: bind the coerced numeric values. Also
      // validate compare_at_price the same way — the column has no
      // CHECK constraint (unlike product_bundles.compare_at_price)
      // so a negative value would persist. Not a fraud-relevant
      // surface but the resulting "was" strikethrough would be
      // deceptive.
      const compareAtPriceNum = compare_at_price !== undefined ? Number(compare_at_price) : undefined;
      if (compareAtPriceNum !== undefined && (!Number.isFinite(compareAtPriceNum) || compareAtPriceNum < 0)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'compare_at_price must be a non-negative number' }, { status: 400 });
      }
      const result = await client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW(), NOW())
         RETURNING id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active`,
        [orgId, body.product_id, sku, barcode, name, size_label, color_label, priceNum, compareAtPriceNum, costNum]
      );
      // R56-A2: audit the variant creation — prior shape had no
      // audit row, making the variant unattributable post-creation.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product_variant', $5, 'variant_created', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, result.rows[0].id,
          JSON.stringify({
            id: result.rows[0].id,
            sku: result.rows[0].sku,
            price: result.rows[0].price,
            cost: result.rows[0].cost,
            product_id: body.product_id,
          }),
        ],
      );
      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json(result.rows[0], { status: 201 });
    }

    // Handle product creation
    const pv = validateBody(productCreateSchema, body);
    if (!pv.success) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: pv.error }, { status: 400 });
    }
    const { name, slug, category_id, description, image_url, is_active = true } = body;
    const is_touch_favorite = body.is_touch_favorite ?? false;
    const result = await client.query(
      `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, is_touch_favorite, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id, name, slug, category_id, description, image_url, is_active, is_touch_favorite`,
      [orgId, category_id || null, name, slug, description || null, image_url || null, is_active, is_touch_favorite]
    );
    const newProduct = result.rows[0];
    // R49: audit INSIDE the tx. Prior shape committed then called
    // pgInsertAuditEvent via waitUntilOrAwait — on failure the product
    // existed with no audit row. Catalog mutations are the foundation
    // of pricing-evidence chain; audit drop is unacceptable.
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES ($1, $2, $3, $4, 'product', $5, 'product_created', $6, now())`,
      [
        randomUUID(), orgId, null, employee.id, newProduct.id,
        JSON.stringify({ id: newProduct.id, name: newProduct.name, slug: newProduct.slug }),
      ],
    );
    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    return NextResponse.json(newProduct, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products POST error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to create product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
});

// R27-H2: admin-only (see POST above).
export const PUT = withAdminAuth("catalog.manage", async (request, ctx) => {
  const { orgId, employee } = ctx;
  // R62-L1: per-actor bucket at 60/60s — matches the barcode-save
  // precedent. Prior shape inherited PIN-brute-force defaults
  // (3 attempts / 5 min) which 429'd routine admin catalog CRUD.
  const rl = checkRateLimit(`products:put:${orgId}:${employee.id}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const body = await request.json();
    const pv = validateBody(productUpdateSchema, body);
    if (!pv.success) return NextResponse.json({ error: pv.error }, { status: 400 });
    const id = pv.data.product_id;
    const updates = body;

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

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

      // R26-F1: explicit organization_id filter. Without it, a PATCH
      // with any product id from another org succeeds (postgres role
      // bypasses RLS).
      // R30-C3: the `organization_id = $N` predicate is STATIC in the
      // SQL below so the guardrail sees it regardless of the dynamic
      // `${extraWhere}` used for optimistic-locking. Prior shape buried
      // the org filter inside the dynamic whereClause and the guardrail
      // couldn't see it.
      // Optimistic locking: check updated_at if expectedUpdatedAt is provided
      const whereValues: unknown[] = [...values, id, orgId];
      const idSlot = paramIndex;
      const orgSlot = paramIndex + 1;
      paramIndex += 2;
      let extraWhere = '';
      if (updates.expectedUpdatedAt) {
        extraWhere = ` AND updated_at = $${paramIndex}`;
        whereValues.push(updates.expectedUpdatedAt);
        paramIndex++;
      }

      const result = await client.query(
        `UPDATE products SET ${fields.join(', ')} WHERE id = $${idSlot} AND organization_id = $${orgSlot}${extraWhere} RETURNING id, name, slug, category_id, description, image_url, is_active, is_touch_favorite, updated_at`,
        whereValues
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Product was modified by another user. Please refresh and try again.' },
          { status: 409 }
        );
      }

      const updatedProduct = result.rows[0];
      // R49: audit INSIDE the tx.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product', $5, 'product_updated', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, id,
          JSON.stringify({ id, name: updatedProduct.name, slug: updatedProduct.slug }),
        ],
      );
      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      return NextResponse.json(updatedProduct);
    }

    // Handle variant update
    if (updates.variant_id && (updates.price !== undefined || updates.cost !== undefined)) {
      // R33-H4: re-gate price/cost mutations on `pricing.manage`.
      // The route-level gate is `catalog.manage` so inventory_clerk
      // (who needs catalog CRUD) can POST/PUT product shape. But
      // `pricing.manage` is separately assigned to owner/manager only
      // — an inventory_clerk should NOT be able to reprice a variant
      // to $0.01 and self-check-out. Check at the price/cost branch
      // rather than at the route level so the non-pricing shape-edit
      // branches still work for clerks.
      const { hasPermission } = await import("@/lib/domain/permissions");
      if (!hasPermission(employee.roleKey, "pricing.manage")) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Pricing changes require pricing.manage permission (owner / manager).' },
          { status: 403 },
        );
      }
      // R58-1 / R60-B2: coerce via Number() + Number.isFinite after
      // rejecting non-numeric types. Prior R58-1 accepted
      // `Number(null)=0`, `Number([])=0` etc — a `{"price":null}`
      // PUT would silently reprice to $0 instead of being a no-op.
      // Reject anything that isn't number/string.
      const isAcceptableUpdate = (v: unknown): v is number | string | undefined =>
        v === undefined || typeof v === 'number' || typeof v === 'string';
      if (!isAcceptableUpdate(updates.price)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Price must be a number' }, { status: 400 });
      }
      if (!isAcceptableUpdate(updates.cost)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Cost must be a number' }, { status: 400 });
      }
      const priceNum = updates.price !== undefined ? Number(updates.price) : undefined;
      const costNum = updates.cost !== undefined ? Number(updates.cost) : undefined;
      if (priceNum !== undefined && (!Number.isFinite(priceNum) || priceNum < 0)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Price must be a non-negative number' }, { status: 400 });
      }
      if (costNum !== undefined && (!Number.isFinite(costNum) || costNum < 0)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Cost must be a non-negative number' }, { status: 400 });
      }
      // R52-A: step-up re-auth on variant reprice. Snapshot-compare
      // against the SELECT … FOR UPDATE prior row; the lock closes
      // the TOCTOU race where two rapid PUTs would each see the
      // pre-existing value.
      const { rows: priorRows } = await client.query(
        `SELECT price, cost FROM product_variants WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [updates.variant_id, orgId],
      );
      if (priorRows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
      }
      const prior = priorRows[0] as { price: string; cost: string | null };
      const priorPrice = Number(prior.price);
      const priorCost = prior.cost != null ? Number(prior.cost) : null;
      const newPrice = priceNum !== undefined ? priceNum : priorPrice;
      const newCost = costNum !== undefined ? costNum : priorCost;
      const priceChanged = priceNum !== undefined && Math.abs(priorPrice - newPrice) > 0.005;
      const costChanged =
        costNum !== undefined &&
        priorCost !== null &&
        newCost !== null &&
        Math.abs(priorCost - newCost) > 0.005;
      if (priceChanged || costChanged) {
        const { requireStepUp } = await import('@/lib/auth/step-up');
        const stepUp = await requireStepUp({
          actorId: employee.id,
          orgId,
          actorPassword: (body as { actorPassword?: string })?.actorPassword,
          bucketKey: 'variant-price-stepup',
        });
        if (!stepUp.ok) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
        }
      }
      const fields = [];
      const values = [];
      let paramIndex = 1;

      // R58-1: bind the coerced numeric values (not raw
      // updates.price / updates.cost which could still be strings).
      if (priceNum !== undefined) {
        fields.push(`price = $${paramIndex}`);
        values.push(priceNum);
        paramIndex++;
      }
      if (costNum !== undefined) {
        fields.push(`cost = $${paramIndex}`);
        values.push(costNum);
        paramIndex++;
      }

      fields.push('updated_at = NOW()');

      // R26-F1: explicit org filter on variant update.
      // R30-C3: static org predicate + static id predicate — see
      // parallel fix in the `products` UPDATE above.
      // Optimistic locking: check updated_at if expectedUpdatedAt is provided
      const whereValues: unknown[] = [...values, updates.variant_id, orgId];
      const idSlot = paramIndex;
      const orgSlot = paramIndex + 1;
      paramIndex += 2;
      let extraWhere = '';
      if (updates.expectedUpdatedAt) {
        extraWhere = ` AND updated_at = $${paramIndex}`;
        whereValues.push(updates.expectedUpdatedAt);
        paramIndex++;
      }

      const result = await client.query(
        `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${idSlot} AND organization_id = $${orgSlot}${extraWhere} RETURNING id, sku, price, cost, updated_at`,
        whereValues
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Product was modified by another user. Please refresh and try again.' },
          { status: 409 }
        );
      }

      const updatedVariant = result.rows[0];
      // R49: audit INSIDE the tx. variant_updated includes price + cost
      // mutations (pricing.manage gate above); audit must land with the
      // price change to support fraud-investigation price drift.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product_variant', $5, 'variant_updated', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, updates.variant_id,
          JSON.stringify({ id: updates.variant_id, sku: updatedVariant.sku }),
        ],
      );
      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json(updatedVariant);
    }

    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    return NextResponse.json({ message: 'No updates made' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products PUT error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to update product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
});

// R27-H2: admin-only (see POST above).
export const DELETE = withAdminAuth("catalog.manage", async (request, ctx) => {
  const { orgId, employee } = ctx;
  // R60-B3 / R62-L1: per-actor bucket at 60/60s. Prior R60-B3
  // shape inherited PIN-brute-force defaults (3/5min) which 429'd
  // routine catalog cleanup (e.g. deleting 4 discontinued SKUs).
  // Per-actor key so one admin's activity doesn't throttle peers.
  const rl = checkRateLimit(`products:del:${orgId}:${employee.id}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const body = await request.json();
    const dv = validateBody(productDeleteSchema, body);
    if (!dv.success) return NextResponse.json({ error: dv.error }, { status: 400 });
    const { product_id: id } = dv.data;

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

    // R26-F1: explicit org filter on soft-delete.
    // Soft delete: set is_active to false
    const result = await client.query(
      `UPDATE products SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 RETURNING id, name`,
      [id, orgId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // R60-A3: cascade soft-delete to variants in the SAME tx, so
    // direct variant lookups (barcode scan, checkout variant-lookup,
    // offline-sync) can't still ring up a "deleted" product. Mirrors
    // the hard-delete semantics the prior shape relied on via FK
    // CASCADE.
    const variantRes = await client.query(
      `UPDATE product_variants SET is_active = false, updated_at = NOW()
       WHERE product_id = $1 AND organization_id = $2`,
      [id, orgId]
    );

    // R56-A3: audit INSIDE the tx. The REST DELETE was the lossier
    // surface — the parallel Server Action `deleteProductAction`
    // already audits (admin/actions.ts). A stolen catalog.manage
    // cookie could `fetch('/api/products', {method:'DELETE'})` to
    // soft-delete any product with no attribution. Mirror the
    // Server Action by emitting `product_deleted` inside the tx.
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES ($1, $2, $3, $4, 'product', $5, 'product_deleted', $6, now())`,
      [
        randomUUID(), orgId, null, ctx.employee.id, result.rows[0].id,
        JSON.stringify({
          id: result.rows[0].id,
          name: result.rows[0].name,
          soft_delete: true,
          variants_deactivated: variantRes.rowCount ?? 0,
        }),
      ],
    );

    await client.query('COMMIT');
    invalidateProductsCache(orgId);
    invalidateVariantsCache(orgId);
    return NextResponse.json({ message: 'Product deleted', id: result.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products DELETE error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to delete product' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
});

// R27-H2: admin-only (see POST above).
export const PATCH = withAdminAuth("catalog.manage", async (request, ctx) => {
  const { orgId, employee } = ctx;
  // R60-B3 / R62-L1: per-actor bucket at 60/60s (PATCH is
  // CSV-import-heavy; the per-org-shared default would throttle
  // bulk onboarding). CSV-import itself still step-up-gates which
  // limits aggregate minting attempts.
  const rl = checkRateLimit(`products:patch:${orgId}:${employee.id}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'import_csv') {
      // R54-M3: step-up re-auth on CSV bulk-import. The import
      // handler creates variants with arbitrary price + cost fields
      // from the CSV. Single-variant reprice (R52-A) is gated with
      // bucketKey:'variant-price-stepup'; the bulk path was a bypass
      // — attacker with stolen cookie could mint N $0.01 variants
      // for self-checkout. Share the same bucket so the aggregate-
      // per-actor cap covers both surfaces. CSV imports are low-
      // frequency (setup / batch onboarding) so unconditional gating
      // is acceptable UX.
      //
      // R56-A1: ALSO require `pricing.manage` — every imported row
      // carries a price. The route-level gate is `catalog.manage`
      // so an inventory_clerk (has CSV import access via the
      // catalog permission) could otherwise bulk-mint variants at
      // $0.01. The single-variant PUT path (line 470) gates
      // pricing.manage; CSV was asymmetric.
      const { hasPermission } = await import("@/lib/domain/permissions");
      if (!hasPermission(employee.roleKey, "pricing.manage")) {
        return NextResponse.json(
          { error: 'CSV import requires pricing.manage (owner / manager) since each row sets a price.' },
          { status: 403 },
        );
      }

      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword: (body as { actorPassword?: string })?.actorPassword,
        bucketKey: 'variant-price-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }

      const iv = validateBody(productImportSchema, { action: 'import', rows: body.rows });
      if (!iv.success) return NextResponse.json({ error: iv.error }, { status: 400 });
      const rows = iv.data.rows as Record<string, string | number>[];

      const results: { row: number; status: 'created' | 'updated' | 'skipped'; name: string; message?: string }[] = [];
      let created = 0;
      let skipped = 0;

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

      // Build lookup maps
      const catsResult = await client.query(
        `SELECT id, name FROM categories WHERE organization_id = $1`,
        [orgId]
      );
      const catMap = new Map(catsResult.rows.map((r: Record<string, string>) => [r.name.toLowerCase(), r.id]));

      const existingResult = await client.query(
        `SELECT id, name, category_id FROM products WHERE organization_id = $1`,
        [orgId]
      );
      const productsByName = new Map(existingResult.rows.map((r: Record<string, string>) => [r.name.toLowerCase(), { id: r.id, categoryId: r.category_id }]));

      const variantResult = await client.query(
        `SELECT id, sku FROM product_variants WHERE organization_id = $1 AND sku IS NOT NULL AND sku != ''`,
        [orgId]
      );
      const skuMap = new Map(variantResult.rows.map((r: Record<string, string>) => [r.sku.toLowerCase(), r.id]));

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
        const price = parseFloat(String(row.price || row.Price || row.PRICE || '0'));
        const categoryName = String(row.category || row.Category || row.CATEGORY_NAME || '').trim().toLowerCase();
        const sizeLabel = String(row.size || row.Size || row.SIZE_LABEL || '').trim();
        const colorLabel = String(row.color || row.Color || row.COLOR_LABEL || '').trim();
        const cost = parseFloat(String(row.cost || row.Cost || row.COST || '0')) || 0;
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
            productsByName.set(key, { id: r.id as string, categoryId: (r.category_id as string) ?? null });
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

      // R56-A1: audit INSIDE the orgTx. Bulk CSV import lands N
      // categories/products/variants with per-row prices — the exact
      // fraud-relevant anchor a post-incident investigation needs to
      // answer "who imported these zero-price SKUs, and when." Single
      // catalog_import event summarizes the batch (actor + counts)
      // rather than one row per SKU so audit_events doesn't explode
      // on a 10k-row import.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product_catalog', $5, 'catalog_import', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, orgId,
          JSON.stringify({
            total: rows.length,
            created,
            skipped,
            variants_inserted: variantsToInsert.length,
            products_inserted: newProducts.length,
            categories_inserted: newCategories.length,
          }),
        ],
      );

      await client.query('COMMIT');
      invalidateProductsCache(orgId);
      invalidateVariantsCache(orgId);
      return NextResponse.json({ created, skipped, total: rows.length, results });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Products PATCH error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  } finally {
    client.release();
  }
});
