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

const WINDOW_MS = 60_000; // 1 minute
const MAX_ATTEMPTS = 5;   // 5 attempts per window
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
 */
export function checkRateLimit(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
  cleanup();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= MAX_ATTEMPTS) {
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
  }

  entry.timestamps.push(now);
  return { allowed: true };
}
