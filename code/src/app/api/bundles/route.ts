/**
 * BuPOS Product Bundles API
 *
 * Bundles are named groups of variants sold at a package price. The price on
 * the `product_bundles` row is authoritative — we never recompute from item
 * prices at checkout.
 *
 * Permissions: `catalog.manage` for both read and write (admin only; the
 * register side doesn't need write access).
 *
 * @tags bundles
 */
import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { randomUUID } from "@/lib/uuid";
import {
  validateBody,
  bundleCreateSchema,
  bundleUpdateSchema,
  bundleDeleteSchema,
} from "@/lib/validation/schemas";
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";

import { safeErr } from "@/lib/logging/safe-err";
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "bundle";
}

interface BundleRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  bundle_price: string;
  compare_at_price: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface BundleItemRow {
  id: string;
  bundle_id: string;
  product_variant_id: string;
  quantity: number;
  organization_id: string;
  created_at: string;
}

/** Shape bundle rows + their items into the ProductBundle domain type. */
function shapeBundles(bundles: BundleRow[], items: BundleItemRow[]) {
  const itemsByBundle = new Map<string, BundleItemRow[]>();
  for (const it of items) {
    const arr = itemsByBundle.get(it.bundle_id) ?? [];
    arr.push(it);
    itemsByBundle.set(it.bundle_id, arr);
  }
  return bundles.map((b) => ({
    id: b.id,
    organizationId: b.organization_id,
    name: b.name,
    slug: b.slug,
    description: b.description ?? undefined,
    imageUrl: b.image_url ?? undefined,
    bundlePrice: Number(b.bundle_price),
    compareAtPrice: b.compare_at_price != null ? Number(b.compare_at_price) : undefined,
    isActive: b.is_active,
    createdAt: String(b.created_at),
    updatedAt: String(b.updated_at),
    items: (itemsByBundle.get(b.id) ?? []).map((it) => ({
      id: it.id,
      bundleId: it.bundle_id,
      productVariantId: it.product_variant_id,
      quantity: it.quantity,
    })),
  }));
}

/** GET /api/bundles — list all bundles (with their items) for the org. */
export const GET = withDualAuth("catalog.manage", async (_req, ctx) => {
  const { orgId } = ctx;
  try {
    // Two SELECTs are cheaper here than a LEFT JOIN: the join would multiply
    // bundle rows by items count and we'd have to re-collapse client-side.
    //
    // R28-C2: explicit `organization_id = $1` PREDICATES (not just column-
    // list mentions). The prior version listed `organization_id` as a
    // returned column and relied on `orgQuery`'s `SET LOCAL app.current_
    // org_id`, which is cosmetic under the BYPASSRLS `postgres` role.
    // Every owner/manager with catalog.manage at any tenant paginated
    // every other tenant's bundles until this fix. The R27-C12 sweep
    // covered POST/PUT/PATCH/DELETE in this file but MISSED the GET;
    // the R28-H1 guardrail tightening now prevents this regression.
    const [bundlesRes, itemsRes] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT id, organization_id, name, slug, description, image_url,
                bundle_price, compare_at_price, is_active, created_at, updated_at
         FROM product_bundles
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [orgId],
      ),
      orgQuery(
        orgId,
        `SELECT bi.id, bi.bundle_id, bi.product_variant_id, bi.quantity,
                bi.organization_id, bi.created_at
         FROM bundle_items bi
         JOIN product_bundles pb ON pb.id = bi.bundle_id
         WHERE pb.organization_id = $1
         ORDER BY bi.created_at ASC`,
        [orgId],
      ),
    ]);

    return NextResponse.json({
      bundles: shapeBundles(bundlesRes.rows as BundleRow[], itemsRes.rows as BundleItemRow[]),
    });
  } catch (err) {
    console.error("GET /api/bundles error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch bundles" }, { status: 500 });
  }
});

