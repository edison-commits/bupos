import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { decryptCreds, ensureMapped, getInventoryReconciliation, loadIntegration, pushInventory } from "@/lib/channels/repo";

async function connectedIntegration(orgId: string) {
  const row = await loadIntegration(orgId);
  if (!row || row.status !== "connected") return { error: NextResponse.json({ error: "Connect a Shopify store first" }, { status: 400 }) };
  const creds = await decryptCreds(row);
  if (!creds) return { error: NextResponse.json({ error: "No valid Shopify access token stored" }, { status: 400 }) };
  return { row, creds };
}

export const GET = withAdminAuth("online.manage", async (request, ctx) => {
  const { orgId } = ctx;
  const limit = Math.min(250, Math.max(10, Number(request.nextUrl.searchParams.get("limit") ?? 100)));
  const loaded = await connectedIntegration(orgId);
  if (loaded.error) return loaded.error;
  const { row, creds } = loaded;
  await ensureMapped(row, creds, limit);
  const report = await getInventoryReconciliation(row, creds, limit);
  return NextResponse.json(report);
});

export const POST = withAdminAuth("online.manage", async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`channel-reconcile:${orgId}:${employee.id}`, { maxAttempts: 6, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  if (!(action === 'push_to_shopify')) return NextResponse.json({ error: "Unsupported reconciliation action" }, { status: 400 });
  const loaded = await connectedIntegration(orgId);
  if (loaded.error) return loaded.error;
  const { row, creds } = loaded;
  const variantIds = Array.isArray(body.variantIds) ? body.variantIds.filter((v: unknown): v is string => typeof v === "string") : null;
  const push = await pushInventory(row, creds, variantIds && variantIds.length > 0 ? variantIds : null);
  const report = await getInventoryReconciliation(row, creds, 100);
  return NextResponse.json({ ok: push.failed === 0, action, push, report });
});
