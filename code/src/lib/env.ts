/**
 * Environment variable access — strict in production, lenient in dev.
 *
 * BUPOS_ORG_ID and BUPOS_LOCATION_ID are required when USE_POSTGRES is true
 * or NODE_ENV is "production". DATABASE_URL is required in production.
 */

const isProd = process.env.NODE_ENV === "production";
const usePg = !!process.env.USE_POSTGRES;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value && (isProd || usePg)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const BUPOS_ORG_ID = requireEnv("BUPOS_ORG_ID");
export const BUPOS_LOCATION_ID = requireEnv("BUPOS_LOCATION_ID");
export const DATABASE_URL = requireEnv("DATABASE_URL");
