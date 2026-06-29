import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api/with-auth';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { safeErr } from '@/lib/logging/safe-err';
import { validateBody, customerPreferencesUpdateSchema } from '@/lib/validation/schemas';
import { invalidateStoreCache } from '@/lib/persistence/postgres-read-store';

export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`customers:preferences:put:${orgId}:${employee.id}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }

  try {
    const body = await request.json();
    const v = validateBody(customerPreferencesUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });

    const { customer_id, preferences } = v.data;
    const { orgTx } = await import('@/lib/supabase-rest');
    const { randomUUID } = await import('@/lib/uuid');
    const client = await orgTx(orgId);
    try {
      const customer = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [customer_id, orgId],
      );
      if (customer.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
      }

      const keepCategories = preferences.map((p) => p.category.trim());
      await client.query(
        `DELETE FROM customer_preferences
          WHERE organization_id = $1
            AND customer_id = $2
            AND NOT (category = ANY($3::text[]))`,
        [orgId, customer_id, keepCategories],
      );

      for (const pref of preferences) {
        await client.query(
          `INSERT INTO customer_preferences (
             organization_id, customer_id, category, size_label, fit_preference,
             preferred_colors, preferred_brands, style_notes, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (organization_id, customer_id, category) DO UPDATE SET
             size_label = EXCLUDED.size_label,
             fit_preference = EXCLUDED.fit_preference,
             preferred_colors = EXCLUDED.preferred_colors,
             preferred_brands = EXCLUDED.preferred_brands,
             style_notes = EXCLUDED.style_notes,
             updated_at = NOW()`,
          [
            orgId,
            customer_id,
            pref.category.trim(),
            pref.size_label?.trim() || null,
            pref.fit_preference?.trim() || null,
            pref.preferred_colors.map((v) => v.trim()).filter(Boolean),
            pref.preferred_brands.map((v) => v.trim()).filter(Boolean),
            pref.style_notes?.trim() || null,
          ],
        );
      }

      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'customer', $5, 'customer_preferences_updated', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, customer_id,
          JSON.stringify({ customer_id, categories: keepCategories }),
        ],
      );

      const { rows } = await client.query(
        `SELECT id, organization_id, customer_id, category, size_label, fit_preference,
                preferred_colors, preferred_brands, style_notes, created_at, updated_at
           FROM customer_preferences
          WHERE customer_id = $1 AND organization_id = $2
          ORDER BY category ASC`,
        [customer_id, orgId],
      );
      await client.query('COMMIT');
      invalidateStoreCache(orgId);
      return NextResponse.json({ preferences: rows });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Customer preferences PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to save customer preferences' }, { status: 500 });
  }
});
