/**
 * Environment variable access with fail-fast in production.
 * In production (NODE_ENV=production), missing vars throw immediately.
 * In other environments, missing vars fall back to defaults with a console warning.
 */

const DEFAULTS = {
  BUPOS_ORG_ID: '33262270-7100-4b46-b2fb-8b50ad872bbb',
  BUPOS_LOCATION_ID: 'c57268b3-cb14-4c1a-bda6-55e49ddc6313',
} as const;

function getEnv(key: string, fallback: string): string {
  const value = process.env[key];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  console.warn(`[env] ${key} not set, using default (acceptable in non-production)`);
  return fallback;
}

// Always require DATABASE_URL in production
if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

export const BUPOS_ORG_ID = getEnv('BUPOS_ORG_ID', DEFAULTS.BUPOS_ORG_ID);
export const BUPOS_LOCATION_ID = getEnv('BUPOS_LOCATION_ID', DEFAULTS.BUPOS_LOCATION_ID);
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/swiftpos';
