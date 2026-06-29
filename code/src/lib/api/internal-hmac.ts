import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const WINDOW_MS = 60_000;
const HEX_64 = /^[0-9a-f]{64}$/i;

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type InternalHmacResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

export async function requireInternalHmac(
  req: NextRequest,
  secret: string | undefined,
  notConfiguredMessage: string,
): Promise<InternalHmacResult> {
  if (!secret || secret.length < 32) {
    return {
      ok: false,
      response: NextResponse.json({ error: notConfiguredMessage }, { status: 503 }),
    };
  }

  const tsHeader = req.headers.get("x-internal-timestamp") ?? "";
  const sigHeader = req.headers.get("x-internal-signature") ?? "";
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WINDOW_MS) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Timestamp out of window" }, { status: 401 }),
    };
  }
  if (!HEX_64.test(sigHeader)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid signature" }, { status: 401 }),
    };
  }

  const body = await req.text();
  const bodyHash = await sha256Hex(body);
  const payload = [req.method.toUpperCase(), req.nextUrl.pathname, tsHeader, bodyHash].join("\n");
  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqual(expected.toLowerCase(), sigHeader.toLowerCase())) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid signature" }, { status: 401 }),
    };
  }

  return { ok: true };
}
