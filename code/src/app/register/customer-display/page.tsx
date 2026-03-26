import { readStore } from "@/lib/persistence/store";
import { CustomerDisplayClient } from "./customer-display-client";

export const dynamic = "force-dynamic";

export default async function CustomerDisplayPage() {
  const store = await readStore();
  const location = store.locations[0];

  return (
    <CustomerDisplayClient
      storeName={store.organization.name}
      locationName={location?.name ?? ""}
    />
  );
}
