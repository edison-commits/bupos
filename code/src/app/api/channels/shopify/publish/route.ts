import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { loadIntegration, decryptCreds, publishProducts } from "@/lib/channels/repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_CALL = 25;

/**
 * POST: publish selected BuPOS products to Shopify (create each as a product
 * with its variants), then map them so inventory/price sync flows thereafter.
 * Rate-limited per actor; input validated to 400 (never 500) on bad ids.
 */
export const POST = withAdminAuth("online.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`channel-publish:${orgId}:${employee.id}`, { maxAttempts: 10, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const body = (await req.json().catch(() => null)) as { productIds?: unknown } | null;
  const ids = Array.isArray(body?.productIds) ? body.productIds : null;
  if (!ids || ids.length === 0) return NextResponse.json({ error: "Select at least one product" }, { status: 400 });
  if (ids.length > MAX_PER_CALL) return NextResponse.json({ error: `Publish at most ${MAX_PER_CALL} products at a time` }, { status: 400 });
  const productIds = ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
  if (productIds.length !== ids.length) return NextResponse.json({ error: "Invalid product id" }, { status: 400 });

  const row = await loadIntegration(orgId);
  if (!row || row.status !== "connected") return NextResponse.json({ error: "Connect a store first" }, { status: 400 });
  if (!row.shopify_location_id) return NextResponse.json({ error: "Run Test connection first (no Shopify location set)" }, { status: 400 });
  const creds = await decryptCreds(row);
  if (!creds) return NextResponse.json({ error: "No valid access token stored" }, { status: 400 });

  const summary = await publishProducts(row, creds, productIds);
  return NextResponse.json({ ok: summary.failed.length === 0, published: summary.published, failed: summary.failed });
});
