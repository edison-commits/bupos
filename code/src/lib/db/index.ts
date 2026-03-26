import { Pool } from '@neondatabase/serverless';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/basicuniformpos';

const isRemote =
  connectionString.includes('supabase.com') ||
  connectionString.includes('supabase.co');

export const pool = new Pool({
  connectionString,
  ssl: isRemote ? { rejectUnauthorized: false } : undefined,
  ...(isRemote && {
    idleTimeoutMillis: 5_000,
    max: 3,
  }),
});

/**
 * Begin a transaction with the RLS org context set.
 * Returns a connected client with BEGIN + SET LOCAL already executed.
 *
 * Usage:
 *   const client = await orgTx(orgId);
 *   try {
 *     // ... queries scoped to org ...
 *     await client.query("COMMIT");
 *   } catch (e) { await client.query("ROLLBACK"); throw e; }
 *   finally { client.release(); }
 */
export async function orgTx(organizationId: string) {
  // Validate UUID format to prevent SQL injection
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error("Invalid organization ID format");
  }
  const client = await pool.connect();
  await client.query("BEGIN");
  // SET doesn't support parameterized values, so we use validated string interpolation
  await client.query(`SET LOCAL app.current_org_id = '${organizationId}'`);
  return client;
}

/**
 * Set the RLS org context for a single (non-transactional) query via pool.
 * For read-only queries that don't use an explicit transaction.
 */
export async function orgQuery(organizationId: string, text: string, values?: unknown[]) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error("Invalid organization ID format");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.current_org_id = '${organizationId}'`);
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default pool;
