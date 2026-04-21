// IMPORTANT: use the Workers-compatible per-request pool helper. Previously
// this did `import { orgQuery } from "@/lib/db"` which triggered
// `new Pool()` at module load — crashes Cloudflare Workers cold-start.
import { orgQuery } from "@/lib/supabase-rest";
import type { ApprovalThresholds, LoyaltyConfig } from "@/lib/domain/types";
import { defaultApprovalThresholds } from "@/lib/config/thresholds";
import { safeErr } from "@/lib/logging/safe-err";

export interface RegisterConfig {
  approvalThresholds: ApprovalThresholds;
  loyalty: LoyaltyConfig;
}

const defaultLoyalty: LoyaltyConfig = {
  earnRatePerDollar: 1,
  redemptionValuePerPoint: 0.01,
  minimumRedemption: 100,
};

// Per-isolate TTL cache. On Cloudflare Workers this cache's hit rate is
// near-zero because each request gets a fresh isolate — so every
// offline-sync / checkout call effectively pays one pool handshake just
// for this small read. Callers that already hold an orgTx client should
// prefer `readRegisterConfigWith(client, orgId)` below, which re-uses
// the existing connection.
const cache = new Map<string, { config: RegisterConfig; expiresAt: number }>();
const TTL_MS = 60_000;

export async function getRegisterConfig(organizationId: string): Promise<RegisterConfig> {
  const now = Date.now();
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }

  try {
    const { rows } = await orgQuery(
      organizationId,
      `SELECT approval_thresholds, loyalty_config FROM organizations WHERE id = $1`,
      [organizationId],
    );

    const config = buildConfig(rows[0]);
    cache.set(organizationId, { config, expiresAt: now + TTL_MS });
    return config;
  } catch (err) {
    console.error("[register-config] Failed to load config, using defaults:", safeErr(err));
    return { approvalThresholds: defaultApprovalThresholds, loyalty: defaultLoyalty };
  }
}

/**
 * Read register config reusing an ALREADY-OPEN client (orgTx/pool.connect).
 * Hot paths like /api/offline-sync and checkoutAction can call this from
 * inside their pre-tx read block instead of spawning a separate one-shot
 * pool for `getRegisterConfig`. Saves ~100-200ms per call on Workers.
 */
export async function readRegisterConfigWith(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  organizationId: string,
): Promise<RegisterConfig> {
  try {
    const { rows } = await client.query(
      `SELECT approval_thresholds, loyalty_config FROM organizations WHERE id = $1`,
      [organizationId],
    );
    const config = buildConfig(rows[0]);
    // Warm the per-isolate cache even on the fast path — if the same
    // isolate handles a later request that does NOT have a client open,
    // it gets the cached value.
    cache.set(organizationId, { config, expiresAt: Date.now() + TTL_MS });
    return config;
  } catch (err) {
    console.error("[register-config] Failed to load config via shared client, using defaults:", safeErr(err));
    return { approvalThresholds: defaultApprovalThresholds, loyalty: defaultLoyalty };
  }
}

function buildConfig(row: unknown): RegisterConfig {
  const r = (row ?? {}) as { approval_thresholds?: ApprovalThresholds; loyalty_config?: LoyaltyConfig };
  return {
    approvalThresholds: r.approval_thresholds ?? defaultApprovalThresholds,
    loyalty: r.loyalty_config ?? defaultLoyalty,
  };
}
