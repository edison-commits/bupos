import "server-only";

import type { LocalStoreData } from "@/lib/persistence/types";

async function getFs() {
  const { mkdir, readFile, writeFile } = await import(/* turbopackIgnore: true */ "node:fs/promises");
  const path = await import(/* turbopackIgnore: true */ "node:path");
  return { mkdir, readFile, writeFile, path };
}

async function getPaths() {
  const path = await import(/* turbopackIgnore: true */ "node:path");
  const DATA_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), ".data");
  const STORE_PATH = path.join(DATA_DIR, "basicuniformpos-store.json");
  return { DATA_DIR, STORE_PATH };
}

async function ensureStoreFile() {
  const { mkdir, readFile, writeFile } = await getFs();
  const { DATA_DIR: dir, STORE_PATH: storePath } = await getPaths();
  await mkdir(dir, { recursive: true });

  try {
    await readFile(storePath, "utf8");
  } catch {
    const { createSeedStore } = await import("@/lib/persistence/seed");
    const seed = await createSeedStore();
    await writeFile(storePath, JSON.stringify(seed, null, 2), "utf8");
  }
}

export function normalizeStore(store: LocalStoreData): LocalStoreData {
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
    timeClockEntries: store.timeClockEntries ?? [],
    promoCodes: store.promoCodes ?? [],
    promoRedemptions: store.promoRedemptions ?? [],
  };
}

export async function readJsonStore(): Promise<LocalStoreData> {
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
}

export async function writeJsonStore(store: LocalStoreData): Promise<void> {
  await ensureStoreFile();
  const { writeFile } = await getFs();
  const { STORE_PATH: storePath } = await getPaths();
  await writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), "utf8");
}

export async function getJsonStorePath(): Promise<string> {
  const { STORE_PATH: storePath } = await getPaths();
  return storePath;
}
