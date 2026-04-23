import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { NextResponse } from 'next/server';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { randomUUID } from '@/lib/uuid';
import { z } from 'zod';
import { validateBody } from '@/lib/validation/schemas';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { invalidateProductsCache, invalidateVariantsCache, invalidateInventoryCache as invalidateInvCachePg } from '@/lib/persistence/postgres-store';
import { invalidateInventoryCache } from '@/lib/cache/inventory-cache';

import { safeErr } from "@/lib/logging/safe-err";
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

  // Keep the scanned/entered code case-sensitive. Retail SKU systems that
  // use mixed case (ABC-123 vs abc-123) collapse incorrectly under LOWER()
  // and match the wrong variant. Trim whitespace only.
  const normalizedCode = code.trim()

  try {
    // Single query with LEFT JOIN to inventory — one DB round-trip instead of two.
    // R36-M4: explicit org filter on product_variants AND
    // inventory_levels. The prior shape only gated via p.organization_id,
    // relying on the FK `pv.product_id = p.id` to transitively scope.
    // No DB constraint enforces `pv.organization_id = p.organization_id`
    // though — a future bug that mis-orgs a variant row (or a malformed
    // import) would allow a cross-tenant lookup. Also add il.organization_id
    // in case the LEFT JOIN ever turns into an inner join after a refactor.
    const { rows } = await orgQuery(
      orgId,
      `SELECT pv.id as variant_id, pv.sku, pv.size_label, pv.color_label, pv.price,
              p.id as product_id, p.name as product_name, p.slug as product_slug, p.category_id,
              COALESCE(il.on_hand, 0) as on_hand
       FROM product_variants pv
       JOIN products p ON pv.product_id = p.id AND p.organization_id = $1
       LEFT JOIN inventory_levels il
         ON il.product_variant_id = pv.id
        AND il.location_id = $3
        AND il.organization_id = $1
       WHERE pv.organization_id = $1
         AND (pv.sku = $2 OR pv.barcode = $2)
       LIMIT 1`,
      [orgId, normalizedCode, locationId]
    )

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    const r = rows[0]

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
      inventory: { quantity: Number(r.on_hand) },
    })
  } catch (error) {
    console.error('[barcode-lookup] Error:', safeErr(error))
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
});

// R11-L-1 closed: POST /api/barcode-lookup.
//
// The admin "save scanned product" form (`src/components/admin/barcode-lookup.tsx`)
// was POSTing here but the route only exported GET. Every save returned
// 405. Adding an atomic create-product + create-variant + create-
// inventory_level path so the scan-to-SKU workflow actually persists.
//
// Atomic = single orgTx: all three inserts commit together, or none do.
// Without that, a partial save could leave an orphan product row with no
// variants, or a variant with no inventory row (which breaks the
// register's stock-lookup at checkout).
const barcodeSaveSchema = z.object({
  barcode: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  category_id: z.string().uuid(),
  sku: z.string().min(1).max(64),
  price: z.number().positive().max(1_000_000),
  cost: z.number().nonnegative().max(1_000_000).optional().nullable(),
  size_label: z.string().max(32).optional().nullable(),
  color_label: z.string().max(32).optional().nullable(),
  // R31-H4: image_url must be an `https:` URL to an image host.
  // Prior shape accepted any string — an admin submitting
  // `javascript:alert(document.cookie)` or `data:text/html,...` as
  // `image_url` planted a stored-XSS bomb. Any admin UI rendering
  // <img src={image_url}> is safe (src won't execute js: URLs), but
  // <a href={image_url}> WOULD execute js:, and any future SSR that
  // inlines the URL as an attribute value or script operand becomes
  // an instant XSS. Defense-in-depth: require https + reject
  // `javascript:` / `data:` / `file:` / `vbscript:` protocols.
  image_url: z.string()
    .max(2000)
    .refine(
      (s) => /^https:\/\//i.test(s),
      { message: "image_url must be an https URL" },
    )
    .refine(
      (s) => !/^(?:javascript|data|vbscript|file):/i.test(s),
      { message: "image_url must not use javascript/data/vbscript/file protocols" },
    )
    .optional()
    .nullable(),
  initial_stock: z.number().int().min(0).max(1_000_000).optional(),
  reorder_point: z.number().int().min(0).max(1_000_000).optional(),
});

