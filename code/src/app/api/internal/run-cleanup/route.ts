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
// R42-E: constant-time byte comparison for bearer-token equality. A
// plain `!==` short-circuits on the first mismatching byte, leaking
// the secret one character at a time over network-timing-measurable
// calls (the endpoint wipes rate_limit_buckets on success; disarming
// brute-force defense + log-replay protection for ~60s per call is a
// meaningful attacker reward).
function bearerMatches(authHeader: string, expected: string): boolean {
  const a = new TextEncoder().encode(authHeader);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const opsSecret = process.env.OPS_CLEANUP_SECRET;
  // R42-E: require secrets of at least 32 chars so the constant-time
  // compare has meaningful entropy and so an offline brute-force on a
  // leaked configuration string takes real effort. Defense-in-depth
  // with the timing-safe compare below; the bearer is only valid if
  // the operator provisioned a strong secret to begin with.
  if (!opsSecret || opsSecret.length < 32) {
    // Fail closed if the secret isn't configured. Prior shape fell
    // back to the cf-cron branch which is exactly the bypass.
    return NextResponse.json(
      { error: "Cleanup endpoint not configured" },
      { status: 503 },
    );
  }
  // R45-H (NEW H2): branch on x-cleanup-ts FIRST so the signed form
  // can reach the replay-guard branch. Prior ordering had the plain-
  // bearer length-check at line 59 reject any Authorization header
  // that wasn't EXACTLY `Bearer <opsSecret>` — the signed form
  // `Bearer <secret>:<ts>:<hex>` (~68 bytes longer) always failed
  // the length equality inside `bearerMatches` and returned 401,
  // making the replay-guard below structurally UNREACHABLE. Now:
  //   - `x-cleanup-ts` present → require signed-bearer + HMAC
  //   - `x-cleanup-ts` absent → accept plain `Bearer <opsSecret>`
  // This preserves backward-compat for the cron trigger (which sends
  // plain) while actually enforcing R38-C-H9's replay protection on
  // any client that includes the timestamp header.
  //
  // R38-C-H9: timestamp-bound replay protection. A compromised ops
  // laptop / log sink that leaks the bearer once lets an attacker
  // replay the header forever (and cleanup is destructive — wiping
  // rate-limit buckets disarms brute-force defense for ~60s per call).
  //
  // Client calling pattern (signed form):
  //   const ts = Date.now();
  //   const hmac = hmacSha256(opsSecret, `${ts}`); // hex
  //   headers: {
  //     Authorization: `Bearer ${opsSecret}:${ts}:${hmac}`,
  //     'x-cleanup-ts': String(ts),
  //   }
  const tsHeader = req.headers.get("x-cleanup-ts");
  let usedReplayGuard = false;
  if (tsHeader) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) {
      return NextResponse.json({ error: "Timestamp out of window" }, { status: 401 });
    }
    // `authHeader` is "Bearer <secret>:<ts>:<hex>"
    const match = /^Bearer (.+):(\d+):([0-9a-f]{64})$/.exec(authHeader);
    if (!match || match[2] !== tsHeader) {
      return NextResponse.json({ error: "Invalid signed bearer" }, { status: 401 });
    }
    const [, secret, _ts, providedHex] = match;
    // R42-E: constant-time compare on the secret portion.
    if (!bearerMatches(secret, opsSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const expected = new Uint8Array(
      await (async () => {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw", enc.encode(opsSecret),
          { name: "HMAC", hash: "SHA-256" },
          false, ["sign"],
        );
        return crypto.subtle.sign("HMAC", key, enc.encode(tsHeader));
      })(),
    );
    const expectedHex = Array.from(expected).map((b) => b.toString(16).padStart(2, "0")).join("");
    // Constant-time compare (length-equal guaranteed above).
    let diff = 0;
    for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
    if (diff !== 0) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    usedReplayGuard = true;
  } else {
    // No timestamp → plain bearer (backward-compat for cron trigger).
    if (!bearerMatches(authHeader, `Bearer ${opsSecret}`)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT run_nightly_cleanup() AS result`,
    );
    const result = rows[0]?.result ?? {};
    // OPS-LOW4: project to a known whitelist before logging. The pg
    // function returns aggregate counts today, but a future migration
    // could evolve the JSONB shape (e.g. add `deleted_session_ids: [...]`
    // for diagnostics) and that PII would land in 30-day Worker logs.
    // Pin the projection here; the API response still returns the full
    // result for the ops caller (which is the bearer-authenticated
    // cleanup secret holder, not a public client).
    const safeResult: Record<string, unknown> = {};
    if (result && typeof result === 'object') {
      // Whitelist: aggregate-count keys only (current shape). Any
      // unexpected key gets dropped from the LOG but kept in the
      // RESPONSE so ops can see the full payload.
      const KNOWN_COUNT_KEYS = new Set([
        'sessions_deleted', 'idempotency_keys_cleared',
        'pending_signups_purged', 'rate_limit_buckets_cleared',
        'audit_events_archived', 'expired_tokens_purged',
      ]);
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
        if (KNOWN_COUNT_KEYS.has(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
          safeResult[k] = v;
        }
      }
    }
    console.log(JSON.stringify({
      event: "internal_cleanup_run",
      usedReplayGuard,
      result: safeResult,
    }));
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[internal/run-cleanup] failed:", safeErr(err));
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}
