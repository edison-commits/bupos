import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getPool, orgQuery } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { loadIntegration, decryptCreds, changedSinceLastSync, pushInventory } from "@/lib/channels/repo";

/**
 * Bearer-gated periodic reconcile: pushes the fulfillment location's on_hand to
 * Shopify for variants whose inventory changed since last sync (so IN-STORE
 * sales propagate online). Invoked by a GitHub-Actions cron — Cloudflare Worker
 * cron isn't usable with OpenNext. Auth + fail-closed gate copied from
 * /api/internal/run-cleanup.
 */
function bearerMatches(authHeader: string, expected: string): boolean {
  const a = new TextEncoder().encode(authHeader);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CHANNEL_RECONCILE_SECRET;
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: "Reconcile endpoint not configured" }, { status: 503 });
  }
  if (!bearerMatches(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
      totalPushed += push.pushed;
      totalFailed += push.failed;
      if (push.failed === 0) {
        await orgQuery(c.organization_id, `UPDATE channel_integrations SET last_sync_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [row.id, c.organization_id]);
      }
      orgsProcessed++;
    } catch (err) {
      console.error("[reconcile-channels] org:", safeErr(err));
    }
  }
  return NextResponse.json({ ok: true, orgs: orgsProcessed, pushed: totalPushed, failed: totalFailed });
}
