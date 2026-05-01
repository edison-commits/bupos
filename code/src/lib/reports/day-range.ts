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

/**
 * OPS-AUDIT5-HIGH2: get "today" / "now" as a YYYY-MM-DD date string in
 * the org's configured timezone. Many handlers used
 * `new Date().toISOString().slice(0, 10)` which is UTC — for a Pacific-
 * TZ org at 5pm local on April 30, that returns "2026-05-01" because
 * UTC has already rolled over. The org-TZ-aware version returns
 * "2026-04-30" so EOD reports, expense rows, customer "new this month"
 * counters, and returns/search "this week / this month" windows all
 * line up with what the shop considers the local day.
 *
 * Cheap to compute: a single PG round-trip per call. Callers that need
 * both today + a day-range can chain into `buildOrgDayRange(orgId,
 * today, today)`. Worth the round-trip — the wrong day in an EOD
 * report shows up the next morning in finance reconciliation as a
 * "ghost day", and "missing yesterday's last hour" of returns when
 * filtering by date.
 */
export async function getOrgToday(orgId: string): Promise<string> {
  const { rows } = await orgQuery(
    orgId,
    `SELECT to_char(
              (now() AT TIME ZONE COALESCE(
                (SELECT timezone FROM organizations WHERE id = $1),
                'UTC'
              ))::date,
              'YYYY-MM-DD'
            ) AS today`,
    [orgId],
  );
  return (rows[0] as { today: string }).today;
}

export async function buildOrgDayRange(
  orgId: string,
  from: string,
  to: string,
): Promise<{ fromTs: string; toTs: string }> {
  // Pg type-codec for timestamptz returns a JS Date object on Node.
  // Calling `String(date)` produces JS-default toString format —
  // "Wed Apr 29 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"
  // — which is NOT a valid PG timestamp literal. Passing that string
  // back into another query as a parameter fails with SQLSTATE 22007
  // (invalid_datetime_format), surfacing in callers as a generic
  // 500.
  //
  // Cast to ::text inside the query so PG returns the ISO-8601
  // representation directly. JS receives a string we can pass back
  // unchanged.
  const { rows } = await orgQuery(
    orgId,
    `SELECT
       ($1::date AT TIME ZONE COALESCE(
          (SELECT timezone FROM organizations WHERE id = $3),
          'UTC'
        ))::text AS from_ts,
       (($2::date + INTERVAL '1 day') AT TIME ZONE COALESCE(
          (SELECT timezone FROM organizations WHERE id = $3),
          'UTC'
        ))::text AS to_ts`,
    [from, to, orgId],
  );
  const row = rows[0] as { from_ts: string; to_ts: string };
  return { fromTs: row.from_ts, toTs: row.to_ts };
}
