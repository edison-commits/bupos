import "server-only";

import { cache } from "react";
import type { LocalStoreData } from "@/lib/persistence/types";

const isPg = () => !!process.env.USE_POSTGRES;

// ── Filesystem helpers (only used when NOT in PG mode) ──────────────
async function getFs() {
  const { mkdir, readFile, writeFile } = await import(/* turbopackIgnore: true */ "node:fs/promises");
  const path = await import(/* turbopackIgnore: true */ "node:path");
  return { mkdir, readFile, writeFile, path };
}

let DATA_DIR: string | undefined;
let STORE_PATH: string | undefined;

async function getPaths() {
  if (!DATA_DIR) {
    const path = await import(/* turbopackIgnore: true */ "node:path");
    DATA_DIR = path.join(process.cwd(), ".data");
    STORE_PATH = path.join(DATA_DIR, "basicuniformpos-store.json");
  }
  return { DATA_DIR: DATA_DIR!, STORE_PATH: STORE_PATH! };
}

async function ensureStoreFile() {
  const { mkdir, readFile, writeFile } = await getFs();
  const { DATA_DIR: dir, STORE_PATH: storePath } = await getPaths();
  await mkdir(dir, { recursive: true });

  try {
    await readFile(storePath, "utf8");
  } catch {
    const { createSeedStore } = await import("@/lib/persistence/seed");
    const seed = createSeedStore();
    await writeFile(storePath, JSON.stringify(seed, null, 2), "utf8");
  }
}

function normalizeStore(store: LocalStoreData): LocalStoreData {
  return {
    ...store,
    customers: store.customers ?? [],
    inventoryAdjustments: store.inventoryAdjustments ?? [],
    shifts: store.shifts ?? [],
    payInOuts: store.payInOuts ?? [],
    registerSessions: store.registerSessions ?? [],
    transactionTenderPlaceholders: store.transactionTenderPlaceholders ?? [],
    transactionEventPlaceholders: store.transactionEventPlaceholders ?? [],
    transactionExceptionPlaceholders: store.transactionExceptionPlaceholders ?? [],
    authCredentials: store.authCredentials ?? [],
    sessions: store.sessions ?? [],
    // Phase 2 entities
    giftCards: store.giftCards ?? [],
    giftCardTransactions: store.giftCardTransactions ?? [],
    storeCreditLedger: store.storeCreditLedger ?? [],
    behaviorFlags: store.behaviorFlags ?? [],
    layaways: store.layaways ?? [],
    layawayPayments: store.layawayPayments ?? [],
    stocktakes: store.stocktakes ?? [],
    stocktakeLines: store.stocktakeLines ?? [],
    transfers: store.transfers ?? [],
    transferLines: store.transferLines ?? [],
    // Phase 3
    timeClockEntries: store.timeClockEntries ?? [],
    promoCodes: store.promoCodes ?? [],
    promoRedemptions: store.promoRedemptions ?? [],
  };
}

// cache() deduplicates calls within a single React server request,
// so multiple readStore() calls in one page render only hit the DB once.
export const readStore = cache(async function readStore(): Promise<LocalStoreData> {
  if (isPg()) {
    const { readStoreFromPg } = await import("@/lib/persistence/postgres-read-store");
    return readStoreFromPg();
  }
  await ensureStoreFile();
  const { readFile } = await getFs();
  const { STORE_PATH: storePath } = await getPaths();
  const raw = await readFile(storePath, "utf8");
  let parsed: LocalStoreData;
  try {
    parsed = JSON.parse(raw) as LocalStoreData;
  } catch {
    throw new Error("Failed to parse store file — data may be corrupt. Restore from backup.");
  }
  return normalizeStore(parsed);
});

export async function writeStore(store: LocalStoreData) {
  if (isPg()) {
    // In PG mode, writes go through individual server-action PG functions.
    // This is a no-op to avoid filesystem access.
    return;
  }
  await ensureStoreFile();
  const { writeFile } = await getFs();
  const { STORE_PATH: storePath } = await getPaths();
  await writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), "utf8");
}

export async function mutateStore<T>(updater: (store: LocalStoreData) => Promise<T> | T): Promise<T> {
  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
}

export async function getStorePath() {
  const { STORE_PATH: storePath } = await getPaths();
  return storePath;
}
