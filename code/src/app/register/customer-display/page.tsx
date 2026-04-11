import type { Metadata } from "next";
import { readStore } from "@/lib/persistence/store";
import { BUPOS_ORG_ID } from "@/lib/env";
import { CustomerDisplayClient } from "./customer-display-client";

export const metadata: Metadata = { title: "Customer Display | BasicUniformPOS" };

export const dynamic = "force-dynamic";

export default async function CustomerDisplayPage() {
  const store = await readStore(BUPOS_ORG_ID);
  const location = store.locations[0];

  return (
    <CustomerDisplayClient
      storeName={store.organization.name}
      locationName={location?.name ?? ""}
    />
  );
}
