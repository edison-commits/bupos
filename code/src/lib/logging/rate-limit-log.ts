/**
 * R43-M: shared structured-log emitter for rate-limit 429 denials.
 *
 * Prior shape returned 429 silently — a distributed credential-stuffing
 * campaign left zero evidence in Worker logs beyond the app's own
 * access log. Logpush / Axiom queries like
 *   event:"rate_limited" bucket:"admin-login:*" | count over time
 * are the primary way ops detects a stuffing flood; without an
 * emitted event line the alerting query matches nothing.
 *
 * Emit ONE JSON line per denial. Keep the bucket key high-cardinality
 * but don't include PII (no full email, no raw PIN). A prefix or hash
 * fingerprint is fine.
 */

export interface RateLimitedEvent {
  /** The bucket category (e.g. "admin-login", "register-pin"). */
  bucket: string;
  /** The layer that tripped: "mem" | "kv" | "db". */
  layer: "mem" | "kv" | "db";
  /** Optional coarse identifier — IP prefix, email prefix, etc. Never raw. */
  actor?: string;
  /** Optional retry-after hint in milliseconds. */
  retryAfterMs?: number;
}

export function logRateLimited(event: RateLimitedEvent): void {
  try {
    console.warn(
      JSON.stringify({
        level: "warn",
        at: new Date().toISOString(),
        event: "rate_limited",
        bucket: event.bucket,
        layer: event.layer,
        actor: event.actor,
        retryAfterMs: event.retryAfterMs,
      }),
    );
  } catch {
    // Never throw from a logging helper.
  }
}
