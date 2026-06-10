import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { getChannelProvider } from "@/lib/channels";
import { loadIntegration, decryptCreds } from "@/lib/channels/repo";

/**
 * POST: validate the stored token against Shopify, capture the shop's identity
 * + locations, register all webhooks (orders/create, refunds/create,
 * orders/cancelled, app/uninstalled), and mark the integration connected.
 * Idempotent — safe to re-run.
 */
export const POST = withAdminAuth("online.manage", async (req, ctx) => {
  const { orgId } = ctx;
  const row = await loadIntegration(orgId);
  if (!row) return NextResponse.json({ error: "No integration configured" }, { status: 400 });
  const creds = await decryptCreds(row);
  if (!creds) return NextResponse.json({ error: "No valid access token stored — re-enter it" }, { status: 400 });

  const provider = getChannelProvider(row.provider);
  try {
    const { shop, locations } = await provider.validate(creds);
    // Keep an explicitly-chosen Shopify location; else default to the first.
    const shopifyLocationId = row.shopify_location_id ?? locations[0]?.id ?? null;
    if (!shopifyLocationId) {
      await orgQuery(orgId, `UPDATE channel_integrations SET status='error', last_error='No Shopify locations found', updated_at=now() WHERE id=$1 AND organization_id=$2`, [row.id, orgId]);
      return NextResponse.json({ error: "Shopify store has no locations" }, { status: 400 });
    }

    const callbackUrl = `${new URL(req.url).origin}/api/channels/shopify/webhook`;
    const hook = await provider.registerWebhooks(creds, callbackUrl);

    await orgQuery(
      orgId,
      `UPDATE channel_integrations
          SET status='connected', shop_domain=$1, shopify_location_id=$2, last_error=$3, updated_at=now()
        WHERE id=$4 AND organization_id=$5`,
      [shop.myshopifyDomain, shopifyLocationId, hook.ok ? null : `webhook: ${hook.error ?? "failed"}`, row.id, orgId],
    );

    return NextResponse.json({
      ok: true,
      shop: { name: shop.name, domain: shop.myshopifyDomain, currency: shop.currencyCode },
      locations,
      webhook_registered: hook.ok,
      webhook_error: hook.ok ? undefined : hook.error,
    });
  } catch (err) {
    const msg = safeErr(err);
    await orgQuery(orgId, `UPDATE channel_integrations SET status='error', last_error=$1, updated_at=now() WHERE id=$2 AND organization_id=$3`, [String(msg).slice(0, 300), row.id, orgId]);
    return NextResponse.json({ error: "Connection failed — check the domain, token, and scopes" }, { status: 400 });
  }
});