// R28-L3: barcode-lookup POST creates products + variants — that's
// back-office catalog work, not a register terminal action. Switched
// from withDualAuth → withAdminAuth to prevent a register-scope manager
// PIN from reaching catalog creation. GET stays dual (cashier scans to
// look up existing products mid-sale).
export const POST = withAdminAuth("catalog.manage", async (request, ctx) => {
  const { orgId, employee, locationId } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  // R21-M-2: previously `barcode-save:${orgId}` with default (5 attempts
  // / 60s). One bulk-onboarding employee, or a buggy client retry loop,
  // locked out the entire org's scan-to-save flow. Scope to employee
  // AND widen to a workable bulk-onboarding quota (60 new products per
  // minute — enough to scan through a pallet, not enough to brute-force
  // anything meaningful, since this is a write path gated by
  // `catalog.manage` permission).
  const rl = checkRateLimit(`barcode-save:${orgId}:${employee.id}`, {
    maxAttempts: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  try {
    const body = await request.json();
    const v = validateBody(barcodeSaveSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const {
      barcode, name, description, category_id, sku, price,
      cost, size_label, color_label, image_url,
      initial_stock = 0, reorder_point = 5,
    } = v.data;

    // Verify category belongs to caller's org (FK-tenant check, same class
    // as R16 work).
    const catCheck = await orgQuery(
      orgId,
      `SELECT 1 FROM categories WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [category_id, orgId],
    );
    if (catCheck.rows.length === 0) {
      return NextResponse.json({ error: 'category_id does not exist in this organization' }, { status: 400 });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const productId = randomUUID();
    const variantId = randomUUID();
    const now = new Date().toISOString();

    const client = await orgTx(orgId);
    try {
      // Product
      try {
        await client.query(
          `INSERT INTO products (id, organization_id, category_id, name, slug, description, image_url, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)`,
          [productId, orgId, category_id, name, slug, description || null, image_url || null, now],
        );
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: `A product with slug "${slug}" already exists` }, { status: 409 });
        }
        throw e;
      }

      // Variant
      try {
        await client.query(
          `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, cost, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $11)`,
          [variantId, orgId, productId, sku, barcode, name, size_label || null, color_label || null, price, cost ?? 0, now],
        );
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: `A variant with SKU "${sku}" or barcode "${barcode}" already exists` }, { status: 409 });
        }
        throw e;
      }

      // Inventory level at caller's location
      await client.query(
        `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, received_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $6, $6)`,
        [orgId, variantId, locationId, initial_stock, reorder_point, now],
      );

      // R49: audit INSIDE the tx. barcode-lookup POST is the primary
      // scan-to-save catalog-onboarding path; the audit row for the
      // new product should land with the product creation, not in a
      // post-commit best-effort write.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product', $5, 'product_created', $6, now())`,
        [
          randomUUID(), orgId, locationId, employee.id, productId,
          JSON.stringify({
            via: 'barcode-lookup',
            sku,
            barcode: barcode.slice(0, 20),
            initial_stock,
          }),
        ],
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Invalidate caches (not in tx — cache misses on failure are fine).
    invalidateProductsCache(orgId);
    invalidateVariantsCache(orgId);
    invalidateInvCachePg(orgId);
    invalidateInventoryCache(orgId);

    return NextResponse.json({
      message: 'Product saved',
      product: { id: productId, name, slug },
      variant: { id: variantId, sku, barcode },
    }, { status: 201 });
  } catch (error) {
    console.error('[barcode-lookup POST] Error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to save product' },
      { status: 500 },
    );
  }
});
