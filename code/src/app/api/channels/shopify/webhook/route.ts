import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool, orgTx } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
import { getChannelProvider } from "@/lib/channels";
import type { OrderLine } from "@/lib/channels/types";
import {
  loadIntegration,
  decryptCreds,
  resolveSkus,
  resolveOnlineActor,
  applyOnlineDecrement,
  applyOnlineRestock,
  pushInventory,
} from "@/lib/channels/repo";

/**
 * PUBLIC Shopify webhook endpoint. Machine-to-machine: authenticated by the
 * per-tenant HMAC over the RAW body — NOT by cookie/Origin (checkOrigin is
 * intentionally skipped). Tenant resolved by shop domain via a SECURITY DEFINER
 * RPC (keeps this off the raw-pool allowlist). Idempotent via the webhook id.
 *
 * Topics handled (X-Shopify-Topic):
 *   orders/create     → decrement the fulfillment location + record the order.
 *   refunds/create    → restock ONLY the lines Shopify itself restocked (mirrors
 *                       Shopify's own restock, so we never double-count).
 *   orders/cancelled  → status update only (a cancel-with-restock fires its own
 *                       refunds/create, which does the inventory move).
 *   app/uninstalled   → flip the integration to 'disconnected' (no creds wipe).
 */

interface DedupOutcome {
  replay: boolean;
}

/**
 * Open an orgTx, insert the dedup row, and—if this webhook id is new—run the
 * per-topic `effect` and mark the event processed, all in one transaction.
 */
