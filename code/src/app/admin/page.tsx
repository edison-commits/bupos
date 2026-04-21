import { AppNav } from "@/components/layout/app-nav";
import { AdminConsole } from "@/components/admin/admin-console";
import { PageShell } from "@/components/ui/page-shell";
import { getAdminSession } from "@/lib/auth/session";
import { readStore } from "@/lib/persistence/store";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin Overview",
  description: "Overview of your BasicUniformPOS store: sales, inventory alerts, and key metrics.",
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getAdminSession();

  if (!session) {
    redirect("/?error=Please+sign+in+to+continue");
  }

  let store;
  try {
    store = await readStore(session.employee.organizationId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/?error=${encodeURIComponent('Store load failed: ' + msg)}`);
  }
  // The previous implementation called a module-scope `setDefaultTimeZone`,
  // which corrupted TZ state across concurrent Cloudflare Worker requests
  // (R9-C-3). Timezone is now carried by a request-scoped AsyncLocalStorage;
  // we wrap the render in `runWithTimeZone` below so every formatter call
  // inside the tree sees the correct TZ without leaking to other tenants.
  // The <TimezoneBootstrap> client component covers the client-side
  // hydration path for the remaining interactive re-renders.
  const orgTz = store?.organization?.timezone || "UTC";
  const notice = typeof params.notice === "string" ? params.notice.replaceAll("+", " ") : undefined;
  const error = typeof params.error === "string" ? params.error.replaceAll("+", " ") : undefined;

  // Ensure all arrays exist — RPC may omit empty collections or connection drops
  // can produce partial store data. Guard every array field.
  const safeStore = Object.assign({
    locations: [], employees: [], categories: [], products: [], variants: [],
    inventory: [], customers: [], modifierGroups: [], modifiers: [],
    authCredentials: [], sessions: [], shifts: [], registerSessions: [],
    payInOuts: [], promoCodes: [], roles: [],
    inventoryAdjustments: [], transactionEventPlaceholders: [],
    transactionTenderPlaceholders: [], transactionExceptionPlaceholders: [],
    giftCards: [], giftCardTransactions: [], storeCreditLedger: [],
    behaviorFlags: [], layaways: [], layawayPayments: [],
    stocktakes: [], stocktakeLines: [], transfers: [], transferLines: [],
    timeClockEntries: [], promoRedemptions: [], bundles: [],
    suppliers: [], purchaseOrders: [], registers: [], recountSchedules: [],
  }, store);

  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(orgTz, () => (
    <PageShell
      eyebrow="Admin"
      title={safeStore.organization.name}
      description="Manage your store's catalog, inventory, employees, and settings."
    >
      <AppNav />
      <AdminConsole
        store={safeStore}
        adminName={session.employee.displayName}
        adminRole={session.employee.roleKey}
        notice={notice}
        error={error}
      />
    </PageShell>
  ));
}
