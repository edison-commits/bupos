/**
 * R16-L-2: compute a [fromTs, toTs] timestamptz range for a given org + date
 * range, using the org's configured timezone (falls back to UTC). Used by
 * every reports handler so day-boundaries line up with what the shop
 * actually considers a day — not the UTC calendar.
 *
 * The raw `${from}T00:00:00Z` / `T23:59:59Z` construction silently omitted
 * morning-afternoon local hours for west-of-UTC shops and included
 * next-morning hours that belong to the previous local day. `/api/eod-report`
 * already uses this pattern; this helper centralises it so every other
 * report handler converges.
 *
 * Implementation: one round-trip that computes both bounds in PG via
 * `$1::date AT TIME ZONE organizations.timezone`. Previous versions built
 * the bounds client-side, which wouldn't honor DST transitions correctly.
 */
import { orgQuery } from "@/lib/supabase-rest";

export async function buildOrgDayRange(
  orgId: string,
  from: string,
  to: string,
): Promise<{ fromTs: string; toTs: string }> {
  const { rows } = await orgQuery(
    orgId,
    `SELECT
       ($1::date AT TIME ZONE COALESCE(
          (SELECT timezone FROM organizations WHERE id = $3),
          'UTC'
        )) AS from_ts,
       (($2::date + INTERVAL '1 day') AT TIME ZONE COALESCE(
          (SELECT timezone FROM organizations WHERE id = $3),
          'UTC'
        )) AS to_ts`,
    [from, to, orgId],
  );
  const row = rows[0] as { from_ts: string; to_ts: string };
  return { fromTs: String(row.from_ts), toTs: String(row.to_ts) };
}
