import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";
import { getAdminSession } from "@/lib/auth/session";
import { readSafeStore } from "@/lib/persistence/safe-read-store";
import { LayawayManager } from "@/components/admin/layaway-manager";

export const metadata: Metadata = {
  title: "Layaways",
  description: "Deposit-now-pay-later orders: track balances and payments.",
};

export default async function LayawaysPage() {
  const session = await getAdminSession();
  if (!session) redirect("/?error=Please+sign+in+to+continue");

  let store;
  try {
    store = await readSafeStore(session.employee.organizationId);
  } catch (e: unknown) {
    const { safeErr } = await import("@/lib/logging/safe-err");
    console.error("[admin/layaways] readStore failed:", safeErr(e));
    redirect("/?error=Store+load+failed");
  }

  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(store.organization?.timezone || "UTC", () => (
    <PageShell
      eyebrow="Customers"
      title="Layaways"
      description="Deposit-now-pay-later workflows: track balances, record payments, and complete orders."
    >
      <TimezoneBootstrap timezone={store.organization?.timezone} />
      <LayawayManager
        layaways={store.layaways}
        payments={store.layawayPayments}
        customers={store.customers}
        employees={store.employees}
      />
    </PageShell>
  ));
}
