/**
 * R22-M-3 / R23-H-1 prevention: Workers-runtime smoke tests.
 *
 * Motivation: both R22-M-3 (`waitUntilOrAwait` silently falling back
 * to sync-await because of bad binding) and R23-H-1 (detached
 * `ctx.waitUntil` invocation) were "fix didn't actually work on
 * Workers" bugs that no automated test caught. A full miniflare
 * harness is heavy; these tests instead MOCK `@opennextjs/cloudflare`
 * with a fake `getCloudflareContext` that returns a controlled
 * ExecutionContext. That's enough to assert:
 *
 *   • `waitUntilOrAwait` calls `ctx.waitUntil` AS A METHOD (with
 *     `this` bound to the ExecutionContext). A detached call would
 *     throw "Illegal invocation" on Workers — we emulate that by
 *     using an ExecutionContext class whose waitUntil checks `this`.
 *
 *   • `checkKvRateLimit` reads the RATE_LIMIT_KV binding from the
 *     context and does get/put on it. A bug where the binding is
 *     looked up on the wrong key would fail silently in production —
 *     here we fail the test.
 *
 *   • `probeKvBinding` returns `{bindingAvailable: true}` when the
 *     binding is present, `false` when absent.
 *
 * These tests run in vitest's node environment with `vi.mock` of
 * `@opennextjs/cloudflare`. They complete in <100ms and catch the
 * two whole classes of Workers bugs that required two audit rounds
 * to surface.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Fake Cloudflare runtime primitives ──────────────────────────────

// Track whether `waitUntil` was invoked correctly (as a method with
// `this === ctx`). If invoked detached (`wu = ctx.waitUntil; wu(p)`),
// `this` would be undefined and our check fires.
let lastWaitUntilThis: unknown = undefined;
let lastWaitUntilPromise: Promise<unknown> | undefined = undefined;

class FakeExecutionContext {
  // Use a regular method (not arrow fn) so `this` is dynamic — matches
  // how Cloudflare's actual ExecutionContext methods behave.
  waitUntil(promise: Promise<unknown>): void {
    // `this` MUST be a FakeExecutionContext instance — emulates
    // Cloudflare's host-binding requirement. A detached call would
    // have `this === undefined` (strict mode) and we throw like CF's
    // "Illegal invocation".
    if (!(this instanceof FakeExecutionContext)) {
      throw new TypeError("Illegal invocation");
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: we assert on the bound context
    lastWaitUntilThis = this;
    lastWaitUntilPromise = promise;
  }
}

class FakeKvNamespace {
  store = new Map<string, { value: string; ttl?: number }>();
  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    // R24-L-3: honor the `type` argument like real Cloudflare KV.
    // `"text"` returns the raw string; `"json"` parses (may throw on
    // invalid JSON — matches real KV). Default (no type) returns
    // parsed JSON if parseable, else the raw string (also matches
    // KV's default behavior for put-via-JSON-stringify round-trips).
    if (type === "text") return entry.value;
    if (type === "json") return JSON.parse(entry.value);
    try {
      return JSON.parse(entry.value);
    } catch {
      return entry.value;
    }
  }
  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl });
  }
}

// Shared fake context that each test can reconfigure.
let fakeCtx:
  | { env: { RATE_LIMIT_KV?: FakeKvNamespace }; ctx: FakeExecutionContext }
  | null = null;

// Mock `@opennextjs/cloudflare`. `vi.mock` is hoisted — the factory
// returns an object whose `getCloudflareContext` reads `fakeCtx`.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async (_opts?: { async?: boolean }) => fakeCtx,
}));

// ─── Tests ────────────────────────────────────────────────────────────

describe("R23-H-1 regression: waitUntilOrAwait invokes ctx.waitUntil as a method", () => {
  beforeEach(() => {
    // R24-L-1: reset modules so wait-until.ts's module-scope flags
    // (`_warnedNoOpenNext`, `_warnedNoWaitUntil`, cached module
    // Promise) don't leak across tests. Without this, a future test
    // asserting "the warning fired" would fail because an earlier
    // test burnt the one-shot flag.
    vi.resetModules();
    lastWaitUntilThis = undefined;
    lastWaitUntilPromise = undefined;
    fakeCtx = {
      env: { RATE_LIMIT_KV: new FakeKvNamespace() },
      ctx: new FakeExecutionContext(),
    };
  });

  it("binds `this` correctly — detached-call regression would throw", async () => {
    const { waitUntilOrAwait } = await import("@/lib/runtime/wait-until");
    const work = Promise.resolve("work-done");
    await waitUntilOrAwait(work);
    expect(lastWaitUntilThis).toBe(fakeCtx?.ctx);
    expect(lastWaitUntilPromise).toBe(work);
  });

  it("falls back to synchronous await when no ExecutionContext is present", async () => {
    fakeCtx = { env: {}, ctx: undefined as unknown as FakeExecutionContext };
    const { waitUntilOrAwait } = await import("@/lib/runtime/wait-until");
    let resolved = false;
    const work = new Promise<void>((r) => setTimeout(() => {
      resolved = true;
      r();
    }, 10));
    await waitUntilOrAwait(work);
    // In fallback mode, waitUntilOrAwait awaited the promise before
    // returning, so `resolved` must be true here.
    expect(resolved).toBe(true);
    // And no spurious waitUntil recording.
    expect(lastWaitUntilThis).toBeUndefined();
  });

  it("falls back when getCloudflareContext returns null", async () => {
    fakeCtx = null;
    const { waitUntilOrAwait } = await import("@/lib/runtime/wait-until");
    let resolved = false;
    const work = new Promise<void>((r) => setTimeout(() => {
      resolved = true;
      r();
    }, 5));
    await waitUntilOrAwait(work);
    expect(resolved).toBe(true);
  });
});

describe("R22-M-2 / R22-H-4 regression: probeKvBinding reflects runtime state", () => {
  it("returns bindingAvailable: true when RATE_LIMIT_KV is present", async () => {
    fakeCtx = {
      env: { RATE_LIMIT_KV: new FakeKvNamespace() },
      ctx: new FakeExecutionContext(),
    };
    const { probeKvBinding } = await import("@/lib/auth/kv-rate-limit");
    const probe = await probeKvBinding();
    expect(probe.bindingAvailable).toBe(true);
    expect(probe.lastLookupError).toBeNull();
  });

  it("returns bindingAvailable: false when RATE_LIMIT_KV is absent", async () => {
    fakeCtx = { env: {}, ctx: new FakeExecutionContext() };
    const { probeKvBinding } = await import("@/lib/auth/kv-rate-limit");
    const probe = await probeKvBinding();
    expect(probe.bindingAvailable).toBe(false);
    expect(probe.lastLookupError).toBeNull();
  });
});

describe("R8-M-11 / R22-H-4 regression: checkKvRateLimit uses the binding correctly", () => {
  beforeEach(() => {
    fakeCtx = {
      env: { RATE_LIMIT_KV: new FakeKvNamespace() },
      ctx: new FakeExecutionContext(),
    };
  });

  it("first attempt → allowed, attempts=1", async () => {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const r = await checkKvRateLimit(`fresh-${Math.random()}`, { maxAttempts: 3, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("exceeding maxAttempts → denied", async () => {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const bucket = `cap-${Math.random()}`;
    // 3 attempts allowed; 4th must be denied.
    for (let i = 0; i < 3; i++) {
      const r = await checkKvRateLimit(bucket, { maxAttempts: 3, windowMs: 60_000 });
      expect(r.allowed).toBe(true);
    }
    const denied = await checkKvRateLimit(bucket, { maxAttempts: 3, windowMs: 60_000 });
    expect(denied.allowed).toBe(false);
    expect(denied.attempts).toBe(4);
  });

  it("binding absent → fails open (allowed=true, attempts=0)", async () => {
    fakeCtx = { env: {}, ctx: new FakeExecutionContext() };
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const r = await checkKvRateLimit(`noop-${Math.random()}`, { maxAttempts: 1, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.attempts).toBe(0);
  });
});
