import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";
import { getAdminSession } from "@/lib/auth/session";
import { readSafeStore } from "@/lib/persistence/safe-read-store";
import { GiftCardManager } from "@/components/admin/gift-card-manager";

export const metadata: Metadata = {
  title: "Gift Cards",
  description: "Activate, reload, and manage gift card balances.",
};

export default async function GiftCardsPage() {
  const session = await getAdminSession();
  if (!session) redirect("/?error=Please+sign+in+to+continue");

  let store;
  try {
    store = await readSafeStore(session.employee.organizationId);
  } catch (e: unknown) {
    const { safeErr } = await import("@/lib/logging/safe-err");
    console.error("[admin/gift-cards] readStore failed:", safeErr(e));
    redirect("/?error=Store+load+failed");
  }

  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(store.organization?.timezone || "UTC", () => (
    <PageShell
      eyebrow="Customers"
      title="Gift cards"
      description="Activate, reload, and manage gift card balances."
    >
      <TimezoneBootstrap timezone={store.organization?.timezone} />
      <GiftCardManager
        giftCards={store.giftCards}
        transactions={store.giftCardTransactions}
        employees={store.employees}
        customers={store.customers}
      />
    </PageShell>
  ));
}
