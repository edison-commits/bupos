/**
 * Validates required environment variables at startup.
 * Throws if any required var is missing — fails fast, no silent wrong behavior.
 */

const REQUIRED: Record<string, string | undefined> = {
  DATABASE_URL: process.env.DATABASE_URL,
  BUPOS_ORG_ID: process.env.BUPOS_ORG_ID,
  BUPOS_LOCATION_ID: process.env.BUPOS_LOCATION_ID,
};

const MISSING = Object.entries(REQUIRED)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (MISSING.length > 0) {
  throw new Error(
    `Missing required environment variables: ${MISSING.join(', ')}. ` +
    `Set these before starting the server.`
  );
}

// Re-export for convenience
export const BUPOS_ORG_ID = REQUIRED.BUPOS_ORG_ID!;
export const BUPOS_LOCATION_ID = REQUIRED.BUPOS_LOCATION_ID!;
export const DATABASE_URL = REQUIRED.DATABASE_URL!;
