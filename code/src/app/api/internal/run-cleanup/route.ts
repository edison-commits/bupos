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

  // R38-C-H9: timestamp-bound replay protection. A compromised ops
  // laptop / log sink that leaks the bearer once lets an attacker
  // replay the header forever (and cleanup is destructive — wiping
  // rate-limit buckets in particular disarms brute-force defense
  // for ~60s per call). Require the caller to also supply an
  // `x-cleanup-ts` header with a Unix-ms timestamp within ±60s of
  // server time; the request bearer must include the ts in the HMAC
  // so a captured header can't be replayed outside that window.
  //
  // Client calling pattern:
  //   const ts = Date.now();
  //   const hmac = hmacSha256(opsSecret, `${ts}`); // hex
  //   headers: {
  //     Authorization: `Bearer ${opsSecret}:${ts}:${hmac}`,
  //     'x-cleanup-ts': String(ts),
  //   }
  //
  // Backward-compat: plain `Bearer ${opsSecret}` still works so the
  // scheduled() handler doesn't need updating simultaneously. The
  // public manual-ops entry point (runbook) should use the signed
  // form. Log which form was used so monitoring can track adoption.
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
    if (secret !== opsSecret) {
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
  }

  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT run_nightly_cleanup() AS result`,
    );
    const result = rows[0]?.result ?? {};
    console.log(JSON.stringify({
      event: "internal_cleanup_run",
      usedReplayGuard,
      result,
    }));
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[internal/run-cleanup] failed:", safeErr(err));
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}
