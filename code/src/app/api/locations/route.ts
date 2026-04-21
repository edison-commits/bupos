import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withDualAuth } from '@/lib/api/with-auth';

import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/locations — list all active locations for the authenticated
 * organization. Used by admin forms that need to assign employees to
 * locations without hard-coding a UUID.
 */
export const GET = withDualAuth('catalog.manage', async (_req, ctx) => {
  const { orgId } = ctx;
  try {
    const { rows } = await orgQuery(
      orgId,
      `SELECT id, name, code, is_active
       FROM locations
       WHERE organization_id = $1 AND is_active = true
       ORDER BY name`,
      [orgId],
    );
    return NextResponse.json({
      locations: rows.map((r: { id: string; name: string; code: string; is_active: boolean }) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        isActive: r.is_active,
      })),
    });
  } catch (err) {
    console.error('[api/locations] GET error:', safeErr(err));
    return NextResponse.json({ error: 'Failed to fetch locations' }, { status: 500 });
  }
});