async function withDedup(
  orgId: string,
  integrationId: string,
  webhookId: string,
  topic: string,
  effect: (client: Awaited<ReturnType<typeof orgTx>>) => Promise<void>,
): Promise<DedupOutcome> {
  const client = await orgTx(orgId);
  try {
    const dedup = await client.query(
      `INSERT INTO channel_webhook_events (organization_id, channel_integration_id, webhook_id, topic, status)
       VALUES ($1, $2, $3, $4, 'received')
       ON CONFLICT (channel_integration_id, webhook_id) DO NOTHING RETURNING id`,
      [orgId, integrationId, webhookId, topic],
    );
    if (dedup.rows.length === 0) {
      await client.query("COMMIT");
      return { replay: true };
    }
    await effect(client);
    await client.query(`UPDATE channel_webhook_events SET processed_at = now(), status = 'processed' WHERE id = $1`, [dedup.rows[0].id]);
    await client.query("COMMIT");
    return { replay: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function POST(req: NextRequest) {
  // 1. Raw body FIRST — HMAC is computed over the exact bytes.
  const rawBody = await req.text();
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const webhookId = req.headers.get("x-shopify-webhook-id");
  const topic = (req.headers.get("x-shopify-topic") ?? "orders/create").toLowerCase();
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
  if (!row) return NextResponse.json({ error: "Not connected" }, { status: 401 });
  const creds = await decryptCreds(row);
  if (!creds?.webhookSecret) return NextResponse.json({ error: "Misconfigured" }, { status: 401 });

  // 3. Verify HMAC (constant-time) before any DB work.
  const provider = getChannelProvider(row.provider);
  const valid = await provider.verifyWebhookHmac(rawBody, hmac, creds.webhookSecret);
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  try {
    // ── app/uninstalled: disconnect regardless of current status (idempotent). ──
    if (topic === "app/uninstalled") {
      const { replay } = await withDedup(orgId, row.id, webhookId, topic, async (client) => {
        await client.query(
          `UPDATE channel_integrations
              SET status = 'disconnected', last_error = 'App uninstalled from Shopify', updated_at = now()
            WHERE id = $1 AND organization_id = $2`,
          [row.id, orgId],
        );
      });
      return NextResponse.json({ ok: true, replay, topic }, { status: 200 });
    }

    // The inventory/status topics below act on a connected integration only.
    if (row.status !== "connected") return NextResponse.json({ error: "Not connected" }, { status: 401 });

    // ── orders/cancelled: status update only (refunds/create handles restock). ──
    if (topic === "orders/cancelled") {
      const order = provider.parseOrderPayload(rawBody);
      const { replay } = await withDedup(orgId, row.id, webhookId, topic, async (client) => {
        if (order) {
          await client.query(
            `UPDATE online_orders SET financial_status = 'cancelled', updated_at = now()
              WHERE organization_id = $1 AND channel_integration_id = $2 AND external_order_id = $3`,
            [orgId, row.id, order.externalOrderId],
          );
        }
      });
      return NextResponse.json({ ok: true, replay, topic }, { status: 200 });
    }

    // ── refunds/create: restock the lines Shopify restocked, push counts back. ──
    if (topic === "refunds/create") {
      const refund = provider.parseRefundPayload(rawBody);
      if (!refund) return NextResponse.json({ ok: true, ignored: "unparseable" }, { status: 200 });
      // Reuse the SKU→variant resolver (treat restock lines as order lines).
      const restockLines: OrderLine[] = refund.restockLines.map((l) => ({
        sku: l.sku, quantity: l.quantity, title: "", externalVariantId: null, price: null,
      }));
      const { resolved } = await resolveSkus(orgId, restockLines);
      const actor = row.fulfillment_location_id ? await resolveOnlineActor(orgId, row.connected_by_employee_id) : null;

      let pushVariantIds: string[] = [];
      const { replay } = await withDedup(orgId, row.id, webhookId, topic, async (client) => {
        if (row.fulfillment_location_id && actor && resolved.length > 0) {
          pushVariantIds = await applyOnlineRestock(client, orgId, row.fulfillment_location_id, actor, resolved);
        }
        // Best-effort: note the refund on the originating order (if we have it).
        await client.query(
          `UPDATE online_orders SET financial_status = 'refunded', updated_at = now()
            WHERE organization_id = $1 AND channel_integration_id = $2 AND external_order_id = $3`,
          [orgId, row.id, refund.externalOrderId],
        );
      });

      if (!replay) {
        await invalidateInventoryCache(orgId);
        if (pushVariantIds.length > 0) {
          await waitUntilOrAwait(pushInventory(row, creds, pushVariantIds).then(() => {}).catch(() => {}));
        }
      }
      return NextResponse.json({ ok: true, replay, topic, restocked: pushVariantIds.length }, { status: 200 });
    }

    // ── orders/create (default): decrement the fulfillment location + record. ──
    const order = provider.parseOrderPayload(rawBody);
    if (!order) return NextResponse.json({ ok: true, ignored: "unparseable" }, { status: 200 });
    const { resolved, unresolved } = await resolveSkus(orgId, order.lines);
    const actor = row.fulfillment_location_id ? await resolveOnlineActor(orgId, row.connected_by_employee_id) : null;

    let pushVariantIds: string[] = [];
    const { replay } = await withDedup(orgId, row.id, webhookId, topic, async (client) => {
      let decrementStatus = "skipped";
      if (row.fulfillment_location_id && actor && resolved.length > 0) {
        const dec = await applyOnlineDecrement(client, orgId, row.fulfillment_location_id, actor, resolved);
        pushVariantIds = dec.applied.map((a) => a.variantId);
        decrementStatus = unresolved.length > 0 ? "partial" : "applied";
      }
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
    });

    if (!replay) {
      // Bust caches + push the post-sale counts back to Shopify (fire-and-forget,
      // adopted so it survives on Workers). Errors are non-fatal — reconcile catches up.
      await invalidateInventoryCache(orgId);
      if (pushVariantIds.length > 0) {
        await waitUntilOrAwait(pushInventory(row, creds, pushVariantIds).then(() => {}).catch(() => {}));
      }
    }
    return NextResponse.json({ ok: true, replay, topic }, { status: 200 });
  } catch (e) {
    console.error("[channels/webhook] process:", safeErr(e));
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