/** POST /api/bundles — create a bundle with its items in one transaction. */
export const POST = withAdminAuth("pricing.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(bundleCreateSchema, body);
    if (!v.success) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }
    const { name, slug: rawSlug, description, imageUrl, bundlePrice, compareAtPrice, isActive, items } = v.data;

    // compare_at_price must be >= bundle_price to be a meaningful "compare".
    // Reject the inverse rather than silently clipping; lets the UI surface
    // the mistake.
    if (compareAtPrice !== undefined && compareAtPrice < bundlePrice) {
      return NextResponse.json(
        { error: "compareAtPrice must be greater than or equal to bundlePrice" },
        { status: 400 },
      );
    }

    const slug = rawSlug ? slugify(rawSlug) : slugify(name);

    const client = await orgTx(orgId);
    try {
      // Verify every variant belongs to THIS org. RLS would block cross-org
      // reads anyway, but an explicit length check produces a clean 400.
      const variantIds = items.map((i) => i.productVariantId);
      // R27-C12: explicit organization_id filter. Without it, a foreign
      // tenant's variant_id passed the existence check and landed in
      // this tenant's bundle_items — cross-tenant FK splice.
      const { rows: variantRows } = await client.query(
        `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [variantIds, orgId],
      );
      if (variantRows.length !== new Set(variantIds).size) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "One or more variants do not exist in this organization" },
          { status: 400 },
        );
      }

      const bundleId = randomUUID();
      let bundleRow: BundleRow;
      try {
        const { rows } = await client.query<BundleRow>(
          `INSERT INTO product_bundles
             (id, organization_id, name, slug, description, image_url, bundle_price, compare_at_price, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, organization_id, name, slug, description, image_url, bundle_price, compare_at_price, is_active, created_at, updated_at`,
          [
            bundleId,
            orgId,
            name,
            slug,
            description ?? null,
            imageUrl ?? null,
            bundlePrice,
            compareAtPrice ?? null,
            isActive ?? true,
          ],
        );
        bundleRow = rows[0];
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === "23505") {
          // unique_violation on (organization_id, slug)
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: `A bundle with slug "${slug}" already exists` },
            { status: 409 },
          );
        }
        throw e;
      }

      // Batch-insert all items via unnest so a bundle with N items still
      // takes one round-trip.
      const itemIds = items.map(() => randomUUID());
      const itemVariantIds = items.map((i) => i.productVariantId);
      const itemQuantities = items.map((i) => i.quantity);
      const { rows: itemRows } = await client.query<BundleItemRow>(
        `INSERT INTO bundle_items (id, bundle_id, product_variant_id, quantity, organization_id)
         SELECT unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::int[]), $5
         RETURNING id, bundle_id, product_variant_id, quantity, organization_id, created_at`,
        [itemIds, bundleId, itemVariantIds, itemQuantities, orgId],
      );

      // R49: audit INSIDE the tx. Prior shape committed then called
      // pgInsertAuditEvent with a swallow-all catch — on failure the
      // bundle existed with no audit row for the initial price, which
      // is the anchor later "who dropped the price?" investigations
      // depend on.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'bundle', $5, 'bundle_created', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, bundleId,
          JSON.stringify({
            name,
            slug,
            bundle_price: bundlePrice.toFixed(2),
            compare_at_price: compareAtPrice?.toFixed(2) ?? null,
            item_count: items.length,
          }),
        ],
      );

      await client.query("COMMIT");

      invalidateStoreCache(orgId);
      return NextResponse.json(
        { bundle: shapeBundles([bundleRow], itemRows)[0] },
        { status: 201 },
      );
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("POST /api/bundles error:", safeErr(err));
    return NextResponse.json({ error: "Failed to create bundle" }, { status: 500 });
  }
});

/** PATCH /api/bundles — update bundle metadata (name, price, active flag). */
export const PATCH = withAdminAuth("pricing.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(bundleUpdateSchema, body);
    if (!v.success) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }
    const { id, name, description, imageUrl, bundlePrice, compareAtPrice, isActive, items } = v.data;

    if (compareAtPrice !== undefined && bundlePrice !== undefined && compareAtPrice < bundlePrice) {
      return NextResponse.json(
        { error: "compareAtPrice must be greater than or equal to bundlePrice" },
        { status: 400 },
      );
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (name !== undefined)           { sets.push(`name = $${idx++}`);             vals.push(name); }
    if (description !== undefined)    { sets.push(`description = $${idx++}`);      vals.push(description); }
    if (imageUrl !== undefined)       { sets.push(`image_url = $${idx++}`);        vals.push(imageUrl); }
    if (bundlePrice !== undefined)    { sets.push(`bundle_price = $${idx++}`);     vals.push(bundlePrice); }
    if (compareAtPrice !== undefined) { sets.push(`compare_at_price = $${idx++}`); vals.push(compareAtPrice); }
    if (isActive !== undefined)       { sets.push(`is_active = $${idx++}`);        vals.push(isActive); }

    // If caller didn't specify ANY bundle field AND didn't specify items,
    // there's nothing to do.
    if (sets.length === 0 && !items) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // Run metadata UPDATE + optional items replace inside ONE transaction
    // so a partial failure (bad variant id) doesn't leave a priced bundle
    // with stale components.
    const client = await orgTx(orgId);
    let bundleRow: BundleRow | undefined;
    try {
      // R27-C12: explicit organization_id filter. Without it, PATCH
      // could rewrite any tenant's bundle price/name/slug to whatever
      // the attacker wanted.
      if (sets.length > 0) {
        vals.push(id);
        vals.push(orgId);
        const { rows } = await client.query<BundleRow>(
          `UPDATE product_bundles SET ${sets.join(", ")}
           WHERE id = $${idx} AND organization_id = $${idx + 1}
           RETURNING id, organization_id, name, slug, description, image_url,
                     bundle_price, compare_at_price, is_active, created_at, updated_at`,
          vals,
        );
        if (rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Bundle not found" }, { status: 404 });
        }
        bundleRow = rows[0];
      } else {
        // No metadata changes — still need to confirm the bundle exists
        // before touching bundle_items. R27-C12: org gate here too.
        const { rows } = await client.query<BundleRow>(
          `SELECT id, organization_id, name, slug, description, image_url,
                  bundle_price, compare_at_price, is_active, created_at, updated_at
           FROM product_bundles WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [id, orgId],
        );
        if (rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Bundle not found" }, { status: 404 });
        }
        bundleRow = rows[0];
      }

      // Full items replace. Delete existing rows, then bulk-insert the new
      // ones. Verify variant ids first (same check as POST).
      if (items) {
        const newVariantIds = items.map((i) => i.productVariantId);
        // R27-C12: explicit organization_id filter (PATCH path, same
        // defense as POST).
        const { rows: variantRows } = await client.query(
          `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [newVariantIds, orgId],
        );
        if (variantRows.length !== new Set(newVariantIds).size) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: "One or more variants do not exist in this organization" },
            { status: 400 },
          );
        }
        // R27-C12: JOIN to product_bundles so bundle_id can't be
        // a foreign tenant's. The bundle itself was already org-gated
        // in the SELECT/UPDATE above, but belt-and-suspenders.
        await client.query(
          `DELETE FROM bundle_items USING product_bundles pb
            WHERE bundle_items.bundle_id = pb.id
              AND pb.id = $1
              AND pb.organization_id = $2`,
          [id, orgId],
        );
        const itemIds = items.map(() => randomUUID());
        const qtys = items.map((i) => i.quantity);
        await client.query(
          `INSERT INTO bundle_items (id, bundle_id, product_variant_id, quantity, organization_id)
           SELECT unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::int[]), $5`,
          [itemIds, id, newVariantIds, qtys, orgId],
        );
      }

      // R49: audit INSIDE the tx. Bundle price mutations are a common
      // fraud vector ("who dropped the 5-piece bundle from $120 to
      // $12?"); the audit row is the ground truth that investigations
      // depend on. Post-commit audit drops hide the actor.
      const changed: Record<string, unknown> = {};
      if (name !== undefined)           changed.name = name;
      if (description !== undefined)    changed.description = description ?? null;
      if (imageUrl !== undefined)       changed.image_url = imageUrl ?? null;
      if (bundlePrice !== undefined)    changed.bundle_price = bundlePrice.toFixed(2);
      if (compareAtPrice !== undefined) changed.compare_at_price = compareAtPrice.toFixed(2);
      if (isActive !== undefined)       changed.is_active = isActive;
      if (items !== undefined)          changed.items_replaced = items.length;
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'bundle', $5, 'bundle_updated', $6, now())`,
        [randomUUID(), orgId, null, employee.id, id, JSON.stringify({ changes: changed })],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // R27-C12: JOIN through product_bundles for explicit org gate.
    // The bundle was already org-verified above, but without this,
    // a race/corrupt FK could splice a foreign bundle's items in.
    const itemsRes = await orgQuery(
      orgId,
      `SELECT bi.id, bi.bundle_id, bi.product_variant_id, bi.quantity, bi.organization_id, bi.created_at
       FROM bundle_items bi
       JOIN product_bundles pb ON pb.id = bi.bundle_id AND pb.organization_id = $2
       WHERE bi.bundle_id = $1 ORDER BY bi.created_at ASC`,
      [id, orgId],
    );

    invalidateStoreCache(orgId);
    return NextResponse.json({
      bundle: shapeBundles([bundleRow!], itemsRes.rows as BundleItemRow[])[0],
    });
  } catch (err) {
    console.error("PATCH /api/bundles error:", safeErr(err));
    return NextResponse.json({ error: "Failed to update bundle" }, { status: 500 });
  }
});

