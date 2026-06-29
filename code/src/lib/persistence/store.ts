import "server-only";

import { cache } from "react";
import type { CustomerDisplayBrandingData, LocalStoreData } from "@/lib/persistence/types";

const isPg = () => !!process.env.USE_POSTGRES;

async function loadJsonStore() {
  return import(/* turbopackIgnore: true */ "@/lib/persistence/json-store");
}

// cache() deduplicates calls within a single React server request,
// so multiple readStore() calls in one page render only hit the DB once.
export const readStore = cache(async function readStore(orgId?: string): Promise<LocalStoreData> {
  if (isPg()) {
    const { readStoreFromPg } = await import("@/lib/persistence/postgres-read-store");
    return readStoreFromPg(orgId);
  }
  const { readJsonStore } = await loadJsonStore();
  return readJsonStore();
});

export const readCustomerDisplayBranding = cache(async function readCustomerDisplayBranding(orgId: string): Promise<CustomerDisplayBrandingData> {
  if (isPg()) {
    const { readCustomerDisplayBrandingFromPg } = await import("@/lib/persistence/postgres-read-store");
    return readCustomerDisplayBrandingFromPg(orgId);
  }
  const store = await readStore(orgId);
  const location = store.locations.find((entry) => entry.isActive) ?? store.locations[0];
  const storeName = store.organization.name;
  return {
    storeName,
    locationName: location?.name ?? "",
    displayName: store.organization.customerDisplayDisplayName || storeName,
    welcomeText: store.organization.customerDisplayWelcomeText || "Welcome",
    idleMessage: store.organization.customerDisplayIdleMessage || "Ready to checkout",
    accentColor: store.organization.customerDisplayAccentColor || "#14b8a6",
  };
});

export async function writeStore(store: LocalStoreData) {
  if (isPg()) {
    // In PG mode, writes go through individual server-action PG functions.
    // This is a no-op to avoid filesystem access.
    return;
  }
  const { writeJsonStore } = await loadJsonStore();
  await writeJsonStore(store);
}

export async function mutateStore<T>(updater: (store: LocalStoreData) => Promise<T> | T): Promise<T> {
  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
}

export async function getStorePath() {
  const { getJsonStorePath } = await loadJsonStore();
  return getJsonStorePath();
}
