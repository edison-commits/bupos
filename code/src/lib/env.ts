/**
 * Environment variable access.
 *
 * BUPOS_ORG_ID and BUPOS_LOCATION_ID are set via wrangler.toml vars
 * (Cloudflare Workers runtime) or .env.local (local dev).
 *
 * During Next.js build, these may not be set, so we return "" gracefully.
 * Runtime code that needs them should validate explicitly.
 */

export const BUPOS_ORG_ID: string = process.env.BUPOS_ORG_ID ?? "";
export const BUPOS_LOCATION_ID: string = process.env.BUPOS_LOCATION_ID ?? "";
export const DATABASE_URL: string = process.env.DATABASE_URL ?? "";
