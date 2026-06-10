import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool, orgTx } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
import { getChannelProvider } from "@/lib/channels";
import { loadIntegration, decryptCreds, resolveSkus, resolveOnlineActor, applyOnlineDecrement, pushInventory } from "@/lib/channels/repo";

/**
 * PUBLIC Shopify webhook (orders/create). Machine-to-machine: authenticated by
 * the per-tenant HMAC over the RAW body — NOT by cookie/Origin (checkOrigin is
 * intentionally skipped). Tenant resolved by shop domain via a SECURITY DEFINER
 * RPC (keeps this off the raw-pool allowlist). Idempotent via the webhook id.
 */
export async function POST(req: NextRequest) {
  // 1. Raw body FIRST — HMAC is computed over the exact bytes.
  const rawBody = await req.text();
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const webhookId = req.headers.get("x-shopify-webhook-id");
  const topic = req.headers.get("x-shopify-topic") ?? "orders/create";
  if (!shopDomain || !hmac || !webhookId) {
    return NextResponse.json({ error: "Missing Shopify headers" }, { status: 400 });
  }

  // 2. Resolve tenant by shop domain (pre-auth, cross-org → SECDEF RPC).
  let orgId: string;
  try {
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT organization_id FROM resolve_channel_by_shop_domain($1)`, [shopDomain]);
    if (!rows[0]?.organization_id) return NextResponse.json({ error: "Unknown shop" }, { status: 401 });
    orgId = rows[0].organization_id as string;
  } catch (err) {
    console.error("[channels/webhook] resolve:", safeErr(err));
    return NextResponse.json({ error: "Resolution failed" }, { status: 500 });
  }

  const row = await loadIntegration(orgId);
  if (!row || row.status !== "connected") return NextResponse.json({ error: "Not connected" }, { status: 401 });
  const creds = await decryptCreds(row);
  if (!creds?.webhookSecret) return NextResponse.json({ error: "Misconfigured" }, { status: 401 });

  // 3. Verify HMAC (constant-time) before any DB work.
  const provider = getChannelProvider(row.provider);
  const valid = await provider.verifyWebhookHmac(rawBody, hmac, creds.webhookSecret);
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  // 4. Parse + resolve SKUs (read) before the write tx.
  const order = provider.parseOrderPayload(rawBody);
  if (!order) return NextResponse.json({ ok: true, ignored: "unparseable" }, { status: 200 });
  const { resolved, unresolved } = await resolveSkus(orgId, order.lines);
  const actor = row.fulfillment_location_id ? await resolveOnlineActor(orgId, row.connected_by_employee_id) : null;

  let isReplay = false;
  let pushVariantIds: string[] = [];
  const client = await orgTx(orgId);
  try {
    // 5. Dedup: insert the event; no row back = replay.
    const dedup = await client.query(
      `INSERT INTO channel_webhook_events (organization_id, channel_integration_id, webhook_id, topic, status)
       VALUES ($1, $2, $3, $4, 'received')
       ON CONFLICT (channel_integration_id, webhook_id) DO NOTHING RETURNING id`,
      [orgId, row.id, webhookId, topic],
    );
    if (dedup.rows.length === 0) {
      isReplay = true;
      await client.query("COMMIT");
    } else {
      // 6. Decrement at the fulfillment location (if we can attribute an actor).
      let decrementStatus = "skipped";
      if (row.fulfillment_location_id && actor && resolved.length > 0) {
        const dec = await applyOnlineDecrement(client, orgId, row.fulfillment_location_id, actor, resolved);
        pushVariantIds = dec.applied.map((a) => a.variantId);
        decrementStatus = unresolved.length > 0 ? "partial" : "applied";
      } else if (resolved.length === 0 && unresolved.length > 0) {
        decrementStatus = "skipped";
      }
      // 7. Record the order + mark the event processed (same tx).
      await client.query(
        `INSERT INTO online_orders
           (organization_id, channel_integration_id, external_order_id, external_order_number, financial_status,
            fulfillment_location_id, currency, subtotal, total, line_items, decrement_status, unresolved_skus, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (channel_integration_id, external_order_id) DO NOTHING`,
        [
          orgId, row.id, order.externalOrderId, order.orderNumber, order.financialStatus,
          row.fulfillment_location_id, order.currency, order.subtotal, order.total,
          JSON.stringify(order.lines), decrementStatus, JSON.stringify(unresolved), rawBody.slice(0, 100_000),
        ],
      );
      await client.query(`UPDATE channel_webhook_events SET processed_at=now(), status='processed' WHERE id=$1`, [dedup.rows[0].id]);
      await client.query("COMMIT");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[channels/webhook] process:", safeErr(e));
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  } finally {
    client.release();
  }

  if (!isReplay) {
    // Bust caches + push the post-sale counts back to Shopify (fire-and-forget,
    // adopted so it survives on Workers). Errors are non-fatal — reconcile catches up.
    await invalidateInventoryCache(orgId);
    if (creds && pushVariantIds.length > 0) {
      await waitUntilOrAwait(pushInventory(row, creds, pushVariantIds).then(() => {}).catch(() => {}));
    }
  }
  return NextResponse.json({ ok: true, replay: isReplay }, { status: 200 });
}
