/**
 * R23-L-3: admin-gated health diagnostics.
 *
 * The public `/api/health` endpoint returns the minimum ops-alertable
 * surface (binary up/down). THIS endpoint returns full subsystem
 * detail — KV error strings, DB latency, schema version info — but
 * requires an admin session so attackers can't use it to probe
 * subsystem state for attack timing.
 *
 * Use from ops dashboards by attaching the admin cookie; Cloudflare's
 * Health Check synthetic monitors should call `/api/health` (no auth)
 * for liveness, and this endpoint for on-demand diagnostics.
 */

import { NextResponse } from "next/server";
import { getPool } from "@/lib/supabase-rest";
import { probeKvBinding } from "@/lib/auth/kv-rate-limit";
import { withAdminAuth } from "@/lib/api/with-auth";
import { safeErr } from "@/lib/logging/safe-err";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, private, max-age=0" };

// `audit.view` is the ops / manager-view permission — the narrowest
// scope that's meaningful for "can see subsystem health detail."
export const GET = withAdminAuth("audit.view", async () => {
  const kvProbe = await probeKvBinding();
  const startedAt = Date.now();

  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT 1 AS check, now() AS ts, version() AS pg_version, current_setting('server_version_num') AS pg_version_num LIMIT 1`,
    );
    const dbLatencyMs = Date.now() - startedAt;
    if (rows[0]?.check !== 1) {
      return NextResponse.json(
        {
          status: "degraded",
          error: "Database check returned unexpected result",
          database: { connected: false, latencyMs: dbLatencyMs },
          rateLimitKv: kvProbe,
          timestamp: new Date().toISOString(),
        },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }

    // R39-A1-4: verify the audit-events tamper triggers are still
    // armed. A DBA (or compromised service-role key) can
    // `DROP TRIGGER trg_audit_events_no_update ON audit_events` to
    // disarm the tamper-prevent safety net and silently edit the
    // audit log. Probe the `check_audit_triggers()` helper installed
    // by migration 068 and surface missing triggers to the dashboard.
    // Soft-fail — missing helper means the DB predates mig 068 and
    // we report `unknown`, not `unhealthy`, so the health page
    // doesn't break during a deploy window.
    let auditTriggers: {
      status: "ok" | "missing" | "unknown";
      missing?: string[];
    };
    try {
      const { rows: trigRows } = await pool.query(
        `SELECT trigger_name, is_present FROM check_audit_triggers()`,
      );
      const missing = (trigRows as Array<{ trigger_name: string; is_present: boolean }>)
        .filter((r) => !r.is_present)
        .map((r) => r.trigger_name);
      auditTriggers = missing.length === 0
        ? { status: "ok" }
        : { status: "missing", missing };
    } catch {
      auditTriggers = { status: "unknown" };
    }

    return NextResponse.json(
      {
        status: auditTriggers.status === "missing" ? "degraded" : "ok",
        database: {
          connected: true,
          latencyMs: dbLatencyMs,
          pgVersion: rows[0]?.pg_version_num,
        },
        rateLimitKv: kvProbe,
        auditTriggers,
        timestamp: new Date().toISOString(),
      },
      {
        status: auditTriggers.status === "missing" ? 503 : 200,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (err) {
    console.error("[admin/health] DB check failed:", safeErr(err));
    return NextResponse.json(
      {
        status: "unhealthy",
        error: "Database unreachable",
        database: { connected: false, latencyMs: Date.now() - startedAt },
        rateLimitKv: kvProbe,
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
});
