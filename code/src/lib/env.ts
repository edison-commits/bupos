/**
 * Environment variable access — strict at runtime, lenient at build time.
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

// Eagerly read — these will throw at runtime if missing but are evaluated
// lazily by the module system (only when first imported by runtime code).
// During Next.js build, NODE_ENV !== "production" and USE_POSTGRES is not set,
// so these gracefully return "".
export const BUPOS_ORG_ID = requireEnv("BUPOS_ORG_ID");
export const BUPOS_LOCATION_ID = requireEnv("BUPOS_LOCATION_ID");
export const DATABASE_URL = requireEnv("DATABASE_URL");
