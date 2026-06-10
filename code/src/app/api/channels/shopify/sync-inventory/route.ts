import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { loadIntegration, decryptCreds, ensureMapped, pushInventory } from "@/lib/channels/repo";

/**
 * POST: manual "Sync inventory now" — ensure the SKU map is built, then push
 * the fulfillment location's on_hand (absolute) to Shopify. Rate-limited per
 * actor so an admin can't hammer the Shopify API.
 */
export const POST = withAdminAuth("online.manage", async (_req, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`channel-sync:${orgId}:${employee.id}`, { maxAttempts: 10, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const row = await loadIntegration(orgId);
  if (!row || row.status !== "connected") {
    return NextResponse.json({ error: "Connect a store first" }, { status: 400 });
  }
  const creds = await decryptCreds(row);
  if (!creds) return NextResponse.json({ error: "No valid access token stored" }, { status: 400 });

  const map = await ensureMapped(row, creds);
  const push = await pushInventory(row, creds, null);

  // Only advance the sync watermark if nothing failed (so the reconcile cron
  // retries the failures). Record a scrubbed last_error otherwise.
  if (push.failed === 0) {
    await orgQuery(orgId, `UPDATE channel_integrations SET last_sync_at=now(), last_error=NULL, updated_at=now() WHERE id=$1 AND organization_id=$2`, [row.id, orgId]);
  } else {
    await orgQuery(orgId, `UPDATE channel_integrations SET last_error=$1, updated_at=now() WHERE id=$2 AND organization_id=$3`, [push.errors.slice(0, 3).join("; ").slice(0, 300), row.id, orgId]);
  }

  return NextResponse.json({
    ok: push.failed === 0,
    map: { mapped: map.mapped, already_mapped: map.alreadyMapped, unresolved: map.unresolved.length, ambiguous: map.ambiguous.length },
    push: { pushed: push.pushed, skipped: push.skipped, failed: push.failed },
  });
});
