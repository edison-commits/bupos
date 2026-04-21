/**
 * Simple sliding-window rate limiter.
 *
 * On Cloudflare Workers each isolate has its own memory, so this provides
 * per-instance brute-force protection. A persistent layer (KV / D1) can
 * be added later for cross-instance enforcement.
 *
 * TODO (H-03): This in-memory implementation is per-isolate only.
 * For production multi-instance deployments on Cloudflare Workers,
 * migrate to Cloudflare KV or D1 for distributed rate limiting.
 */

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

const WINDOW_MS = 300_000; // 5 minutes — wider window to slow PIN brute-force
const MAX_ATTEMPTS = 3;    // 3 attempts per window (stricter for 4-digit PINs)
const CLEANUP_INTERVAL = 120_000; // purge stale keys every 2 min

let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  const cutoff = now - WINDOW_MS;
  for (const [key, entry] of windows) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) windows.delete(key);
  }
}

/**
 * Check if the given key is rate-limited.
 * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
 *
 * Options let the caller override window/attempts — e.g. PIN login uses a
 * strict per-cashier-attempt bucket plus a more generous per-location bucket
 * so a few mistypes don't lock out the whole register.
 */
export function checkRateLimit(
  key: string,
  opts?: { windowMs?: number; maxAttempts?: number },
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  cleanup();
  const now = Date.now();
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const maxAttempts = opts?.maxAttempts ?? MAX_ATTEMPTS;
  const cutoff = now - windowMs;

  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= maxAttempts) {
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
  }

  entry.timestamps.push(now);
  return { allowed: true };
}
