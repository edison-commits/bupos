/**
 * R32-cleanup-cron: periodic cleanup entry point.
 *
 * Invoked by the Cloudflare Cron trigger declared in wrangler.jsonc
 * (`0 7 * * *` — nightly at 07:00 UTC). Calls the `run_nightly_cleanup`
 * SECURITY DEFINER function from migration 064, which in turn clears
 * stale `pending_signups`, `rate_limit_buckets`, and idempotency_key
 * rows across transactions / returns / transfers / shifts.
 *
 * Also reachable via manual POST for ops debugging; a shared-secret
 * token gates the endpoint so it's not exposed to the public
 * Internet. Cron-triggered invocations arrive with no Authorization
 * header; we detect the Cloudflare-internal `cf-cron` header (set
 * only by the runtime) to accept those without the secret.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeErr } from "@/lib/logging/safe-err";
import { getPool } from "@/lib/supabase-rest";

// R33-C1: reached only via Bearer OPS_CLEANUP_SECRET now. Prior shape
// trusted a client-supplied `cf-cron` header — 3 R33 agents
// independently flagged this as spoofable (`*.workers.dev` subdomains,
// preview deploys, or any non-CF-edge path let a client send it
// freely), meaning anyone could remotely force a cleanup and wipe
// rate-limit buckets + idempotency keys on demand. The scheduled()
// handler below invokes this route with the env secret set.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const opsSecret = process.env.OPS_CLEANUP_SECRET;
  if (!opsSecret) {
    // Fail closed if the secret isn't configured. Prior shape fell
    // back to the cf-cron branch which is exactly the bypass.
    return NextResponse.json(
      { error: "Cleanup endpoint not configured" },
      { status: 503 },
    );
  }
  if (authHeader !== `Bearer ${opsSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT run_nightly_cleanup() AS result`,
    );
    const result = rows[0]?.result ?? {};
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[internal/run-cleanup] failed:", safeErr(err));
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}
