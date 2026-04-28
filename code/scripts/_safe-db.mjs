/**
 * Shared prod-host guard for any script that touches the database.
 *
 * Refuses to proceed if `DATABASE_URL` resolves to a hostname matching
 * a known production host suffix (Supabase, Neon, AWS RDS, Heroku
 * Postgres). Override with the per-script FORCE flag (e.g.
 * `SIMULATE_FORCE=1`, `RESET_DB_FORCE=1`) — printing a warning when
 * the bypass fires.
 *
 * History: TST-L3 (round 1) added inline guards to 3 scripts. Round 2
 * audit found 6 more mutating scripts + a `reset-db.ts` (DROP SCHEMA
 * CASCADE, no guard at all) that needed the same protection. Factor
 * the logic here so a single shared helper gates every script.
 */

const PROD_HOST_SUFFIXES = [
  '.supabase.com',
  '.supabase.co',
  '.neon.tech',
  '.amazonaws.com',
  '.rds.amazonaws.com',
  '.compute.amazonaws.com',
  '.herokuapp.com',
  '.dbs.aiven.io',
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Throws if DATABASE_URL points at a recognized prod host AND the
 * caller's force-flag env var is not set to '1'.
 *
 * @param {object} opts
 * @param {string} opts.forceEnv  Name of the per-script bypass env var
 *                                (e.g. "SIMULATE_FORCE", "RESET_DB_FORCE").
 * @param {string} opts.scriptId  Short label printed in the error and
 *                                bypass-warn message (e.g. "reset-db").
 * @param {string} [opts.allowDbName]
 *                                Optional database-name match. If the
 *                                URL's database equals this OR ends
 *                                with `_test`, the prod-host check is
 *                                bypassed even on a prod-shaped host
 *                                (covers e.g. `bupos_test` shards).
 */
export function assertSafeTargetDb({ forceEnv, scriptId, allowDbName }) {
  if (process.env[forceEnv] === '1') {
    console.warn(`[${scriptId}] ${forceEnv}=1 — bypassing prod-host safety guard.`);
    return;
  }
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    throw new Error(`[${scriptId}] DATABASE_URL is not set`);
  }
  let url;
  try {
    url = new URL(conn);
  } catch {
    throw new Error(`[${scriptId}] DATABASE_URL is not a valid URL`);
  }
  const host = (url.hostname || '').toLowerCase();
  const dbName = (url.pathname || '').replace(/^\//, '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;
  // Allowlisted test database name on any host — explicit opt-in.
  if (allowDbName && dbName === allowDbName.toLowerCase()) return;
  if (dbName.endsWith('_test')) return;
  const isProdHost = PROD_HOST_SUFFIXES.some(s => host.endsWith(s));
  if (isProdHost) {
    throw new Error(
      `[${scriptId}] refusing to run against host '${host}' (looks like a ` +
      `production database). Set ${forceEnv}=1 to override (will print a warning).`,
    );
  }
}
