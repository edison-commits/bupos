import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool, orgQuery } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { generateReportData, sendEodEmail, hasResendKey } from "@/lib/reports/eod";
import { requireInternalHmac } from "@/lib/api/internal-hmac";

/**
 * HMAC-gated scheduled sender for the sales digest (P3.2). Invoked hourly
 * by GitHub Actions (Worker cron isn't usable with OpenNext — same precedent
 * as reconcile-channels). For each org with a digest enabled (cross-org list
 * via the SECURITY DEFINER list_digest_orgs RPC), checks whether the org's
 * LOCAL hour matches its configured sendHour and, if so:
 *   • daily digest  — covers the org's previous local calendar day
 *   • weekly digest — Mondays only, covers the previous Mon–Sun
 * Double-sends are prevented by lastDailySentOn / lastWeeklySentOn markers
 * (the hourly cron + retries are idempotent per target window). Auth +
 * fail-closed gate copied from /api/internal/run-cleanup, with timestamp-bound
 * HMAC protection so captured request headers cannot be replayed indefinitely.
 */
interface DigestOrgRow {
  organization_id: string;
  timezone: string | null;
  digest_config: {
    dailyEnabled?: boolean;
    weeklyEnabled?: boolean;
    recipients?: string[];
    sendHour?: number;
    lastDailySentOn?: string | null;
    lastWeeklySentOn?: string | null;
  };
}

/** The org's current local calendar date (YYYY-MM-DD), hour, and weekday. */
function localParts(tz: string): { date: string; hour: number; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl emits "24" for midnight in some environments — normalize.
    hour: Number(parts.hour) % 24,
    weekday: String(parts.weekday),
  };
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function markSent(orgId: string, field: "lastDailySentOn" | "lastWeeklySentOn", value: string) {
  // check-pool-org-filter: scoped-by-id-is-org-id-on-organizations-table
  // `organizations.id` IS the tenant scope (root of the tenancy tree).
  await orgQuery(
    orgId,
    `UPDATE organizations SET digest_config = jsonb_set(digest_config, $2::text[], to_jsonb($3::text)) WHERE id = $1`,
    [orgId, `{${field}}`, value],
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireInternalHmac(req, process.env.SALES_DIGEST_SECRET, "Digest endpoint not configured");
  if (!auth.ok) return auth.response;
  if (!hasResendKey()) {
    return NextResponse.json({ error: "RESEND_API_KEY not configured" }, { status: 503 });
  }

  let orgs: DigestOrgRow[] = [];
  try {
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT organization_id, timezone, digest_config FROM list_digest_orgs()`);
    orgs = rows as DigestOrgRow[];
  } catch (err) {
    console.error("[send-sales-digest] list:", safeErr(err));
    return NextResponse.json({ error: "List failed" }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const org of orgs) {
    try {
      const cfg = org.digest_config ?? {};
      const recipients = (cfg.recipients ?? []).filter((r) => typeof r === "string" && r.includes("@"));
      if (recipients.length === 0) { skipped++; continue; }
      const { date: localToday, hour, weekday } = localParts(org.timezone || "UTC");
      if (hour !== (cfg.sendHour ?? 8)) { skipped++; continue; }

      // The digest reports the org's FIRST location (single-store reality;
      // matches the console's store.locations[0] convention).
      const loc = await orgQuery(
        org.organization_id,
        `SELECT id FROM locations WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [org.organization_id],
      );
      const locationId = loc.rows[0]?.id as string | undefined;
      if (!locationId) { skipped++; continue; }

      // Daily — covers yesterday (local), once per target day.
      if (cfg.dailyEnabled) {
        const target = addDays(localToday, -1);
        if (cfg.lastDailySentOn !== target) {
          const report = await generateReportData(org.organization_id, locationId, { fromDay: target, toDay: target });
          await sendEodEmail(report, {
            to: recipients,
            subject: `Daily Sales Digest — ${target}`,
            heading: "BasicUniform POS — Daily Sales Digest",
          });
          await markSent(org.organization_id, "lastDailySentOn", target);
          sent++;
        }
      }

      // Weekly — Mondays, covers the previous Mon–Sun, once per window.
      if (cfg.weeklyEnabled && weekday === "Mon") {
        const weekEnd = addDays(localToday, -1);   // Sunday
        const weekStart = addDays(localToday, -7); // previous Monday
        if (cfg.lastWeeklySentOn !== weekEnd) {
          const report = await generateReportData(org.organization_id, locationId, { fromDay: weekStart, toDay: weekEnd });
          await sendEodEmail(report, {
            to: recipients,
            subject: `Weekly Sales Digest — ${weekStart} to ${weekEnd}`,
            heading: "BasicUniform POS — Weekly Sales Digest",
          });
          await markSent(org.organization_id, "lastWeeklySentOn", weekEnd);
          sent++;
        }
      }
    } catch (err) {
      failed++;
      console.error("[send-sales-digest] org:", safeErr(err));
    }
  }

  return NextResponse.json({ ok: true, orgs: orgs.length, sent, skipped, failed });
}
