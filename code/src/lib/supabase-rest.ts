const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function supabaseRpc(fn: string, params: Record<string, unknown>) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const raw = await resp.json();
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function supabaseQuery(table: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const url = qs ? `${SUPABASE_URL}/rest/v1/${table}?${qs}` : `${SUPABASE_URL}/rest/v1/${table}`;
  const resp = await fetch(url, { headers: { "apikey": SUPABASE_KEY } });
  return resp.json();
}

export async function supabaseInsert(table: string, data: Record<string, unknown>) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  return resp.json();
}

export async function supabaseUpdate(table: string, query: Record<string, string>, data: Record<string, unknown>) {
  const qs = new URLSearchParams(query).toString();
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: "PATCH",
    headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  return resp.json();
}

export async function supabaseDelete(table: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: "DELETE",
    headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=representation" },
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Lazy pool helpers — defer Neon pool creation to runtime so the static
// import of this module never triggers `new Pool()` on Workers cold-start.
// ---------------------------------------------------------------------------

/** Return the Neon pool, importing `@/lib/db` lazily. */
export async function getPool() {
  const mod = await import("@/lib/db");
  return mod.pool;
}

/**
 * Lazy wrapper around the RLS-scoped orgQuery from `@/lib/db`.
 * Identical behaviour, but the pool is only created on first call.
 */
export async function orgQuery(organizationId: string, text: string, values?: unknown[]) {
  const { orgQuery: fn } = await import("@/lib/db");
  return fn(organizationId, text, values);
}

/**
 * Lazy wrapper around orgTx from `@/lib/db`.
 */
export async function orgTx(organizationId: string) {
  const { orgTx: fn } = await import("@/lib/db");
  return fn(organizationId);
}
