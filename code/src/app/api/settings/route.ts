import { NextResponse } from 'next/server';
import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { validateBody, settingsUpdateSchema } from '@/lib/validation/schemas';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { randomUUID } from '@/lib/uuid';

import { safeErr } from "@/lib/logging/safe-err";
export const GET = withDualAuth("catalog.manage", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  try {
    const [orgResult, locationResult] = await Promise.all([
      // check-pool-org-filter: scoped-by-organizations-id-is-orgId
      // `organizations.id` IS the tenant key. Filtering by id = orgId
      // IS the tenant scope.
      orgQuery(
        orgId,
        `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                receipt_header, receipt_footer,
                receipt_store_name, receipt_store_address, receipt_store_city,
                receipt_store_region, receipt_store_postal_code, receipt_store_phone
         FROM organizations WHERE id = $1`,
        [orgId]
      ),
      orgQuery(
        orgId,
        `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
         FROM locations WHERE id = $1 AND organization_id = $2`,
        [locationId, orgId]
      ),
    ]);

    const org = orgResult.rows[0];
    if (!org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    const location = locationResult.rows[0];
    if (!location) {
      return NextResponse.json({ error: 'Location not found' }, { status: 404 });
    }

    return NextResponse.json({
      store: {
        name: org.name,
        legalName: org.legal_name,
        phone: org.phone,
        email: org.email,
        website: org.website,
        timezone: org.timezone,
        currencyCode: org.currency_code,
      },
      location: {
        name: location.name,
        code: location.code,
        address1: location.address1,
        city: location.city,
        region: location.region,
        postalCode: location.postal_code,
        phone: location.phone,
        taxRate: Number(location.tax_rate),
        isActive: location.is_active,
      },
      receipt: {
        header: org.receipt_header || '',
        footer: org.receipt_footer || '',
        storeName: org.receipt_store_name || '',
        storeAddress: org.receipt_store_address || '',
        storeCity: org.receipt_store_city || '',
        storeRegion: org.receipt_store_region || '',
        storePostalCode: org.receipt_store_postal_code || '',
        storePhone: org.receipt_store_phone || '',
      },
    });
  } catch (error) {
    console.error('Settings GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
});

// Receipt headers/footers, store identity, and location metadata affect customer
// receipts and branding. Restrict to manager/owner via employee.manage (so
// inventory_clerk, which has catalog.manage, cannot change them).
export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  // R30-M4: rate-limit settings mutations. Prior shape had no cap;
  // a compromised manager cookie could spam org/location/receipt
  // settings updates (brand spoofing, tax-rate tampering). 10 per
  // 5 min per employee is well above legitimate usage.
  const rl = checkRateLimit(`settings-put:${orgId}:${ctx.employee.id}`, { maxAttempts: 10, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many settings updates. Try again shortly.' }, { status: 429 });
  }
  const locationId = ctx.employee.locationIds?.[0];
  try {
    const raw = await request.json();
    const v = validateBody(settingsUpdateSchema, raw);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { section, data } = v.data;

    // Build dynamic UPDATE with only provided fields to avoid wiping other
    // columns. Keys are restricted to the fieldMap (non-matching keys are
    // ignored), and WHERE placeholders are generated in one pass so there's
    // no string rewrite step — the old regex `.replace(/\$(\d+)/g, ...)` was
    // footgun-prone (a future filter like `phone ILIKE '$1'` would also get
    // rewritten). Accompanied by `.strict()` Zod schemas (R8-M-2) so
    // unknown keys are rejected before they get here.
    const buildDynamicUpdate = (
      table: string,
      fieldMap: Record<string, string>,
      values: Record<string, unknown>,
      whereTemplate: (offset: number) => { sql: string; params: unknown[] },
    ) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (const [key, col] of Object.entries(fieldMap)) {
        if (values[key] !== undefined) {
          sets.push(`${col} = $${i++}`);
          params.push(values[key]);
        }
      }
      if (sets.length === 0) return null;
      sets.push(`updated_at = NOW()`);
      const { sql: whereSql, params: whereParams } = whereTemplate(i);
      return {
        sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${whereSql}`,
        params: [...params, ...whereParams],
      };
    };

    switch (section) {
      case 'store': {
        const upd = buildDynamicUpdate(
          'organizations',
          { name: 'name', legalName: 'legal_name', phone: 'phone', email: 'email',
            website: 'website', timezone: 'timezone', currencyCode: 'currency_code' },
          data as Record<string, unknown>,
          (offset) => ({ sql: `id = $${offset}`, params: [orgId] }),
        );
        // R49: wrap UPDATE + audit in one orgTx. Prior shape ran the
        // UPDATE via orgQuery then post-commit audit; on failure the
        // store-identity change persisted without a trail, covering
        // attacks that rewrite receipt headers to impersonate the
        // merchant to customers.
        const client = await orgTx(orgId);
        try {
          if (upd) await client.query(upd.sql, upd.params);
          await client.query(
            `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'organization', $5, 'settings_updated', $6, now())`,
            [
              randomUUID(), orgId, null, ctx.employee.id, orgId,
              JSON.stringify({ section: 'store', keys: Object.keys(data as Record<string, unknown>) }),
            ],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        return NextResponse.json({ success: true });
      }

      case 'location': {
        // R44-H / R60-A2: require step-up re-auth when `taxRate` is
        // ACTUALLY BEING CHANGED (not merely present in the
        // payload). The admin UI serializes the full location shape
        // on every save, so `taxRate !== undefined` was true even
        // for non-tax edits (phone, address, etc.) — every save
        // then failed with "password required". Now we snapshot-
        // compare the DB prior value with the same 0.00005 epsilon
        // the Server Action `updateLocationAction` uses (REST
        // parity closed).
        const submittedTax = (data as { taxRate?: number }).taxRate;
        if (submittedTax !== undefined) {
          const { rows: priorRows } = await orgQuery(
            orgId,
            `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
            [locationId, orgId],
          );
          const priorTax = priorRows[0]?.tax_rate != null ? Number(priorRows[0].tax_rate) : null;
          const taxChanged = priorTax === null || Math.abs(priorTax - submittedTax) > 0.00005;
          if (taxChanged) {
            const { requireStepUp } = await import('@/lib/auth/step-up');
            const stepUp = await requireStepUp({
              actorId: ctx.employee.id,
              orgId,
              actorPassword: (raw as { actorPassword?: string })?.actorPassword,
              bucketKey: 'tax-rate-stepup',
            });
            if (!stepUp.ok) {
              return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
            }
          }
        }
        const upd = buildDynamicUpdate(
          'locations',
          { name: 'name', code: 'code', address1: 'address1', city: 'city',
            region: 'region', postalCode: 'postal_code', phone: 'phone', taxRate: 'tax_rate' },
          data as Record<string, unknown>,
          (offset) => ({ sql: `id = $${offset} AND organization_id = $${offset + 1}`, params: [locationId, orgId] }),
        );
        // R49: wrap UPDATE + audit in one orgTx. taxRate is the highest-
        // fraud-risk admin mutation (R39-A1-2 rationale); audit must
        // not be lossy on post-commit failure.
        const client = await orgTx(orgId);
        try {
          if (upd) await client.query(upd.sql, upd.params);
          await client.query(
            `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'location', $5, 'settings_updated', $6, now())`,
            [
              randomUUID(), orgId, locationId ?? null, ctx.employee.id, locationId ?? orgId,
              JSON.stringify({ section: 'location', keys: Object.keys(data as Record<string, unknown>) }),
            ],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        // Return full settings after update so client state stays valid
        const [updatedOrg, updatedLocation] = await Promise.all([
          // check-pool-org-filter: scoped-by-organizations-id-is-orgId
          // `organizations.id` IS the tenant key. Filtering by id = orgId
          // IS the tenant scope.
          orgQuery(
            orgId,
            `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                    receipt_header, receipt_footer,
                    receipt_store_name, receipt_store_address, receipt_store_city,
                    receipt_store_region, receipt_store_postal_code, receipt_store_phone
             FROM organizations WHERE id = $1`,
            [orgId]
          ),
          orgQuery(
            orgId,
            `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
             FROM locations WHERE id = $1 AND organization_id = $2`,
            [locationId, orgId]
          ),
        ]);
        const org = updatedOrg.rows[0];
        const loc = updatedLocation.rows[0];
        return NextResponse.json({
          store: {
            name: org.name, legalName: org.legal_name, phone: org.phone,
            email: org.email, website: org.website, timezone: org.timezone,
            currencyCode: org.currency_code,
          },
          location: {
            name: loc.name, code: loc.code, address1: loc.address1,
            city: loc.city, region: loc.region, postalCode: loc.postal_code,
            phone: loc.phone, taxRate: Number(loc.tax_rate), isActive: loc.is_active,
          },
          receipt: {
            header: org.receipt_header || '', footer: org.receipt_footer || '',
            storeName: org.receipt_store_name || '', storeAddress: org.receipt_store_address || '',
            storeCity: org.receipt_store_city || '', storeRegion: org.receipt_store_region || '',
            storePostalCode: org.receipt_store_postal_code || '', storePhone: org.receipt_store_phone || '',
          },
        });
      }

      case 'receipt': {
        const upd = buildDynamicUpdate(
          'organizations',
          { header: 'receipt_header', footer: 'receipt_footer',
            storeName: 'receipt_store_name', storeAddress: 'receipt_store_address',
            storeCity: 'receipt_store_city', storeRegion: 'receipt_store_region',
            storePostalCode: 'receipt_store_postal_code', storePhone: 'receipt_store_phone' },
          data as Record<string, unknown>,
          (offset) => ({ sql: `id = $${offset}`, params: [orgId] }),
        );
        // R49: wrap UPDATE + audit in one orgTx.
        const client = await orgTx(orgId);
        try {
          if (upd) await client.query(upd.sql, upd.params);
          await client.query(
            `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'organization', $5, 'settings_updated', $6, now())`,
            [
              randomUUID(), orgId, locationId ?? null, ctx.employee.id, orgId,
              JSON.stringify({ section: 'receipt', keys: Object.keys(data as Record<string, unknown>) }),
            ],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Unknown section' }, { status: 400 });
    }
  } catch (error) {
    console.error('Settings PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
});
