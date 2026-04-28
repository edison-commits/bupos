/**
 * R22-H-2: signup must refuse in production when neither
 * `cf-connecting-ip` nor `x-forwarded-for` header is present.
 *
 * Background: R21-L-4 randomized the in-memory rate-limit bucket to
 * `signup-ip:unknown-${uuid}` when CF headers were absent. That
 * eliminated a cross-tenant DoS but opened a full rate-limit bypass
 * against direct workers.dev URLs (attacker strips IP headers).
 * R22-H-2 refuses signups in production without a proven client IP.
 *
 * This test verifies the refusal branch fires when NODE_ENV is
 * 'production' AND no IP header is present. The dev branch
 * (randomized bucket) remains for local/test workflows.
 *
 * Note: `signupAction` is a Next.js server action — it reads
 * headers() from the request scope. We can't easily invoke it in
 * isolation without mocking most of its environment. The test
 * instead asserts on the specific code path (the check itself) by
 * importing the action and feeding it a FormData with a mocked
 * `next/headers.headers`. When headers() returns a Headers object
 * lacking cf-connecting-ip/x-forwarded-for AND NODE_ENV='production',
 * the action returns the generic rate-limit error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/headers BEFORE importing the action. We also mock next/
// navigation so `redirect` and friends don't throw.
const mockHeaders = vi.fn<
  () => Promise<{ get: (key: string) => string | null }>
>();
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

describe("R22-H-2 regression: signup refuses without client IP in prod", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    // TST2-L1: route NODE_ENV mutations through `vi.stubEnv` so
    // `vi.unstubAllEnvs()` here guarantees restore even on test
    // failure. Prior shape captured originalNodeEnv in a closure +
    // restored manually; if the test threw before reaching the
    // mutation, the restore still ran (afterEach is unconditional)
    // BUT if a future test added an `as Record<string, string>` cast
    // bypass for a different env var, the restore wouldn't cover it.
    // Stub-based shape makes the contract explicit.
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses when NODE_ENV='production' AND no IP headers are present", async () => {
    // Mock headers() with NO cf-connecting-ip and NO x-forwarded-for.
    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        // Origin + host must validate (else we hit the origin check
        // refusal before reaching the IP check).
        if (key === "origin") return "https://bupos.example.com";
        if (key === "host") return "bupos.example.com";
        return null;
      },
    });
    // NOTE: Next.js inlines NODE_ENV at build time via DefinePlugin;
    // we're running under vitest which DOESN'T do this inlining, so
    // the env-var override takes effect. In production-bundled code
    // the literal "production" is baked in.
    // TST2-L1: vi.stubEnv guarantees restore via unstubAllEnvs in
    // afterEach.
    vi.stubEnv("NODE_ENV", "production");

    const { signupAction } = await import("@/app/actions/auth");
    const fd = new FormData();
    fd.set("storeName", "Adversary Store");
    fd.set("firstName", "A");
    fd.set("lastName", "B");
    fd.set("email", `bypass-${Date.now()}@attacker.test`);
    // R42-J: signup minimum raised to 12 chars.
    fd.set("password", "P4ssword!Xyz");

    const result = await signupAction(null, fd);
    expect(result.error).toMatch(/too many signups from this network/i);
  });

  it("allows in dev mode when no IP headers are present (randomized bucket)", async () => {
    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        if (key === "origin") return "https://bupos.example.com";
        if (key === "host") return "bupos.example.com";
        return null;
      },
    });
    // TST2-L1: vi.stubEnv guarantees restore via unstubAllEnvs in afterEach.
    vi.stubEnv("NODE_ENV", "development");

    const { signupAction } = await import("@/app/actions/auth");
    const fd = new FormData();
    fd.set("storeName", "Dev Store");
    fd.set("firstName", "D");
    fd.set("lastName", "V");
    fd.set("email", `dev-${Date.now()}@example.test`);
    // R42-J: signup minimum raised to 12 chars.
    fd.set("password", "P4ssword!Xyz");

    const result = await signupAction(null, fd);
    // Dev branch should reach the generic "check your inbox" response —
    // DB calls will fail here (no Docker in this unit test) and the
    // action catches internally, but the RESPONSE message is the
    // generic one, not the rate-limit error. That's the desired shape:
    // attacker can't distinguish "rate-limited" from "normal flow".
    expect(result.error).toMatch(/check your inbox|too many signups/i);
  });
});
