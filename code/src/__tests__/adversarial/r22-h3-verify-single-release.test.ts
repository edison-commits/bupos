/**
 * R22-H-3: `/api/auth/verify` must release the pg client exactly
 * ONCE per request, regardless of whether the 23505 catch path
 * fires.
 *
 * Background: the original R21-C-1 follow-through had the 23505
 * catch branch call `client.release()` then `return` — which
 * unwound into the outer `finally` block that called
 * `client.release()` AGAIN. Plain pg's Client throws "Release
 * called on client which has already been released to the pool"
 * on the second call; neon's wrapper guards idempotently but races
 * with the pool's checkout accounting.
 *
 * Regression gate: mock pool.connect to return a client whose
 * release() increments a counter. Invoke the verify route in both
 * paths (success + 23505) and assert the counter is exactly 1.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track the release counter across all mocked clients spawned per
// test. Each test resets it.
const releaseCounter = { count: 0 };

class FakeClient {
  state: "fresh" | "errored" = "fresh";
  constructor(public shouldThrow23505: boolean) {}
  async query(text: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (text.startsWith("DELETE FROM pending_signups")) {
      // Pretend we consumed a pending signup.
      return {
        rows: [
          {
            email: "x@y.z",
            store_name: "Test",
            first_name: "a",
            last_name: "b",
            password_hash: "h",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith("INSERT INTO organizations")) return { rows: [], rowCount: 1 };
    if (text.startsWith("INSERT INTO locations")) return { rows: [], rowCount: 1 };
    if (text.startsWith("INSERT INTO employees")) return { rows: [], rowCount: 1 };
    if (text.startsWith("INSERT INTO auth_credentials")) {
      if (this.shouldThrow23505) {
        // After this throw, pg sets the client to an error state
        // but the outer code should still call ROLLBACK + release.
        const e = Object.assign(new Error("duplicate key"), { code: "23505" });
        throw e;
      }
      return { rows: [], rowCount: 1 };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    // Fallback for any other query (sessions INSERT, audit event insert,
    // etc.). Return empty success.
    return { rows: [], rowCount: 0 };
  }
  release(): void {
    releaseCounter.count++;
  }
}

function mockPoolFactory(shouldThrow23505: boolean) {
  return {
    connect: vi.fn(async () => new FakeClient(shouldThrow23505)),
    query: vi.fn(async (text: string) => {
      // The verify route's FIRST call is a pool.query DELETE on
      // pending_signups with RETURNING. If we return empty rows,
      // the route short-circuits and never reaches the transaction
      // under test. Return a valid pending-signup row so the flow
      // proceeds to pool.connect().
      if (text.startsWith("DELETE FROM pending_signups")) {
        return {
          rows: [
            {
              email: "x@y.z",
              store_name: "Test",
              first_name: "a",
              last_name: "b",
              password_hash: "h",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

// Reset module cache between tests so each test re-imports the route
// fresh (module-scope state or the pool singleton won't leak across).
beforeEach(() => {
  vi.resetModules();
  releaseCounter.count = 0;
});

// Mock all the ambient dependencies that the route pulls in.
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

function mockCookies() {
  vi.doMock("next/headers", () => ({
    cookies: async () => ({ set: () => {}, get: () => undefined, delete: () => {} }),
  }));
}

describe("R22-H-3 regression: verify route releases client exactly once on 23505", () => {
  it("23505 path on auth_credentials insert: release called exactly once", async () => {
    mockCookies();
    vi.doMock("@/lib/supabase-rest", () => ({
      getPool: async () => mockPoolFactory(true),
    }));
    vi.doMock("@/lib/runtime/wait-until", () => ({
      waitUntilOrAwait: async (p: Promise<unknown>) => {
        await p.catch(() => {});
      },
    }));
    // AUTH-AUDIT6-MED2 added a per-IP rate-limit preamble (mem/KV/DB) to
    // this route AFTER R22-H-3 was written. It runs BEFORE the transaction
    // and starts with `clientIpFrom(req.headers)` — and the fake req here
    // has no `.headers`, so without these mocks the route throws (or
    // short-circuits) before ever reaching pool.connect(), giving 0
    // releases. Stub the preamble to "allowed" so the test reaches the
    // single-release transaction it actually guards.
    vi.doMock("@/lib/net/client-ip", () => ({ clientIpFrom: () => "203.0.113.7" }));
    vi.doMock("@/lib/auth/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }) }));
    vi.doMock("@/lib/logging/rate-limit-log", () => ({ logRateLimited: () => {} }));
    vi.doMock("@/lib/auth/kv-rate-limit", () => ({ checkKvRateLimit: async () => ({ allowed: true }) }));
    vi.doMock("@/lib/auth/db-rate-limit", () => ({ checkDbRateLimit: async () => ({ allowed: true }) }));
    const { GET } = await import("@/app/api/auth/verify/route");
    const req = {
      nextUrl: {
        searchParams: {
          get: (k: string) => (k === "token" ? "a".repeat(32) : null),
        },
      },
      url: "https://example.test/api/auth/verify",
    } as unknown as import("next/server").NextRequest;

    try {
      await GET(req);
    } catch {
      /* redirect threw — expected */
    }
    // R22-H-3 regression: the 23505 branch used to call release()
    // directly AND let the outer finally release again = count of 2.
    // Now must be exactly 1 because the 23505 path sets the
    // `emailAlreadyRegistered` flag and lets the single `finally`
    // handle the release.
    expect(
      releaseCounter.count,
      `expected exactly 1 release on 23505 path, got ${releaseCounter.count} (regression: double-release from the catch + finally both calling release())`,
    ).toBe(1);
  });
});
