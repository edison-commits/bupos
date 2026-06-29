import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  checkKvRateLimit: vi.fn(),
  checkDbRateLimit: vi.fn(),
  orgTx: vi.fn(),
  invalidateStoreCache: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}));

vi.mock("@/lib/auth/kv-rate-limit", () => ({
  checkKvRateLimit: (...args: unknown[]) => mocks.checkKvRateLimit(...args),
}));

vi.mock("@/lib/auth/db-rate-limit", () => ({
  checkDbRateLimit: (...args: unknown[]) => mocks.checkDbRateLimit(...args),
}));

vi.mock("@/lib/supabase-rest", () => ({
  orgTx: (...args: unknown[]) => mocks.orgTx(...args),
}));

vi.mock("@/lib/persistence/postgres-read-store", () => ({
  invalidateStoreCache: (...args: unknown[]) => mocks.invalidateStoreCache(...args),
}));

vi.mock("@/lib/uuid", () => ({
  randomUUID: () => mocks.randomUUID(),
}));

const { POST } = await import("@/app/api/customer-self-signup/route");

function makeRequest(body: object, ip = "203.0.113.10") {
  return new NextRequest("http://localhost/api/customer-self-signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  firstName: "  Ada ",
  lastName: " Lovelace ",
  email: "ada@example.com",
  phone: "",
  marketingOptIn: true,
  preferences: [
    {
      category: " Scrub tops ",
      size_label: " M ",
      fit_preference: " Relaxed ",
      preferred_colors: [" Teal "],
      preferred_brands: [" WonderWink "],
      style_notes: " Likes stretch fabric ",
    },
  ],
};

describe("POST /api/customer-self-signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUPOS_ORG_ID = "org-1";
    delete process.env.TRUST_FORWARDED_FOR;
    mocks.checkRateLimit.mockReturnValue({ allowed: true });
    mocks.checkKvRateLimit.mockResolvedValue({ allowed: true, attempts: 1, retryAfterMs: 0 });
    mocks.checkDbRateLimit.mockResolvedValue({ allowed: true, attempts: 1, retryAfterMs: 0 });
    mocks.randomUUID
      .mockReturnValueOnce("customer-1")
      .mockReturnValueOnce("audit-1");
  });

  it("returns 503 without touching rate limits or the database when public signup is not configured", async () => {
    delete process.env.BUPOS_ORG_ID;

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Customer signup is not configured." });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.orgTx).not.toHaveBeenCalled();
  });

  it("rate-limits by organization and client IP before accepting public writes", async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 60_000 });

    const response = await POST(makeRequest(validBody, "198.51.100.44"));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many signups. Try again shortly." });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("customer-self-signup:org-1:198.51.100.44", {
      maxAttempts: 10,
      windowMs: 60_000,
    });
    expect(mocks.orgTx).not.toHaveBeenCalled();
  });

  it("does not let spoofable forwarded-for headers rotate the public signup rate-limit bucket by default", async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 60_000 });

    const response = await POST(new NextRequest("http://localhost/api/customer-self-signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99",
        origin: "http://localhost",
      },
      body: JSON.stringify(validBody),
    }));

    expect(response.status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("customer-self-signup:org-1:unknown", {
      maxAttempts: 10,
      windowMs: 60_000,
    });
    expect(mocks.orgTx).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before opening a database transaction", async () => {
    const response = await POST(new NextRequest("http://localhost/api/customer-self-signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
        origin: "http://localhost",
      },
      body: "{not json",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON payload." });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("customer-self-signup:org-1:203.0.113.10", {
      maxAttempts: 10,
      windowMs: 60_000,
    });
    expect(mocks.orgTx).not.toHaveBeenCalled();
    expect(mocks.invalidateStoreCache).not.toHaveBeenCalled();
  });

  it("rejects submissions without email or phone before opening a database transaction", async () => {
    const response = await POST(makeRequest({
      ...validBody,
      email: "",
      phone: "",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Email or phone is required." });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("customer-self-signup:org-1:203.0.113.10", {
      maxAttempts: 10,
      windowMs: 60_000,
    });
    expect(mocks.orgTx).not.toHaveBeenCalled();
    expect(mocks.invalidateStoreCache).not.toHaveBeenCalled();
  });

  it("rejects oversized preference payloads before opening a database transaction", async () => {
    const response = await POST(makeRequest({
      ...validBody,
      preferences: Array.from({ length: 13 }, (_, index) => ({
        category: `Category ${index}`,
      })),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "preferences: Too big: expected array to have <=12 items" });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("customer-self-signup:org-1:203.0.113.10", {
      maxAttempts: 10,
      windowMs: 60_000,
    });
    expect(mocks.orgTx).not.toHaveBeenCalled();
    expect(mocks.invalidateStoreCache).not.toHaveBeenCalled();
  });

  it("creates a customer, upserts preferences, writes audit, commits, releases, and invalidates the store cache", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    mocks.orgTx.mockResolvedValueOnce({ query, release });

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.orgTx).toHaveBeenCalledWith("org-1");
    expect(query.mock.calls[0][0]).toContain("SELECT id FROM customers");
    expect(query.mock.calls[1][0]).toContain("INSERT INTO customers");
    expect(query.mock.calls[1][1]).toEqual([
      "customer-1",
      "org-1",
      "Ada",
      "Lovelace",
      "ada@example.com",
      null,
      "Customer opted into marketing from self-signup.",
    ]);
    expect(query.mock.calls[2][0]).toContain("ON CONFLICT (organization_id, customer_id, category) DO UPDATE");
    expect(query.mock.calls[2][1]).toEqual([
      "org-1",
      "customer-1",
      "Scrub tops",
      "M",
      "Relaxed",
      ["Teal"],
      ["WonderWink"],
      "Likes stretch fabric",
    ]);
    expect(query.mock.calls[3][0]).toContain("customer_self_signup");
    expect(query.mock.calls[3][1]).toEqual([
      "audit-1",
      "org-1",
      "customer-1",
      JSON.stringify({ preferenceCount: 1, marketingOptIn: true, existingCustomer: false }),
    ]);
    expect(query.mock.calls[4][0]).toBe("COMMIT");
    expect(mocks.invalidateStoreCache).toHaveBeenCalledWith("org-1");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing matched customer from unauthenticated public signup", async () => {
    mocks.randomUUID.mockReset().mockReturnValueOnce("audit-existing");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "customer-existing" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    mocks.orgTx.mockResolvedValueOnce({ query, release });

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(query.mock.calls[1][0]).toContain("customer_self_signup");
    expect(query.mock.calls[1][0]).not.toContain("UPDATE customers");
    expect(query.mock.calls[1][0]).not.toContain("INSERT INTO customer_preferences");
    expect(query.mock.calls[1][1]).toEqual([
      "audit-existing",
      "org-1",
      "customer-existing",
      JSON.stringify({ preferenceCount: 1, marketingOptIn: true, existingCustomer: true }),
    ]);
    expect(query.mock.calls[2][0]).toBe("COMMIT");
    expect(mocks.invalidateStoreCache).toHaveBeenCalledWith("org-1");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the transaction client when a public write fails", async () => {
    const writeError = new Error("db unavailable");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(writeError)
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    mocks.orgTx.mockResolvedValueOnce({ query, release });

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to save customer profile." });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(mocks.invalidateStoreCache).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
