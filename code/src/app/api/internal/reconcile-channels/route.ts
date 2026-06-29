import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool, orgQuery } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { loadIntegration, decryptCreds, changedSinceLastSync, pushInventory, pushPrices } from "@/lib/channels/repo";
import { requireInternalHmac } from "@/lib/api/internal-hmac";

/**
 * HMAC-gated periodic reconcile: pushes the fulfillment location's on_hand to
 * Shopify for variants whose inventory changed since last sync (so IN-STORE
 * sales propagate online). Invoked by a GitHub-Actions cron — Cloudflare Worker
 * drives the HMAC-gated /api/internal/reconcile-channels endpoint — same
 * fail-closed pattern as the nightly pg_cron cleanup + the synthetic-health
 * probe, plus timestamp-bound replay protection.
 */
export async function POST(req: NextRequest) {
  const auth = await requireInternalHmac(req, process.env.CHANNEL_RECONCILE_SECRET, "Reconcile endpoint not configured");
  if (!auth.ok) return auth.response;

  let connected: { integration_id: string; organization_id: string }[] = [];
  try {
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT integration_id, organization_id FROM list_connected_channels()`);
    connected = rows as { integration_id: string; organization_id: string }[];
  } catch (err) {
    console.error("[reconcile-channels] list:", safeErr(err));
    return NextResponse.json({ error: "List failed" }, { status: 500 });
  }

  let orgsProcessed = 0;
  let totalPushed = 0;
  let totalFailed = 0;
  for (const c of connected) {
    try {
      const row = await loadIntegration(c.organization_id);
      if (!row || row.status !== "connected") continue;
      const creds = await decryptCreds(row);
      if (!creds) continue;
      const changed = await changedSinceLastSync(row);
      if (changed.length === 0) { orgsProcessed++; continue; }
      const push = await pushInventory(row, creds, changed);
      const pricePush = row.sync_prices ? await pushPrices(row, creds, changed) : null;
      const failed = push.failed + (pricePush?.failed ?? 0);
      totalPushed += push.pushed + (pricePush?.pushed ?? 0);
      totalFailed += failed;
      if (failed === 0) {
        await orgQuery(c.organization_id, `UPDATE channel_integrations SET last_sync_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [row.id, c.organization_id]);
      }
      orgsProcessed++;
    } catch (err) {
      console.error("[reconcile-channels] org:", safeErr(err));
    }
  }
  return NextResponse.json({ ok: true, orgs: orgsProcessed, pushed: totalPushed, failed: totalFailed });
}
