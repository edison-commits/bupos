import { orgQuery } from "@/lib/db";
import type { ApprovalThresholds, LoyaltyConfig } from "@/lib/domain/types";
import { defaultApprovalThresholds } from "@/lib/config/thresholds";

export interface RegisterConfig {
  approvalThresholds: ApprovalThresholds;
  loyalty: LoyaltyConfig;
}

const defaultLoyalty: LoyaltyConfig = {
  earnRatePerDollar: 1,
  redemptionValuePerPoint: 0.01,
  minimumRedemption: 100,
};

// TTL cache: one entry per org, refreshed every 60 seconds
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

    const row = rows[0];
    const config: RegisterConfig = {
      approvalThresholds: row?.approval_thresholds ?? defaultApprovalThresholds,
      loyalty: row?.loyalty_config ?? defaultLoyalty,
    };

    cache.set(organizationId, { config, expiresAt: now + TTL_MS });
    return config;
  } catch (err) {
    console.error("[register-config] Failed to load config, using defaults:", err);
    return { approvalThresholds: defaultApprovalThresholds, loyalty: defaultLoyalty };
  }
}
