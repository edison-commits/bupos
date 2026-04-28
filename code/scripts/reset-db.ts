// TST2-H1: prod-host guard. This script does
//   DROP SCHEMA public CASCADE;
// which silently nukes whatever DATABASE_URL is in the env. A
// developer with .env.local pointing at prod Supabase running
// `npx tsx scripts/reset-db.ts` would otherwise destroy production.
// Override only with explicit RESET_DB_FORCE=1 (prints a warning).
const PROD_HOST_SUFFIXES = [
  '.supabase.com', '.supabase.co', '.neon.tech', '.amazonaws.com',
  '.rds.amazonaws.com', '.compute.amazonaws.com', '.herokuapp.com',
  '.dbs.aiven.io',
];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function assertSafeTargetDb(): void {
  if (process.env.RESET_DB_FORCE === '1') {
    console.warn('[reset-db] RESET_DB_FORCE=1 — bypassing prod-host safety guard.');
    return;
  }
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error('[reset-db] DATABASE_URL is not set');
  let url: URL;
  try {
    url = new URL(conn);
  } catch {
    throw new Error('[reset-db] DATABASE_URL is not a valid URL');
  }
  const host = (url.hostname || '').toLowerCase();
  const dbName = (url.pathname || '').replace(/^\//, '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;
  if (dbName.endsWith('_test')) return;
  const isProdHost = PROD_HOST_SUFFIXES.some(s => host.endsWith(s));
  if (isProdHost) {
    throw new Error(
      `[reset-db] refusing to run against host '${host}' (looks like a ` +
      `production database). Set RESET_DB_FORCE=1 to override.`,
    );
  }
}

assertSafeTargetDb();
import pool from '../src/lib/db/index';

async function run() {
  const client = await pool.connect();
  try {
    console.log('Resetting database...');
    await client.query('DROP SCHEMA public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    console.log('Reset complete.');
  } finally {
    client.release();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
