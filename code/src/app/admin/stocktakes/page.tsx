import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";
import { getAdminSession } from "@/lib/auth/session";
import { readSafeStore } from "@/lib/persistence/safe-read-store";
import { StocktakeManager } from "@/components/admin/stocktake-manager";

export const metadata: Metadata = {
  title: "Stocktakes",
  description: "Physical inventory counts with expected vs actual comparison.",
};

export default async function StocktakesPage() {
  const session = await getAdminSession();
  if (!session) redirect("/?error=Please+sign+in+to+continue");

  let store;
  try {
    store = await readSafeStore(session.employee.organizationId);
  } catch (e: unknown) {
    const { safeErr } = await import("@/lib/logging/safe-err");
    console.error("[admin/stocktakes] readStore failed:", safeErr(e));
    redirect("/?error=Store+load+failed");
  }

  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(store.organization?.timezone || "UTC", () => (
    <PageShell
      eyebrow="Catalog"
      title="Stocktakes"
      description="Physical inventory counts with expected vs actual comparison and one-click variance posting."
    >
      <TimezoneBootstrap timezone={store.organization?.timezone} />
      <StocktakeManager
        stocktakes={store.stocktakes}
        lines={store.stocktakeLines}
        locations={store.locations}
        variants={store.variants}
        products={store.products}
        categories={store.categories}
        employees={store.employees}
      />
    </PageShell>
  ));
}
