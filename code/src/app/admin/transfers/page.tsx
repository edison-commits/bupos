import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";
import { getAdminSession } from "@/lib/auth/session";
import { readSafeStore } from "@/lib/persistence/safe-read-store";
import { TransferManager } from "@/components/admin/transfer-manager";

export const metadata: Metadata = {
  title: "Transfers",
  description: "Move inventory between store locations.",
};

export default async function TransfersPage() {
  const session = await getAdminSession();
  if (!session) redirect("/?error=Please+sign+in+to+continue");

  let store;
  try {
    store = await readSafeStore(session.employee.organizationId);
  } catch (e: unknown) {
    const { safeErr } = await import("@/lib/logging/safe-err");
    console.error("[admin/transfers] readStore failed:", safeErr(e));
    redirect("/?error=Store+load+failed");
  }

  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(store.organization?.timezone || "UTC", () => (
    <PageShell
      eyebrow="Catalog"
      title="Inter-store transfers"
      description="Move inventory between locations with in-transit tracking."
    >
      <TimezoneBootstrap timezone={store.organization?.timezone} />
      <TransferManager
        transfers={store.transfers}
        transferLines={store.transferLines}
        locations={store.locations}
        variants={store.variants}
        products={store.products}
        employees={store.employees}
      />
    </PageShell>
  ));
}
