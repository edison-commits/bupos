// R12-L-1: the service-role REST helpers (supabaseRpc / supabaseQuery /
// supabaseInsert / supabaseUpdate / supabaseDelete) used to live here as
// general-purpose Supabase REST wrappers keyed on the service-role bearer
// token. Every in-repo callsite has migrated to `orgQuery` / `orgTx`
// (below), which enforce RLS + set `app.current_org_id`. Keeping the
// BYPASSRLS helpers exported invited future routes to silently
// cross-tenant-write without the pg-helpers-require-org ESLint rule
// catching them (prefix matches only `pg*`). Deleted to remove the
// foot-gun; add back with a `pg*`-conformant name if actually needed.

// ---------------------------------------------------------------------------
// Lazy pool helpers — defer Neon pool creation to runtime so the static
// import of this module never triggers `new Pool()` on Workers cold-start.
// Cache the imported module to prevent potential re-evaluation on Workers.
// ---------------------------------------------------------------------------

/**
 * Return a Neon-pool-compatible facade, importing `@/lib/db` lazily.
 *
 * IMPORTANT: On Cloudflare Workers the shared module-scoped Neon pool binds
 * its WebSocket to the request that first opened it; reusing across requests
 * throws "Cannot perform I/O on behalf of a different request". The facade
 * below creates a per-call single-connection pool on remote for every
 * `query()` / `connect()` and tears it down afterwards, matching the
 * pattern used by orgQuery / orgTx in `@/lib/db`.
 *
 * On local dev (non-Supabase Postgres over TCP) we keep returning the shared
 * pool because in-process reuse is fine there.
 */
export async function getPool() {
  const mod = await import("@/lib/db");
  const connectionString = process.env.DATABASE_URL || "";
  const isRemote = connectionString.includes("supabase.com") || connectionString.includes("supabase.co");
  if (!isRemote) return mod.pool;

  // R24-prevention: dynamic driver selection (parallel to db/index.ts).
  // On prod (Supabase), use @neondatabase/serverless. Local tests that
  // happen to hit this path via a localhost URL would use pg, but
  // they typically reach `mod.pool` above and never land here.
  const { Pool } = await import("@neondatabase/serverless");

  function makeOneShotPool() {
    return new Pool({
      connectionString,
      ssl: { rejectUnauthorized: true },
      max: 1,
      statement_timeout: 30_000,
      idleTimeoutMillis: 0,
    });
  }

  // Facade — looks like a Pool but creates a throwaway pool per call so a
  // connection never crosses requests.
  const facade = {
    async query(text: string, values?: unknown[]) {
      const p = makeOneShotPool();
      try {
        return await p.query(text, values);
      } finally {
        p.end().catch(() => {});
      }
    },
    async connect() {
      const p = makeOneShotPool();
      const client = await p.connect();
      const originalRelease = client.release.bind(client);
      let released = false;
      client.release = ((...args: unknown[]) => {
        if (released) return;
        released = true;
        originalRelease(...(args as []));
        p.end().catch(() => {});
      }) as typeof client.release;
      return client;
    },
    end: async () => {
      /* facade has no persistent resource */
    },
  };

  return facade as unknown as typeof mod.pool;
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
