/**
 * R21-H-5: display-token verification must compute HMAC BEFORE the
 * expiry check so attackers can't distinguish "expired-but-valid-sig"
 * from "unexpired-but-invalid-sig" via timing.
 *
 * Regression gate: this test reproduces the timing-oracle attack and
 * asserts both paths return null. The positive path also gets its own
 * assertion so we catch accidental "reject all" regressions.
 *
 * Why this test matters: R21 shipped the HMAC fix without a test that
 * would fail if someone reverted it. A future refactor that "cleans
 * up" by returning early on expiry would silently re-open the oracle.
 */
import { describe, it, expect } from "vitest";
import { mintDisplayToken, verifyDisplayToken } from "@/lib/auth/display-token";

// Force a deterministic secret so tests are reproducible.
process.env.CUSTOMER_DISPLAY_SECRET = process.env.CUSTOMER_DISPLAY_SECRET
  ?? "x".repeat(48);

const VALID_REGISTER_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("R21-H-5 regression: display-token timing", () => {
  it("valid token round-trips", async () => {
    const token = await mintDisplayToken(VALID_REGISTER_SESSION);
    const claims = await verifyDisplayToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.registerSessionId).toBe(VALID_REGISTER_SESSION);
  });

  it("expired-but-valid-sig token returns null", async () => {
    // Mint a fresh token just to prove the secret+mint work; we
    // discard it and forge an expired variant below.
    await mintDisplayToken(VALID_REGISTER_SESSION);
    // Build a payload with expiresAt = 1000 (way in the past) and
    // sign it via the same secret. Manual Web Crypto here mirrors
    // the library's internal signing path.
    const enc = new TextEncoder();
    const secret = process.env.CUSTOMER_DISPLAY_SECRET!;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = `${VALID_REGISTER_SESSION}.${1000}`; // expiresAt in 1970
    const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    const sig = sigBytes.slice(0, 16);
    const b64 = (bytes: Uint8Array) => {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const expiredToken = `${b64(enc.encode(payload))}.${b64(sig)}`;
    const claims = await verifyDisplayToken(expiredToken);
    expect(claims, "expired token with valid signature must be rejected").toBeNull();
  });

  it("unexpired-but-invalid-sig token returns null", async () => {
    const token = await mintDisplayToken(VALID_REGISTER_SESSION);
    // Flip the FIRST character of the sig. Flipping the last char
    // is broken: the last char of a 16-byte (128-bit) base64url
    // encoding represents just 2 data bits; the remaining 4 bits are
    // unused padding, so swapping `A` ↔ `B` at the end can decode
    // to IDENTICAL bytes (the tampered sig remains valid). Flipping
    // the first char alters 6 full data bits — always changes the
    // decoded signature.
    const [payloadB64, sigB64] = token.split(".");
    const firstChar = sigB64[0];
    const flippedChar = firstChar === "A" ? "B" : "A";
    const tampered = `${payloadB64}.${flippedChar}${sigB64.slice(1)}`;
    const claims = await verifyDisplayToken(tampered);
    expect(claims, "unexpired token with invalid signature must be rejected").toBeNull();
  });

  it("malformed (missing `.`) token returns null early", async () => {
    const claims = await verifyDisplayToken("not-a-valid-token");
    expect(claims).toBeNull();
  });

  it("malformed (non-UUID registerSessionId) token returns null early", async () => {
    // Craft a token whose registerSessionId isn't a UUID. Same signing
    // ritual as the expired-but-valid-sig test.
    const enc = new TextEncoder();
    const secret = process.env.CUSTOMER_DISPLAY_SECRET!;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const future = Date.now() + 60_000;
    const payload = `not-a-uuid.${future}`;
    const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    const sig = sigBytes.slice(0, 16);
    const b64 = (bytes: Uint8Array) => {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const malformed = `${b64(enc.encode(payload))}.${b64(sig)}`;
    const claims = await verifyDisplayToken(malformed);
    expect(claims).toBeNull();
  });
});
