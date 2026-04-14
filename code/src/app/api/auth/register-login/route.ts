import { checkRateLimit } from "@/lib/auth/rate-limit";
import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";
import { hasPermission } from "@/lib/domain/permissions";
import type { RoleKey } from "@/lib/domain/types";

const REGISTER_COOKIE = "basicuniformpos_register_session";

function supabaseHeaders() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return {
    url: supabaseUrl,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    } as Record<string, string>,
  };
}

/** Async scrypt verify — safe for Workers (no pool import). */
async function verifyPin(secret: string, encoded: string): Promise<boolean> {
  const { scrypt, timingSafeEqual } = await import("node:crypto");
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return false;
  const KEY_LENGTH = 64;
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(secret, salt, KEY_LENGTH, (err, buf) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });
    return timingSafeEqual(derived, Buffer.from(stored, "hex"));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let pin: string | null = null;
  let locationId: string | null = null;
  let deviceId: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    pin = (formData.get("pin") as string)?.trim() ?? null;
    locationId = (formData.get("locationId") as string) ?? null;
    deviceId = (formData.get("deviceId") as string) || null;
  } else {
    const body = await request.json() as Record<string, unknown>;
    pin = ((body.pin as string) ?? "").trim() || null;
    locationId = (body.locationId as string) ?? null;
    deviceId = (body.deviceId as string) || null;
  }

  if (!pin || !locationId) {
    return Response.json({ error: "PIN and location are required." }, { status: 400 });
  }

  // Rate limiting
  const rl = checkRateLimit(`register:${locationId}`);
  if (!rl.allowed) {
    return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
  }

  // Origin validation
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const allowedOrigin = new RegExp(`^https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  if (!allowedOrigin.test(origin)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const sb = supabaseHeaders();
  if (!sb) {
    return Response.json({ error: "Auth service not configured." }, { status: 500 });
  }

  try {
    // 1. Fetch PIN candidates for this location's org
    const candidatesRes = await fetch(`${sb.url}/rest/v1/rpc/register_pin_candidates`, {
      method: "POST",
      headers: sb.headers,
      body: JSON.stringify({ p_location_id: locationId }),
    });
    if (!candidatesRes.ok) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }
    const candidates = await candidatesRes.json() as Array<{
      employee_id: string;
      email: string;
      pin_hash: string;
      organization_id: string;
      role_key: string;
      location_ids: string[];
    }>;

    if (!candidates.length) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // 2. Verify PIN against all candidates in parallel
    const results = await Promise.all(
      candidates.map(async (c) => {
        if (!c.pin_hash) return null;
        const valid = await verifyPin(pin!, c.pin_hash);
        return valid ? c : null;
      }),
    );
    const match = results.find((r) => r !== null);
    if (!match) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // 3. Validate employee permissions and location assignment
    const roleKey = match.role_key as RoleKey;
    const locationIds = match.location_ids ?? [];
    if (!locationIds.includes(locationId)) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }
    if (!hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open")) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // 4. Create session + register session atomically via RPC
    const now = new Date();
    const sessionId = randomUUID();
    const registerSessionId = randomUUID();
    const expiresAt = addDays(now, 1);

    const createRes = await fetch(`${sb.url}/rest/v1/rpc/register_login_create_session`, {
      method: "POST",
      headers: { ...sb.headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        p_employee_id: match.employee_id,
        p_organization_id: match.organization_id,
        p_location_id: locationId,
        p_device_id: deviceId,
        p_session_id: sessionId,
        p_register_session_id: registerSessionId,
        p_created_at: now.toISOString(),
        p_expires_at: expiresAt.toISOString(),
      }),
    });
    if (!createRes.ok) {
      console.error("[api/auth/register-login] create session failed:", await createRes.text());
      return Response.json({ error: "Failed to create register session." }, { status: 500 });
    }

    // Invalidate store cache
    try {
      const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
      invalidateStoreCache();
    } catch {
      // Non-fatal
    }

    // Build response with Set-Cookie
    const isSecure = request.url.startsWith("https");
    const cookieValue = [
      `${REGISTER_COOKIE}=${sessionId}`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Expires=${expiresAt.toUTCString()}`,
      ...(isSecure ? ["Secure"] : []),
    ].join("; ");

    return Response.json(
      {
        success: true,
        redirect: "/register",
        sessionId,
        registerSessionId,
        expiresAt: expiresAt.toISOString(),
        employeeId: match.employee_id,
        organizationId: match.organization_id,
        roleKey: match.role_key,
        deviceId,
      },
      {
        status: 200,
        headers: { "Set-Cookie": cookieValue },
      },
    );
  } catch (err) {
    console.error("[api/auth/register-login] Error:", err);
    return Response.json({ error: "PIN login failed." }, { status: 401 });
  }
}
