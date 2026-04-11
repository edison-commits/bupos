import type { Metadata } from "next";
import { CustomerDisplayClient } from "./customer-display-client";

export const metadata: Metadata = { title: "Customer Display | BasicUniformPOS" };

export const dynamic = "force-dynamic";

export default async function CustomerDisplayPage() {
  // Don't import env at module level — it throws if BUPOS_ORG_ID is missing
  // during static generation. Use dynamic import instead.
  const orgId = process.env.BUPOS_ORG_ID;

  if (!orgId) {
    return <CustomerDisplayClient storeName="" locationName="" />;
  }

  const { readStore } = await import("@/lib/persistence/store");
  const store = await readStore(orgId);
  const location = store.locations[0];

  return (
    <CustomerDisplayClient
      storeName={store.organization.name}
      locationName={location?.name ?? ""}
    />
  );
}
