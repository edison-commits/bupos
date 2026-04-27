import 'server-only';
import pool, { orgTx } from '@/lib/db';
import type {
  TimeClockEntry,
  TimeClockEventType,
  TimesheetSummary,
  PromoCode,
} from '@/lib/domain/types';

// ── Row mappers ──────────────────────────────────────────────────────

function toTimeClockEntry(r: Record<string, unknown>): TimeClockEntry {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    employeeId: r.employee_id as string,
    locationId: r.location_id as string,
    eventType: r.event_type as TimeClockEventType,
    note: (r.note as string) ?? undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toPromoCode(r: Record<string, unknown>): PromoCode {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    code: r.code as string,
    description: (r.description as string) ?? undefined,
    type: r.type as PromoCode['type'],
    value: Number(r.value),
    minimumPurchase: Number(r.minimum_purchase),
    maxRedemptions: Number(r.max_redemptions),
    currentRedemptions: Number(r.current_redemptions),
    status: r.status as PromoCode['status'],
    startsAt: String(r.starts_at),
    expiresAt: r.expires_at ? String(r.expires_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// R30-C3: pgReadPromoRedemptions was removed (cross-tenant landmine).
// `toPromoRedemption` was its only caller — delete together to avoid
// the unused-var warning and to prevent a future caller from
// resurrecting the mapper with a fresh cross-tenant query.
// function toPromoRedemption(...) — intentionally removed.

// ── Time Clock Entries ───────────────────────────────────────────────

export async function pgInsertTimeClockEntry(data: {
  employeeId: string;
  locationId: string;
  organizationId: string;
  eventType: TimeClockEventType;
  note?: string;
  /** OPS-LOW1: when set, use this employeeId as the audit_events
   *  actor_employee_id. The default (the time-clock subject themselves)
   *  is correct for self-punch flows; an admin extending an employee's
   *  day on their behalf should pass the admin's id explicitly so the
   *  audit row distinguishes self-punch from admin-on-behalf. */
  actorEmployeeId?: string;
}): Promise<TimeClockEntry> {
  // R12-M-6: route through `orgTx` so the RLS `WITH CHECK` on
  // time_clock_entries is actually evaluated. The previous `pool.query`
  // used the BYPASSRLS `postgres` role and trusted the caller's
  // `organizationId` parameter — which happens to be correct today but
  // turns a caller-bug into a cross-tenant write the moment it isn't.
  const ts = new Date().toISOString();
  const client = await orgTx(data.organizationId);
  try {
    const { rows } = await client.query(
      `INSERT INTO time_clock_entries (organization_id, employee_id, location_id, event_type, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [data.organizationId, data.employeeId, data.locationId, data.eventType, data.note ?? null, ts],
    );
    // OPS-LOW1: record the time-clock event in audit_events INSIDE the
    // same orgTx so an admin extending an employee's day or a cashier
    // punching a buddy in leaves a forensic trail. Prior shape had no
    // audit row — the only evidence was the time_clock_entries row
    // itself, which is editable by anyone holding `employee.manage`
    // (with no second-order audit either). Mirrors the canonical
    // R49 in-tx audit shape.
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'time_clock_entry', $4, $5, $6, $7)`,
      [
        data.organizationId,
        data.locationId,
        data.actorEmployeeId ?? data.employeeId,
        rows[0].id,
        // event_kind matches the user-visible action: clock_in,
        // clock_out, break_start, break_end. Exact strings are the
        // TimeClockEventType union — the DB column is `text` so any
        // future addition rides through unchanged.
        `time_clock_${data.eventType}`,
        JSON.stringify({
          subject_employee_id: data.employeeId,
          event_type: data.eventType,
          on_behalf: data.actorEmployeeId !== undefined && data.actorEmployeeId !== data.employeeId,
          note: data.note ?? null,
        }),
        ts,
      ],
    );
    await client.query('COMMIT');
    return toTimeClockEntry(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// R26-F1: every read on org-scoped tables now takes an
// organizationId param and filters on it. Defense against the
// BYPASSRLS postgres role — without explicit `WHERE
// organization_id = $N`, passing a stolen id from another tenant
// would leak that tenant's time-clock data. Callers already vet
// the inputs, but the function is the right place to enforce it.
// R89-MED: 7th timezone sibling. `created_at` is TIMESTAMPTZ and
// `$3::date` parses the date in session TZ (UTC here — no SET timezone
// on the pool), so the bounds were UTC-midnight to UTC-midnight, not
// org-local-midnight. A Pacific-TZ store asking for "today's
// timesheet" at 9pm PT would see tomorrow's UTC-day rows (empty) and
// miss the afternoon PT entries that crossed into UTC-tomorrow.
// Parity with R82/R83/R87/R88 on dashboard, reports, eod-report,
// returns, shifts. Use the same subquery shape as buildOrgDayRange.
export async function pgReadTimeClockEntries(
  organizationId: string,
  locationId: string,
  datePrefix: string,
): Promise<TimeClockEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM time_clock_entries
     WHERE organization_id = $1
       AND location_id = $2
       AND created_at >= (
         $3::date AT TIME ZONE COALESCE(
           (SELECT timezone FROM organizations WHERE id = $1), 'UTC'
         )
       )
       AND created_at < (
         ($3::date + interval '1 day') AT TIME ZONE COALESCE(
           (SELECT timezone FROM organizations WHERE id = $1), 'UTC'
         )
       )
     ORDER BY created_at ASC`,
    [organizationId, locationId, datePrefix],
  );
  return rows.map(toTimeClockEntry);
}

// R89-MED: same fix applied defensively — this function has no live
// callers in src/ today, but it's exported and will be called from a
// future per-employee timesheet view. Fixing both siblings together
// prevents a future regression from resurrecting the UTC-bound shape.
export async function pgReadEmployeeTimeClockEntries(
  organizationId: string,
  employeeId: string,
  datePrefix: string,
): Promise<TimeClockEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM time_clock_entries
     WHERE organization_id = $1
       AND employee_id = $2
       AND created_at >= (
         $3::date AT TIME ZONE COALESCE(
           (SELECT timezone FROM organizations WHERE id = $1), 'UTC'
         )
       )
       AND created_at < (
         ($3::date + interval '1 day') AT TIME ZONE COALESCE(
           (SELECT timezone FROM organizations WHERE id = $1), 'UTC'
         )
       )
     ORDER BY created_at ASC`,
    [organizationId, employeeId, datePrefix],
  );
  return rows.map(toTimeClockEntry);
}

/**
 * Read an employee's time-clock entries since a specific timestamp (rolling
 * 24h window). Used by the state-machine check in clockAction to avoid the
 * UTC-day partition bug (R14-H-1) — a PT-evening shift that crosses UTC
 * midnight would see 0 entries on day+1 and reject the legitimate clock_out.
 */
export async function pgReadEmployeeTimeClockEntriesSince(
  organizationId: string,
  employeeId: string,
  sinceIso: string,
): Promise<TimeClockEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM time_clock_entries
     WHERE organization_id = $1
       AND employee_id = $2
       AND created_at >= $3::timestamptz
     ORDER BY created_at ASC`,
    [organizationId, employeeId, sinceIso],
  );
  return rows.map(toTimeClockEntry);
}

/** Build timesheet summaries from Postgres for a given date + location. */
export async function pgGetTimesheetSummaries(
  organizationId: string,
  locationId: string,
  date?: string,
): Promise<TimesheetSummary[]> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const entries = await pgReadTimeClockEntries(organizationId, locationId, targetDate);

  // Group by employee
  const byEmployee = new Map<string, TimeClockEntry[]>();
  for (const entry of entries) {
    const existing = byEmployee.get(entry.employeeId) ?? [];
    existing.push(entry);
    byEmployee.set(entry.employeeId, existing);
  }

  // Look up employee names — scope by org (defense in depth; inputs
  // already derive from byEmployee which was filtered above).
  const empIds = [...byEmployee.keys()];
  const empNameMap = new Map<string, string>();
  if (empIds.length > 0) {
    const placeholders = empIds.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await pool.query(
      `SELECT id, display_name FROM employees
       WHERE organization_id = $1 AND id IN (${placeholders})`,
      [organizationId, ...empIds],
    );
    for (const r of rows) {
      empNameMap.set(r.id as string, r.display_name as string);
    }
  }

  const summaries: TimesheetSummary[] = [];

  for (const [empId, empEntries] of byEmployee) {
    const sorted = [...empEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const empName = empNameMap.get(empId) ?? empId.slice(0, 8);

    const clockIn = sorted.find((e) => e.eventType === 'clock_in');
    const clockOut = sorted.findLast((e) => e.eventType === 'clock_out');

    // Build break pairs
    const breaks: { start: string; end?: string }[] = [];
    let currentBreak: { start: string; end?: string } | null = null;
    for (const entry of sorted) {
      if (entry.eventType === 'break_start') {
        currentBreak = { start: entry.createdAt };
      } else if (entry.eventType === 'break_end' && currentBreak) {
        currentBreak.end = entry.createdAt;
        breaks.push(currentBreak);
        currentBreak = null;
      }
    }
    if (currentBreak) breaks.push(currentBreak);

    const totalBreakMs = breaks.reduce((sum, b) => {
      if (!b.end) return sum;
      return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
    }, 0);

    const clockInTime = clockIn ? new Date(clockIn.createdAt).getTime() : 0;
    const clockOutTime = clockOut ? new Date(clockOut.createdAt).getTime() : Date.now();
    const totalWorkedMs = clockInTime > 0 ? Math.max(0, clockOutTime - clockInTime - totalBreakMs) : 0;

    const lastEvent = sorted[sorted.length - 1];
    let status: 'clocked_in' | 'on_break' | 'clocked_out' = 'clocked_out';
    if (lastEvent) {
      if (lastEvent.eventType === 'clock_in' || lastEvent.eventType === 'break_end') status = 'clocked_in';
      else if (lastEvent.eventType === 'break_start') status = 'on_break';
      else if (lastEvent.eventType === 'clock_out') status = 'clocked_out';
    }

    summaries.push({
      employeeId: empId,
      employeeName: empName,
      date: targetDate,
      clockIn: clockIn?.createdAt,
      clockOut: clockOut?.createdAt,
      breaks,
      totalWorkedMs,
      totalBreakMs,
      status,
    });
  }

  return summaries;
}

// ── Promo Codes ──────────────────────────────────────────────────────

export async function pgReadPromoCodes(orgId: string): Promise<PromoCode[]> {
  const { rows } = await pool.query(
    'SELECT * FROM promo_codes WHERE organization_id = $1 ORDER BY created_at DESC',
    [orgId],
  );
  return rows.map(toPromoCode);
}

export async function pgFindPromoCodeByCode(orgId: string, code: string): Promise<PromoCode | null> {
  const { rows } = await pool.query(
    'SELECT * FROM promo_codes WHERE organization_id = $1 AND code = $2',
    [orgId, code.toUpperCase()],
  );
  return rows[0] ? toPromoCode(rows[0]) : null;
}

export async function pgCreatePromoCode(data: {
  organizationId: string; code: string; description?: string;
  type: string; value: number; minimumPurchase: number;
  maxRedemptions: number; startsAt: string; expiresAt?: string;
}): Promise<PromoCode> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO promo_codes (organization_id, code, description, type, value, minimum_purchase, max_redemptions, status, starts_at, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10) RETURNING *`,
    [data.organizationId, data.code.toUpperCase(), data.description ?? null, data.type, data.value, data.minimumPurchase, data.maxRedemptions, data.startsAt, data.expiresAt ?? null, ts],
  );
  return toPromoCode(rows[0]);
}

// pgRedeemPromoCode and pgUpdatePromoCodeStatus were removed. Both derived
// the target organization from the promo row itself (self-attested trust
// boundary) — the same anti-pattern round 6 closed in pgAdjustInventory and
// pgToggleEmployee. Nothing in the codebase calls them anymore: active promo
// redemption goes through src/app/register/checkout-action.ts (inside an
// orgTx bound to the verified actor's org) and status updates go through
// /api/promo-codes/route.ts (same pattern). Leaving them in the module was
// a landmine — any future route that wired them up could be weaponised for
// cross-tenant promo manipulation.

// R30-C3: `pgReadPromoRedemptions` was removed — same shape as the
// pgRedeemPromoCode / pgUpdatePromoCodeStatus removals above: no live
// caller and a cross-tenant landmine (no org filter, no FK-scoped
// parent). Promo redemption history is now served by
// `/api/promo-codes/route.ts` (the `?id=` lookup path), which joins
// through promo_codes and gates by org at every level. If a future
// feature needs a raw redemption list, mirror that route's shape.
