/**
 * R8-M-11 closed (partial): DB-backed rate-limit helper.
 *
 * The in-memory `@/lib/auth/rate-limit` limiter is per-isolate; Workers
 * spreads requests across ~32 isolates per colo so a brute-forcer gets
 * ~32× the budget. For cross-isolate coherence, this helper calls the
 * `rate_limit_check` RPC (migration 050). Every auth attempt incurs one
 * DB round-trip — tolerable for login paths, not for high-throughput
 * endpoints.
 *
 * Recommended usage: layer this on top of the in-memory limiter. The
 * in-memory bucket catches attacker bursts fast (sub-isolate), and the
 * DB bucket catches distributed attacks that span isolates.
 *
 * Long-term fix: Cloudflare KV or Durable Object for the general
 * limiter. This helper is a narrow backstop for auth paths where
 * coherence matters more than latency.
 */

import { getPool } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";

export interface DbRateLimitResult {
  allowed: boolean;
  attempts: number;
  retryAfterMs: number;
}

/**
 * Atomically increment the bucket + check whether the caller is allowed.
 * Failures (DB unreachable etc.) return `allowed: true` so a transient
 * Postgres outage doesn't lock out every login attempt.
 */
export async function checkDbRateLimit(
  bucketKey: string,
  opts?: { maxAttempts?: number; windowMs?: number },
): Promise<DbRateLimitResult> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const windowMs = opts?.windowMs ?? 300_000;
  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT * FROM rate_limit_check($1::text, $2::int, $3::int)`,
      [bucketKey, maxAttempts, windowMs],
    );
    const row = rows[0] as { allowed: boolean; attempts: number; retry_after_ms: number } | undefined;
    if (!row) {
      return { allowed: true, attempts: 0, retryAfterMs: 0 };
    }
    return {
      allowed: Boolean(row.allowed),
      attempts: Number(row.attempts),
      retryAfterMs: Number(row.retry_after_ms),
    };
  } catch (err) {
    // Fail-open on DB error — don't brick auth because of a transient
    // Postgres hiccup. The in-memory limiter still gates the attack
    // surface within the isolate.
    console.warn("[checkDbRateLimit] fail-open:", safeErr(err));
    return { allowed: true, attempts: 0, retryAfterMs: 0 };
  }
}
