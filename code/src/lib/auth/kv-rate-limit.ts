/**
 * R8-M-11 closed (Cloudflare KV layer): cross-isolate rate limiting.
 *
 * The in-memory `@/lib/auth/rate-limit` limiter is per-isolate; Workers
 * spreads requests across ~32 isolates per colo so a brute-forcer gets
 * ~32× the budget. KV gives us cross-region (eventually-consistent ~60s)
 * coherence at ~5-20ms latency per check — cheaper than DB (~30-100ms)
 * but not instantaneous.
 *
 * Layering (apply in this order per auth endpoint):
 *   1. In-memory `checkRateLimit` — catches per-isolate bursts (0ms).
 *   2. This KV check — catches distributed attacks spanning isolates
 *      (~5-20ms, eventually consistent).
 *   3. `checkDbRateLimit` — strongly-consistent last-resort for the
 *      highest-value endpoints (e.g. PIN login).
 *
 * Fails open when the KV binding is absent — covers local dev, tests,
 * and transient binding outages. The DB + in-memory layers remain as
 * backstops so fail-open doesn't leave auth fully unprotected.
 */

import { safeErr } from "@/lib/logging/safe-err";

export interface KvRateLimitResult {
  allowed: boolean;
  attempts: number;
  retryAfterMs: number;
}

