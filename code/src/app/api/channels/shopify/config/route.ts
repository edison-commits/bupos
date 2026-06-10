import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgTx } from "@/lib/supabase-rest";
import { validateBody, shopifyConfigSchema } from "@/lib/validation/schemas";
import { encryptSecret } from "@/lib/channels/crypto";
import { loadIntegration } from "@/lib/channels/repo";
import { randomUUID } from "@/lib/uuid";

/** GET: masked integration status. NEVER returns the token/ciphertext. */
export const GET = withAdminAuth("online.manage", async (_req, ctx) => {
  const { orgId } = ctx;
  const row = await loadIntegration(orgId);
  if (!row) {
    return NextResponse.json({ connected: false, status: "disconnected", has_token: false });
  }
  return NextResponse.json({
    connected: row.status === "connected",
    provider: row.provider,
    shop_domain: row.shop_domain,
    status: row.status,
    fulfillment_location_id: row.fulfillment_location_id,
    shopify_location_id: row.shopify_location_id,
    sync_prices: row.sync_prices,
    last_sync_at: row.last_sync_at,
    last_error: row.last_error,
    has_token: !!row.access_token_ciphertext,
    has_webhook_secret: !!row.webhook_secret_ciphertext,
  });
});

/**
 * PUT: create/update the connection. Writing/rotating the token requires
 * step-up (it's a powerful external credential). Secrets are stored encrypted
 * and never echoed back. Changing the token flips status to 'disconnected'
 * (must re-run test-connection).
 */
export const PUT = withAdminAuth("online.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  const body = await req.json();
  const v = validateBody(shopifyConfigSchema, body);
  if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
  const { shop_domain, fulfillment_location_id, access_token, webhook_secret, shopify_location_id, sync_prices } = v.data;

  // Step-up when (re)setting the token or webhook secret.
  if (access_token || webhook_secret) {
    const { requireStepUp } = await import("@/lib/auth/step-up");
    const stepUp = await requireStepUp({
      actorId: employee.id,
      orgId,
      actorPassword: (body as { actorPassword?: string }).actorPassword,
      bucketKey: "channel-config-stepup",
    });
    if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
  }

  let tokenCipher: string | null = null;
  let secretCipher: string | null = null;
  try {
    tokenCipher = access_token ? await encryptSecret(access_token) : null;
    secretCipher = webhook_secret ? await encryptSecret(webhook_secret) : null;
  } catch {
    // CHANNEL_ENC_KEY isn't provisioned on this deploy (encryptSecret fails
    // closed). Surface a clear, actionable message instead of a generic 500.
    return NextResponse.json(
      { error: "Online Selling isn't enabled on this server yet (missing CHANNEL_ENC_KEY). Ask your administrator to set it." },
      { status: 503 },
    );
  }

  const client = await orgTx(orgId);
  try {
    // Upsert; on token change reset status so the connection is re-validated.
    await client.query(
      `INSERT INTO channel_integrations
         (organization_id, provider, shop_domain, fulfillment_location_id, shopify_location_id,
          access_token_ciphertext, webhook_secret_ciphertext, connected_by_employee_id,
          sync_prices, status, updated_at)
       VALUES ($1, 'shopify', $2, $3, $4, $5, $6, $7, COALESCE($8, true), 'disconnected', now())
       ON CONFLICT (organization_id, provider) DO UPDATE SET
         shop_domain = EXCLUDED.shop_domain,
         fulfillment_location_id = EXCLUDED.fulfillment_location_id,
         shopify_location_id = COALESCE(EXCLUDED.shopify_location_id, channel_integrations.shopify_location_id),
         access_token_ciphertext = COALESCE(EXCLUDED.access_token_ciphertext, channel_integrations.access_token_ciphertext),
         webhook_secret_ciphertext = COALESCE(EXCLUDED.webhook_secret_ciphertext, channel_integrations.webhook_secret_ciphertext),
         connected_by_employee_id = COALESCE(channel_integrations.connected_by_employee_id, EXCLUDED.connected_by_employee_id),
         sync_prices = COALESCE($8, channel_integrations.sync_prices),
         status = CASE WHEN EXCLUDED.access_token_ciphertext IS NOT NULL THEN 'disconnected' ELSE channel_integrations.status END,
         updated_at = now()`,
      [orgId, shop_domain, fulfillment_location_id, shopify_location_id ?? null, tokenCipher, secretCipher, employee.id, sync_prices ?? null],
    );
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES ($1, $2, NULL, $3, 'channel_integration', $2, 'channel_config_updated', $4, now())`,
      [randomUUID(), orgId, employee.id, JSON.stringify({ shop_domain, token_set: !!access_token, secret_set: !!webhook_secret })],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const row = await loadIntegration(orgId);
  return NextResponse.json({ ok: true, status: row?.status ?? "disconnected" });
});