/** DELETE /api/bundles — hard-delete (cascades to bundle_items). */
export const DELETE = withAdminAuth("pricing.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(bundleDeleteSchema, body);
    if (!v.success) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }

    // R49: wrap prior-snapshot SELECT + DELETE + audit in one orgTx.
    // Bundle deletion cascades to bundle_items — a destructive action
    // whose audit trail must not be lossy.
    const client = await orgTx(orgId);
    try {
      // R27-C12: explicit organization_id filter on SELECT + DELETE.
      const { rows: priorRows } = await client.query(
        `SELECT name, slug, bundle_price FROM product_bundles WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
        [v.data.id, orgId],
      );
      const prior = priorRows[0] as { name: string; slug: string; bundle_price: string } | undefined;

      const delRes = await client.query(
        `DELETE FROM product_bundles WHERE id = $1 AND organization_id = $2`,
        [v.data.id, orgId],
      );
      if (!delRes.rowCount) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Bundle not found" }, { status: 404 });
      }

      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'bundle', $5, 'bundle_deleted', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, v.data.id,
          JSON.stringify(
            prior
              ? { name: prior.name, slug: prior.slug, bundle_price: String(prior.bundle_price) }
              : {},
          ),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    invalidateStoreCache(orgId);
    return NextResponse.json({ id: v.data.id, deleted: true });
  } catch (err) {
    console.error("DELETE /api/bundles error:", safeErr(err));
    return NextResponse.json({ error: "Failed to delete bundle" }, { status: 500 });
  }
});
