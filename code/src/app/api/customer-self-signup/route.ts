import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { clientIpFrom } from '@/lib/net/client-ip';
import { safeErr } from '@/lib/logging/safe-err';
import { validateBody, customerSelfSignupSchema } from '@/lib/validation/schemas';
import { invalidateStoreCache } from '@/lib/persistence/postgres-read-store';
import { checkOrigin } from '@/lib/api/with-auth';
import { randomUUID } from '@/lib/uuid';

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const orgId = process.env.BUPOS_ORG_ID;
  if (!orgId) {
    return NextResponse.json({ error: 'Customer signup is not configured.' }, { status: 503 });
  }

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }

  const clientIp = clientIpFrom(request.headers) || 'unknown';
  const bucket = `customer-self-signup:${orgId}:${clientIp}`;
  const rl = checkRateLimit(bucket, { maxAttempts: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many signups. Try again shortly.' }, { status: 429 });
  }
  try {
    const { checkKvRateLimit } = await import('@/lib/auth/kv-rate-limit');
    const kvRl = await checkKvRateLimit(bucket, { maxAttempts: 20, windowMs: 300_000 });
    if (!kvRl.allowed) {
      return NextResponse.json({ error: 'Too many signups. Try again shortly.' }, { status: 429 });
    }
  } catch {
    // Fail open; in-memory and DB layers still apply.
  }
  try {
    const { checkDbRateLimit } = await import('@/lib/auth/db-rate-limit');
    const dbRl = await checkDbRateLimit(bucket, { maxAttempts: 30, windowMs: 900_000 });
    if (!dbRl.allowed) {
      return NextResponse.json({ error: 'Too many signups. Try again shortly.' }, { status: 429 });
    }
  } catch {
    // Fail open; in-memory layer still applies.
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
    }

    const v = validateBody(customerSelfSignupSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const data = v.data;
    if (!data.email && !data.phone) {
      return NextResponse.json({ error: 'Email or phone is required.' }, { status: 400 });
    }

    const { orgTx } = await import('@/lib/supabase-rest');
    const client = await orgTx(orgId);
    try {
      const lookup = await client.query<{ id: string }>(
        `SELECT id FROM customers
          WHERE organization_id = $1
            AND (
              ($2::text IS NOT NULL AND lower(email) = lower($2::text))
              OR ($3::text IS NOT NULL AND phone = $3::text)
            )
          ORDER BY updated_at DESC
          LIMIT 1`,
        [orgId, data.email ?? null, data.phone ?? null],
      );

      const customerId = lookup.rows[0]?.id ?? randomUUID();
      const isExistingCustomer = lookup.rows.length > 0;
      if (!isExistingCustomer) {
        await client.query(
          `INSERT INTO customers (
             id, organization_id, first_name, last_name, email, phone, notes, is_active, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), now())`,
          [
            customerId,
            orgId,
            data.firstName.trim(),
            data.lastName.trim(),
            data.email ?? null,
            data.phone ?? null,
            data.marketingOptIn ? 'Customer opted into marketing from self-signup.' : null,
          ],
        );

        for (const pref of data.preferences) {
          await client.query(
            `INSERT INTO customer_preferences (
               organization_id, customer_id, category, size_label, fit_preference,
               preferred_colors, preferred_brands, style_notes, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (organization_id, customer_id, category) DO UPDATE SET
               size_label = EXCLUDED.size_label,
               fit_preference = EXCLUDED.fit_preference,
               preferred_colors = EXCLUDED.preferred_colors,
               preferred_brands = EXCLUDED.preferred_brands,
               style_notes = EXCLUDED.style_notes,
               updated_at = now()`,
            [
              orgId,
              customerId,
              pref.category.trim(),
              pref.size_label?.trim() || null,
              pref.fit_preference?.trim() || null,
              pref.preferred_colors.map((value) => value.trim()).filter(Boolean),
              pref.preferred_brands.map((value) => value.trim()).filter(Boolean),
              pref.style_notes?.trim() || null,
            ],
          );
        }
      }

      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, NULL, NULL, 'customer', $3, 'customer_self_signup', $4, now())`,
        [
          randomUUID(),
          orgId,
          customerId,
          JSON.stringify({ preferenceCount: data.preferences.length, marketingOptIn: !!data.marketingOptIn, existingCustomer: isExistingCustomer }),
        ],
      );

      await client.query('COMMIT');
      invalidateStoreCache(orgId);
      return NextResponse.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[customer-self-signup] failed:', safeErr(error));
    return NextResponse.json({ error: 'Failed to save customer profile.' }, { status: 500 });
  }
}
