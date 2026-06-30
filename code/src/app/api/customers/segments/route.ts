import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api/with-auth';
import { orgQuery } from '@/lib/supabase-rest';
import { csvCell } from '@/lib/format/csv-sanitize';
import { safeErr } from '@/lib/logging/safe-err';

const SEGMENTS = [
  'all',
  'win_back',
  'loyalty_ready',
  'high_value',
  'saved_preferences_no_recent_purchase',
  'marketing_opt_in',
] as const;

type SegmentKey = typeof SEGMENTS[number];

const SEGMENT_LABELS: Record<SegmentKey, string> = {
  all: 'All customers',
  win_back: 'Win-back',
  loyalty_ready: 'Loyalty ready',
  high_value: 'High value',
  saved_preferences_no_recent_purchase: 'Saved preferences, no recent purchase',
  marketing_opt_in: 'Marketing opt-in',
};

function isSegment(value: string | null): value is SegmentKey {
  return !!value && (SEGMENTS as readonly string[]).includes(value);
}

function segmentPredicate(segment: SegmentKey) {
  switch (segment) {
    case 'win_back':
      return "last_purchase_at IS NOT NULL AND last_purchase_at < now() - interval '90 days'";
    case 'loyalty_ready':
      return 'loyalty_points >= 100';
    case 'high_value':
      return 'total_spend >= 500';
    case 'saved_preferences_no_recent_purchase':
      return "preference_count > 0 AND (last_purchase_at IS NULL OR last_purchase_at < now() - interval '30 days')";
    case 'marketing_opt_in':
      return "marketing_opt_in = true";
    case 'all':
    default:
      return 'true';
  }
}

function toCsv(rows: Record<string, unknown>[]) {
  const columns = ['first_name', 'last_name', 'email', 'phone', 'segment', 'loyalty_points', 'total_spend', 'visit_count', 'last_purchase_at', 'preference_count'];
  return [columns.join(','), ...rows.map((row) => columns.map((col) => csvCell(row[col])).join(','))].join('\n');
}

export const GET = withAdminAuth("employee.manage", async (req, ctx) => {
  const { orgId } = ctx;
  const sp = req.nextUrl.searchParams;
  const requested = sp.get('segment') || 'all';
  const segment: SegmentKey = isSegment(requested) ? requested : 'all';
  const exportCsv = sp.get('format') === 'csv';
  const limit = exportCsv ? 5000 : 100;

  try {
    const baseCte = `WITH customer_activity AS (
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.email,
        c.phone,
        c.loyalty_points,
        c.total_spend,
        c.visit_count,
        c.created_at,
        c.updated_at,
        MAX(t.created_at) FILTER (WHERE t.status = 'completed') AS last_purchase_at,
        COUNT(DISTINCT cp.id)::int AS preference_count,
        EXISTS (
          SELECT 1
          FROM customer_preferences cp2
          WHERE cp2.organization_id = c.organization_id
            AND cp2.customer_id = c.id
        ) AS has_saved_preferences,
        (
          c.notes ILIKE '%marketing opt%'
          OR c.notes ILIKE '%opted into marketing%'
        ) AS marketing_opt_in
      FROM customers c
      LEFT JOIN transactions t ON t.customer_id = c.id AND t.organization_id = $1
      LEFT JOIN customer_preferences cp ON cp.customer_id = c.id AND cp.organization_id = $1
      WHERE c.organization_id = $1 AND c.is_active = true
      GROUP BY c.id
    )`;

    const countsSql = `${baseCte}
      SELECT key, label, count::int FROM (
        SELECT 'all' AS key, 'All customers' AS label, COUNT(*) AS count FROM customer_activity
        UNION ALL SELECT 'win_back', 'Win-back', COUNT(*) FROM customer_activity WHERE ${segmentPredicate('win_back')}
        UNION ALL SELECT 'loyalty_ready', 'Loyalty ready', COUNT(*) FROM customer_activity WHERE ${segmentPredicate('loyalty_ready')}
        UNION ALL SELECT 'high_value', 'High value', COUNT(*) FROM customer_activity WHERE ${segmentPredicate('high_value')}
        UNION ALL SELECT 'saved_preferences_no_recent_purchase', 'Saved preferences, no recent purchase', COUNT(*) FROM customer_activity WHERE ${segmentPredicate('saved_preferences_no_recent_purchase')}
        UNION ALL SELECT 'marketing_opt_in', 'Marketing opt-in', COUNT(*) FROM customer_activity WHERE ${segmentPredicate('marketing_opt_in')}
      ) segment_counts`;

    const listSql = `${baseCte}
      SELECT
        id,
        first_name,
        last_name,
        email,
        phone,
        loyalty_points,
        total_spend,
        visit_count,
        last_purchase_at,
        preference_count,
        marketing_opt_in,
        $2::text AS segment
      FROM customer_activity
      WHERE ${segmentPredicate(segment)}
      ORDER BY total_spend DESC, last_purchase_at DESC NULLS LAST, updated_at DESC
      LIMIT $3`;

    const [countsRes, listRes] = await Promise.all([
      orgQuery(orgId, countsSql, [orgId]),
      orgQuery(orgId, listSql, [orgId, segment, limit]),
    ]);

    if (exportCsv) {
      const csv = toCsv(listRes.rows as Record<string, unknown>[]);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="customer_segment_${segment}.csv"`,
        },
      });
    }

    return NextResponse.json({
      segment,
      label: SEGMENT_LABELS[segment],
      segments: countsRes.rows,
      customers: listRes.rows,
    });
  } catch (error) {
    console.error('GET /api/customers/segments error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to load customer segments' }, { status: 500 });
  }
});