type KVNamespace = {
  get(key: string, type?: "text" | "json"): Promise<string | null | Record<string, unknown>>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

interface BucketState {
  windowStart: number;
  attempts: number;
}

// R22-H-4: module-scope state on Workers is shared across concurrent
// requests in the same isolate. The prior shape kept a mutable
// `lastLookupError` field that was overwritten by EVERY lookup and
// surfaced in `/api/health` responses — that leaked per-request error
// detail across tenants (one org's auth failure bleeding into another's
// health probe response).
//
// Fix: keep only a SINGLE strictly monotonic flag —
// `_warnedProdFailOpenOnce` — which governs whether the cold-start log
// has fired. Any `lastLookupError` telemetry is now local to the call
// that produced it and is returned in the probe result, not stashed on
// the module.
//
// R23-M-4: previously also exported `__resetKvDiagnosticsForTest`
// with zero callers — removed. Add back when an actual test needs it.
let _warnedProdFailOpenOnce = false;

// R23-L-2: cache the module resolution so cold-start only does the
// @opennextjs/cloudflare graph resolution once per isolate.
type CloudflareModule = typeof import("@opennextjs/cloudflare");
let _cfModulePromise: Promise<CloudflareModule | null> | null = null;
function loadCloudflareModule(): Promise<CloudflareModule | null> {
  if (_cfModulePromise) return _cfModulePromise;
  _cfModulePromise = import("@opennextjs/cloudflare")
    .then((mod) => mod)
    .catch(() => null);
  return _cfModulePromise;
}

export interface KvBindingProbe {
  /** True when `RATE_LIMIT_KV` resolved on this probe. */
  bindingAvailable: boolean;
  /** If lookup THREW, the redacted error. Null on binding-absent (silent) or success. */
  lastLookupError: string | null;
}

async function resolveKvBinding(): Promise<{ binding: KVNamespace | null; probe: KvBindingProbe }> {
  try {
    // OpenNext exposes bindings via getCloudflareContext(). In dev /
    // tests / Node, the import resolves but the context is unavailable —
    // catch + fail-open, but log the specific reason.
    const mod = await loadCloudflareModule();
    if (!mod) {
      return { binding: null, probe: { bindingAvailable: false, lastLookupError: null } };
    }
    const ctx = await mod.getCloudflareContext({ async: true });
    const binding = (ctx?.env as { RATE_LIMIT_KV?: KVNamespace } | undefined)?.RATE_LIMIT_KV ?? null;

    // One-shot cold-start warning: prod is running without the KV layer.
    // Ops should treat this as "alert-worthy" — the 3-layer rate limit
    // has silently degraded to 2-layer. Most common cause: the binding
    // was renamed or its KV namespace ID changed in wrangler.jsonc.
    //
    // R22-H-4: race on `_warnedProdFailOpenOnce` is benign — two
    // concurrent requests in the same isolate may both log the warning,
    // which is fine; neither leaks cross-request state.
    if (!binding && process.env.NODE_ENV === "production" && !_warnedProdFailOpenOnce) {
      _warnedProdFailOpenOnce = true;
      console.warn(
        "[checkKvRateLimit] prod cold-start: RATE_LIMIT_KV binding NOT resolvable. Three-layer rate limiter has degraded to two-layer (in-memory + DB). Verify wrangler.jsonc `kv_namespaces[].binding = 'RATE_LIMIT_KV'` and the namespace id.",
      );
    }

    return { binding, probe: { bindingAvailable: !!binding, lastLookupError: null } };
  } catch (err) {
    // Lookup THREW (not just "binding absent"). Most common cause: the
    // OpenNext import path changed after a runtime upgrade. Log noisily
    // so CI / ops notice instead of silently failing open.
    console.error("[checkKvRateLimit] getCloudflareContext threw; KV layer disabled:", safeErr(err));
    const errStr = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    return { binding: null, probe: { bindingAvailable: false, lastLookupError: errStr } };
  }
}

/**
 * R22-M-2: dedicated probe for `/api/health` that resolves the binding
 * without touching KV I/O (no GET, no PUT). Previously the health
 * endpoint ran `checkKvRateLimit('health-probe:${Date.now()}', ...)`
 * on every request, which did one KV GET + one KV PUT per probe with
 * a never-reused key — billable writes, 2-minute TTL keys accumulating
 * in the namespace forever.
 *
 * The new probe only resolves the binding (zero KV I/O) and returns
 * the same shape so callers can act on `bindingAvailable`.
 */
export async function probeKvBinding(): Promise<KvBindingProbe> {
  const { probe } = await resolveKvBinding();
  return probe;
}

/**
 * Atomically increment a KV bucket + check limit.
 *
 * Note: KV doesn't support true atomic increments. We do a read-modify-
 * write which can race under contention — two simultaneous attempts may
 * both observe the same count and both pass. Acceptable because (a) the
 * in-memory limiter above already gated bursts within each isolate, (b)
 * our windows are minutes not seconds so lost updates matter less than
 * they would for a per-request throttle. For stricter guarantees use
 * `checkDbRateLimit` (Postgres UPSERT with FOR UPDATE).
 */
export async function checkKvRateLimit(
  bucketKey: string,
  opts?: { maxAttempts?: number; windowMs?: number },
): Promise<KvRateLimitResult> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const windowMs = opts?.windowMs ?? 300_000;

  const { binding: kv } = await resolveKvBinding();
  if (!kv) {
    // Binding unavailable (dev / tests). Fall through; caller should
    // still have in-memory / DB layers protecting.
    return { allowed: true, attempts: 0, retryAfterMs: 0 };
  }

  const key = `rl:${bucketKey}`;
  const now = Date.now();

  try {
    const raw = await kv.get(key, "json");
    let state: BucketState;
    if (raw && typeof raw === "object" && "windowStart" in raw && "attempts" in raw) {
      const prev = raw as unknown as BucketState;
      // Window elapsed → reset
      if (now - prev.windowStart > windowMs) {
        state = { windowStart: now, attempts: 1 };
      } else {
        state = { windowStart: prev.windowStart, attempts: prev.attempts + 1 };
      }
    } else {
      state = { windowStart: now, attempts: 1 };
    }

    // TTL a bit beyond the window so expired buckets self-clean.
    const expirationTtl = Math.max(60, Math.ceil(windowMs / 1000) + 60);
    await kv.put(key, JSON.stringify(state), { expirationTtl });

    const retryAfterMs = Math.max(0, windowMs - (now - state.windowStart));
    return {
      allowed: state.attempts <= maxAttempts,
      attempts: state.attempts,
      retryAfterMs,
    };
  } catch (err) {
    // KV hiccup → fail open. The in-memory + DB layers still protect.
    console.warn("[checkKvRateLimit] fail-open:", safeErr(err));
    return { allowed: true, attempts: 0, retryAfterMs: 0 };
  }
}
