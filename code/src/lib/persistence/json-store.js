import "server-only";

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
  const { mkdir, readFile } = await getFs();
  const { DATA_DIR: dir, STORE_PATH: storePath } = await getPaths();
  await mkdir(dir, { recursive: true });

  try {
    await readFile(storePath, "utf8");
  } catch {
    throw new Error(
      "JSON fallback store is missing. Create .data/basicuniformpos-store.json before running without USE_POSTGRES.",
    );
  }
}

export function normalizeStore(store) {
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

export async function readJsonStore() {
  await ensureStoreFile();
  const { readFile } = await getFs();
  const { STORE_PATH: storePath } = await getPaths();
  const raw = await readFile(storePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse store file — data may be corrupt. Restore from backup.");
  }
  return normalizeStore(parsed);
}

export async function writeJsonStore(store) {
  await ensureStoreFile();
  const { writeFile } = await getFs();
  const { STORE_PATH: storePath } = await getPaths();
  await writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), "utf8");
}

export async function getJsonStorePath() {
  const { STORE_PATH: storePath } = await getPaths();
  return storePath;
}
