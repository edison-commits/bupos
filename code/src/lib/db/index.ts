// R24-M-4: the driver-selection detection USED to run at module
// load time (`const connectionString = process.env.DATABASE_URL`,
// etc.). That froze the driver choice at the first import, so a
// test that set `DATABASE_URL` AFTER importing this module would
// silently get the wrong driver. Detection now happens inside
// `loadPoolCtor()` so each evaluation sees fresh env.
//
// R24-H-2: prior revisions documented a "per-call pool on remote"
// strategy but the shared-pool Proxy silently violated it. The
// contract is now: on remote, EVERY caller goes through `makePool`
// per call — the `pool` Proxy below redirects `.query` / `.connect`
// to `orgQuery` / `orgTx` equivalents in remote, and to a shared
// long-lived pool only on local dev.

function readConnectionInfo() {
  const connectionString = process.env.DATABASE_URL || "";
  const isRemote =
    connectionString.includes("supabase.com") ||
    connectionString.includes("supabase.co");
  const isLocal =
    !isRemote &&
    (connectionString.includes("localhost") ||
      connectionString.includes("127.0.0.1"));
  return { connectionString, isRemote, isLocal };
}

// Types mirror `@neondatabase/serverless` AND `pg` — both drivers
// return `Promise<QueryResult<Row>>` where Row defaults to
// `Record<string, unknown>`. Consumers call `pool.query<RowShape>`
// and access `.rows` / `.rowCount`. Default to `any` to match pg's +
// @neondatabase/serverless's native type signatures.
interface QueryResultLike<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches driver signatures
  T = any,
> {
  rows: T[];
  rowCount?: number | null;
}
interface PoolClientLike {
  query<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches driver signatures
    T = any,
  >(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
  release(err?: Error | boolean): void;
}
interface PoolLike {
  query<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches driver signatures
    T = any,
  >(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

// Cached driver-constructor loader. Resolves at most once per
// isolate. The env read lives INSIDE the async factory so tests
// that set `DATABASE_URL` between module load and first call get
// the correct driver.
type PoolCtor = new (opts: Record<string, unknown>) => PoolLike;
let _poolCtorPromise: Promise<PoolCtor> | null = null;
function loadPoolCtor(): Promise<PoolCtor> {
  if (_poolCtorPromise) return _poolCtorPromise;
  _poolCtorPromise = (async () => {
    const { isLocal } = readConnectionInfo();
    if (isLocal) {
      const mod = await import("pg");
      return mod.Pool as unknown as PoolCtor;
    }
    const mod = await import("@neondatabase/serverless");
    return mod.Pool as unknown as PoolCtor;
  })();
  return _poolCtorPromise;
}

async function makePool(max: number): Promise<PoolLike> {
  const Ctor = await loadPoolCtor();
  const { connectionString, isRemote } = readConnectionInfo();
  return new Ctor({
    connectionString,
    ssl: isRemote ? { rejectUnauthorized: true } : undefined,
    statement_timeout: 30_000,
    idleTimeoutMillis: 0,
    max,
  });
}

// Long-lived pool for LOCAL DEV ONLY. On remote we never use this.
// The Proxy below redirects `.query` / `.connect` based on the
// current env so legacy consumers (`postgres-store.ts` +
// `postgres-phase3.ts`) get the correct behavior automatically.
let _localPoolPromise: Promise<PoolLike> | null = null;
function getLocalPool(): Promise<PoolLike> {
  if (_localPoolPromise) return _localPoolPromise;
  _localPoolPromise = makePool(5);
  return _localPoolPromise;
}

/**
 * Per-call pool for remote — mirrors the `orgTx` / `orgQuery`
 * pattern. Short-lived, 1 connection, ends after use.
 */
async function withRemotePool<T>(fn: (p: PoolLike) => Promise<T>): Promise<T> {
  const p = await makePool(1);
  try {
    return await fn(p);
  } finally {
    p.end().catch(() => {});
  }
}

async function proxyQuery<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
>(text: string, values?: unknown[]): Promise<QueryResultLike<T>> {
  const { isRemote } = readConnectionInfo();
  if (isRemote) {
    // R24-H-2: per-call pool on remote so no connection crosses
    // requests. Matches the long-documented strategy.
    return withRemotePool((p) => p.query<T>(text, values));
  }
  const p = await getLocalPool();
  return p.query<T>(text, values);
}

async function proxyConnect(): Promise<PoolClientLike> {
  const { isRemote } = readConnectionInfo();
  if (isRemote) {
    // Remote connect: wrap a per-call pool. The returned client's
    // `release` is overridden to ALSO end the ephemeral pool so the
    // connection doesn't leak.
    const p = await makePool(1);
    const client = await p.connect();
    const originalRelease = client.release.bind(client);
    let released = false;
    client.release = ((err?: Error | boolean) => {
      if (released) return;
      released = true;
      originalRelease(err);
      p.end().catch(() => {});
    }) as typeof client.release;
    return client;
  }
  const p = await getLocalPool();
  return p.connect();
}

async function proxyEnd(): Promise<void> {
  if (!_localPoolPromise) return;
  const p = await _localPoolPromise;
  await p.end();
  _localPoolPromise = null;
}

/**
 * Backwards-compat surface for the two legacy consumers
 * (`postgres-store.ts`, `postgres-phase3.ts`) that import `pool`
 * directly. On remote every `.query` / `.connect` creates a fresh
 * per-call pool; on local dev it reuses a long-lived shared pool.
 */
export const pool: PoolLike = {
  query: proxyQuery,
  connect: proxyConnect,
  end: proxyEnd,
};

/**
 * Begin a transaction with the RLS org context set.
 * Returns a connected client with BEGIN + SET LOCAL already executed.
 * The returned client's `release()` is overridden to also end the per-call pool
 * on remote, so Cloudflare Workers don't reuse connections across requests.
 *
 * Usage:
 *   const client = await orgTx(orgId);
 *   try {
 *     // ... queries scoped to org ...
 *     await client.query("COMMIT");
 *   } catch (e) { await client.query("ROLLBACK"); throw e; }
 *   finally { client.release(); }
 */
export async function orgTx(organizationId: string): Promise<PoolClientLike> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error("Invalid organization ID format");
  }
  const { isRemote } = readConnectionInfo();
  const p = isRemote ? await makePool(1) : await getLocalPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);

    if (isRemote) {
      const originalRelease = client.release.bind(client);
      let released = false;
      client.release = ((err?: Error | boolean) => {
        if (released) return;
        released = true;
        originalRelease(err);
        p.end().catch(() => {});
      }) as typeof client.release;
    }
    return client;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    if (isRemote) p.end().catch(() => {});
    throw e;
  }
}

/**
 * Set the RLS org context for a single (non-transactional) query via pool.
 * Creates a fresh pool per call on remote so Cloudflare Worker requests never
 * share a connection. Local dev keeps the module-level pool.
 */
export async function orgQuery<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
>(organizationId: string, text: string, values?: unknown[]): Promise<QueryResultLike<T>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error("Invalid organization ID format");
  }
  const { isRemote } = readConnectionInfo();
  const p = isRemote ? await makePool(1) : await getLocalPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    if (isRemote) p.end().catch(() => {});
  }
}

export default pool;
