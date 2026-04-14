import { checkRateLimit } from "@/lib/auth/rate-limit";
import { verifySecret } from "@/lib/auth/crypto";
import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";

const ADMIN_COOKIE = "basicuniformpos_admin_session";

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

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let email: string | null = null;
  let password: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    email = (formData.get("email") as string)?.trim().toLowerCase() ?? null;
    password = formData.get("password") as string | null;
  } else {
    const body = await request.json() as Record<string, unknown>;
    email = ((body.email as string) ?? "").trim().toLowerCase() || null;
    password = (body.password as string) ?? null;
  }

  if (!email || !password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 });
  }

  // Rate limiting
  const rl = checkRateLimit(email);
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

  // Supabase REST path — no pool import, works on Workers
  const sb = supabaseHeaders();
  if (!sb) {
    return Response.json({ error: "Auth service not configured." }, { status: 500 });
  }

  try {
    // Lookup credentials
    const lookupRes = await fetch(`${sb.url}/rest/v1/rpc/admin_login_lookup`, {
      method: "POST",
      headers: sb.headers,
      body: JSON.stringify({ p_email: email }),
    });
    if (!lookupRes.ok) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    const lookup = (await lookupRes.json()) as Record<string, unknown> | null;
    if (!lookup || !lookup.password_hash || lookup.is_active !== true) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    if (!["owner", "manager"].includes(lookup.role_key as string)) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    if (!(await verifySecret(password, lookup.password_hash as string))) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }

    // Create session
    const organizationId = lookup.organization_id as string;
    const employeeId = lookup.employee_id as string;
    const now = new Date();
    const sessionId = randomUUID();
    const expiresAt = addDays(now, 7);

    const createRes = await fetch(`${sb.url}/rest/v1/rpc/admin_login_create_session`, {
      method: "POST",
      headers: { ...sb.headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        p_employee_id: employeeId,
        p_organization_id: organizationId,
        p_session_id: sessionId,
        p_created_at: now.toISOString(),
        p_expires_at: expiresAt.toISOString(),
      }),
    });
    if (!createRes.ok) {
      return Response.json({ error: "Failed to create session." }, { status: 500 });
    }

    // Invalidate store cache
    try {
      const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
      invalidateStoreCache();
    } catch {
      // Non-fatal
    }

    // Build success response with Set-Cookie AND session ID in body (belt + suspenders)
    const isSecure = request.url.startsWith("https");
    const cookieValue = [
      `${ADMIN_COOKIE}=${sessionId}`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Expires=${expiresAt.toUTCString()}`,
      ...(isSecure ? ["Secure"] : []),
    ].join("; ");

    return Response.json(
      { success: true, redirect: "/admin", sessionId, expiresAt: expiresAt.toISOString() },
      {
        status: 200,
        headers: { "Set-Cookie": cookieValue },
      },
    );
  } catch (err) {
    console.error("[api/auth/login] Error:", err);
    return Response.json({ error: "Invalid email or password." }, { status: 401 });
  }
}
