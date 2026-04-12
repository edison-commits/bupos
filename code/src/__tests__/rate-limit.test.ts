import { describe, it, expect } from "vitest";
import { checkRateLimit } from "@/lib/auth/rate-limit";

describe("Rate limiter", () => {
  it("allows requests under the limit", () => {
    const result = checkRateLimit("test:allow");
    expect(result.allowed).toBe(true);
  });

  it("blocks requests over the limit", () => {
    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test:block");
    }
    const result = checkRateLimit("test:block");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("uses separate keys independently", () => {
    // Exhaust key A
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test:separate-a");
    }
    // Key B should still work
    const result = checkRateLimit("test:separate-b");
    expect(result.allowed).toBe(true);
  });
});
