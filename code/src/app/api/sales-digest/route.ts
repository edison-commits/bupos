import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { validateBody, digestConfigSchema } from "@/lib/validation/schemas";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { safeErr } from "@/lib/logging/safe-err";
import { generateReportData, sendEodEmail, hasResendKey } from "@/lib/reports/eod";

/**
 * Sales-digest configuration + test send (P3.2 — makes the long-stubbed
 * console panel real). The scheduled sender lives at
 * /api/internal/send-sales-digest (Bearer-gated, hourly cron).
 */

interface DigestConfig {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  recipients: string[];
  sendHour: number;
  lastDailySentOn: string | null;
  lastWeeklySentOn: string | null;
}

async function loadConfig(orgId: string): Promise<DigestConfig | null> {
  // check-pool-org-filter: scoped-by-id-is-org-id-on-organizations-table
  // `organizations.id` IS the tenant scope (root of the tenancy tree).
  const { rows } = await orgQuery(
    orgId,
    `SELECT digest_config FROM organizations WHERE id = $1`,
    [orgId],
  );
  return (rows[0]?.digest_config as DigestConfig) ?? null;
}

/** GET: the org's digest configuration. */
export const GET = withAdminAuth("reports.export", async (_req, ctx) => {
  const config = await loadConfig(ctx.orgId);
  if (!config) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  return NextResponse.json({ config, emailConfigured: hasResendKey() });
});

/** PUT: save settings (server-managed lastSent fields are preserved). */
export const PUT = withAdminAuth("reports.export", async (req, ctx) => {
  const { orgId } = ctx;
  const body = await req.json().catch(() => null);
  const v = validateBody(digestConfigSchema, body);
  if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });

  // jsonb || merge keeps lastDailySentOn / lastWeeklySentOn intact.
  // check-pool-org-filter: scoped-by-id-is-org-id-on-organizations-table
  await orgQuery(
    orgId,
    `UPDATE organizations SET digest_config = digest_config || $2::jsonb WHERE id = $1`,
    [orgId, JSON.stringify(v.data)],
  );
  const config = await loadConfig(orgId);
  return NextResponse.json({ ok: true, config });
});

/** POST: send a test digest (today's numbers) to the saved recipients now. */
export const POST = withAdminAuth("reports.export", async (_req, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`digest-test:${orgId}:${employee.id}`, { maxAttempts: 5, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const config = await loadConfig(orgId);
  if (!config || config.recipients.length === 0) {
    return NextResponse.json({ error: "Save at least one recipient first" }, { status: 400 });
  }
  if (!hasResendKey()) {
    return NextResponse.json({ error: "Email isn't configured on this server (missing RESEND_API_KEY)" }, { status: 503 });
  }

  const locationId = ctx.locationId ?? employee.locationIds?.[0];
  try {
    const report = await generateReportData(orgId, locationId);
    await sendEodEmail(report, {
      to: config.recipients,
      subject: `[TEST] Sales Digest — ${report.date}`,
      heading: "BasicUniform POS — Sales Digest (test)",
    });
    return NextResponse.json({ ok: true, sentTo: config.recipients.length });
  } catch (err) {
    console.error("[sales-digest] test send:", safeErr(err));
    return NextResponse.json({ error: "Test send failed" }, { status: 502 });
  }
});
