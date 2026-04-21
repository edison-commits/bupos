import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/supabase-rest";
import { probeKvBinding } from "@/lib/auth/kv-rate-limit";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { clientIpFrom } from "@/lib/net/client-ip";

import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/health
 * Lightweight liveness probe — verifies the DB can execute a query under load.
 * Used by load balancers, uptime monitors, and the client-side connectivity checker.
 * No authentication required.
 *
 * R21-M-3: also surfaces KV rate-limit binding status so ops dashboards
 * can alert when the 3-layer limiter has silently degraded to 2-layer.
 *
 * R22-M-2: probe via `probeKvBinding()` which is a pure binding
 * resolution — no KV I/O. The prior shape did one KV GET + one KV PUT
 * per health check with a `health-probe:${Date.now()}` key, which was
 * billable + polluted the namespace forever.
 *
 * R22-H-4: no longer reads module-level diagnostics state. The probe
 * returns a snapshot scoped to THIS request.
 *
 * R23-H-3 + R23-L-3: the PUBLIC endpoint now only returns a minimal
 * {status, rateLimitKv.bindingAvailable} shape — no error strings, no
 * per-subsystem detail. Detailed diagnostics (including the raw
 * OpenNext error string and subsystem-specific state) moved to
 * `/api/admin/health` behind admin auth so attackers can't probe
 * subsystem health to time attacks. Also sets Cache-Control: no-store
 * so a misconfigured CDN can't cache a transient error response.
 *
 * @tags system
 * @description Health check endpoint (public, minimal)
 */
const NO_STORE_HEADERS = { "Cache-Control": "no-store, private, max-age=0" };

export async function GET(req: NextRequest) {
  // R32-M-health-RL: per-IP rate-limit the DB-hitting GET variant.
  // Prior shape was unauthenticated + unlimited; a flood of 1000
  // req/s would hammer Postgres with `SELECT 1`. Monitoring clients
  // should use HEAD (which is DB-free) for high-frequency probes.
  const clientIp = clientIpFrom(req.headers) || "unknown";
  const rl = checkRateLimit(`health-get:${clientIp}`, { maxAttempts: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate-limited" },
      { status: 429, headers: NO_STORE_HEADERS },
    );
  }
  const kvProbe = await probeKvBinding();

  try {
    // pg_stat_activity is a heavier but more realistic probe than SELECT 1 —
    // it verifies the DB can actually process a query under load, not just that
    // the connection is alive.
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT 1 AS check, now() AS ts LIMIT 1`
    );
    if (rows[0]?.check !== 1) {
      return NextResponse.json(
        { status: "degraded" },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    // R23-H-3: minimal public shape. `bindingAvailable` is a single
    // boolean that ops alerting needs; it does NOT leak error strings
    // or recon signal beyond "KV is up or down". Full diagnostics live
    // at /api/admin/health.
    return NextResponse.json(
      {
        status: "ok",
        rateLimitKv: { bindingAvailable: kvProbe.bindingAvailable },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    console.error("[health] DB check failed:", safeErr(err));
    return NextResponse.json(
      { status: "unhealthy" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

/**
 * HEAD /api/health
 * Client-side `useOnlineStatus` polls this every 30-60s. DON'T hit the DB on
 * the hot path — a transient DB hiccup flips every register to "offline"
 * and puts the POS into degraded mode. The purpose of this probe from the
 * client's perspective is "is the Worker reachable?", not "is Postgres up?"
 * The GET variant still does the full DB check for uptime monitors.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
