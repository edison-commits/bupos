/**
 * Environment variable access with fallback defaults.
 * Missing env vars fall back silently — no throwing at module load time.
 * The hardcoded defaults match the values used by the app in production.
 */

const DEFAULT_ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const DEFAULT_LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

export const BUPOS_ORG_ID = process.env.BUPOS_ORG_ID ?? DEFAULT_ORG_ID;
export const BUPOS_LOCATION_ID = process.env.BUPOS_LOCATION_ID ?? DEFAULT_LOCATION_ID;
export const DATABASE_URL = process.env.DATABASE_URL;
