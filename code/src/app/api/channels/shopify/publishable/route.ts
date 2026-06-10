import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { loadIntegration, listPublishableProducts } from "@/lib/channels/repo";

/**
 * GET: active BuPOS products (with SKU'd variants) that aren't on Shopify yet —
 * the candidates for Phase 3c publishing. Read-only, org-scoped.
 */
export const GET = withAdminAuth("online.manage", async (_req, ctx) => {
  const { orgId } = ctx;
  const row = await loadIntegration(orgId);
  if (!row) return NextResponse.json({ connected: false, products: [] });
  const products = await listPublishableProducts(row);
  return NextResponse.json({ connected: row.status === "connected", products });
});
