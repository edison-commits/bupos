import 'server-only';
import pool, { orgTx } from '@/lib/db';
import type {
  TimeClockEntry,
  TimeClockEventType,
  TimesheetSummary,
  PromoCode,
  PromoRedemption,
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

function toPromoRedemption(r: Record<string, unknown>): PromoRedemption {
  return {
    id: r.id as string,
    promoCodeId: r.promo_code_id as string,
    transactionId: r.transaction_id as string,
    employeeId: r.employee_id as string,
    discountAmount: Number(r.discount_amount),
    createdAt: String(r.created_at),
  };
}

// ── Time Clock Entries ───────────────────────────────────────────────

export async function pgInsertTimeClockEntry(data: {
  employeeId: string;
  locationId: string;
  organizationId: string;
  eventType: TimeClockEventType;
  note?: string;
}): Promise<TimeClockEntry> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO time_clock_entries (organization_id, employee_id, location_id, event_type, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [data.organizationId, data.employeeId, data.locationId, data.eventType, data.note ?? null, ts],
  );
  return toTimeClockEntry(rows[0]);
}

export async function pgReadTimeClockEntries(
  locationId: string,
  datePrefix: string,
): Promise<TimeClockEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM time_clock_entries
     WHERE location_id = $1 AND created_at::text LIKE $2
     ORDER BY created_at ASC`,
    [locationId, `${datePrefix}%`],
  );
  return rows.map(toTimeClockEntry);
}

export async function pgReadEmployeeTimeClockEntries(
  employeeId: string,
  datePrefix: string,
): Promise<TimeClockEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM time_clock_entries
     WHERE employee_id = $1 AND created_at::text LIKE $2
     ORDER BY created_at ASC`,
    [employeeId, `${datePrefix}%`],
  );
  return rows.map(toTimeClockEntry);
}

/** Build timesheet summaries from Postgres for a given date + location. */
export async function pgGetTimesheetSummaries(
  locationId: string,
  date?: string,
): Promise<TimesheetSummary[]> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const entries = await pgReadTimeClockEntries(locationId, targetDate);

  // Group by employee
  const byEmployee = new Map<string, TimeClockEntry[]>();
  for (const entry of entries) {
    const existing = byEmployee.get(entry.employeeId) ?? [];
    existing.push(entry);
    byEmployee.set(entry.employeeId, existing);
  }

  // Look up employee names
  const empIds = [...byEmployee.keys()];
  const empNameMap = new Map<string, string>();
  if (empIds.length > 0) {
    const placeholders = empIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `SELECT id, display_name FROM employees WHERE id IN (${placeholders})`,
      empIds,
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

export async function pgRedeemPromoCode(data: {
  promoCodeId: string; transactionId: string;
  employeeId: string; discountAmount: number;
}): Promise<PromoRedemption> {
  // Get organizationId from promo code
  const { rows: promoRows } = await pool.query(
    'SELECT organization_id FROM promo_codes WHERE id = $1',
    [data.promoCodeId],
  );
  if (!promoRows[0]) throw new Error('Promo code not found');
  const organizationId = promoRows[0].organization_id as string;

  const client = await orgTx(organizationId);
  try {
    const ts = new Date().toISOString();

    // Increment redemption count and check if depleted
    const { rows: codeRows } = await client.query(
      `UPDATE promo_codes SET current_redemptions = current_redemptions + 1,
       status = CASE WHEN current_redemptions + 1 >= max_redemptions AND max_redemptions > 0 THEN 'depleted' ELSE status END,
       updated_at = $1 WHERE id = $2 AND status = 'active' RETURNING *`,
      [ts, data.promoCodeId],
    );
    if (!codeRows[0]) throw new Error('Promo code not active or not found');

    // Insert redemption record
    const { rows } = await client.query(
      `INSERT INTO promo_redemptions (promo_code_id, transaction_id, employee_id, discount_amount, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.promoCodeId, data.transactionId, data.employeeId, data.discountAmount, ts],
    );
    await client.query('COMMIT');
    return toPromoRedemption(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function pgUpdatePromoCodeStatus(
  promoCodeId: string,
  status: PromoCode['status'],
): Promise<PromoCode | null> {
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    'UPDATE promo_codes SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [status, ts, promoCodeId],
  );
  return rows[0] ? toPromoCode(rows[0]) : null;
}

export async function pgReadPromoRedemptions(promoCodeId: string): Promise<PromoRedemption[]> {
  const { rows } = await pool.query(
    'SELECT * FROM promo_redemptions WHERE promo_code_id = $1 ORDER BY created_at DESC',
    [promoCodeId],
  );
  return rows.map(toPromoRedemption);
}
