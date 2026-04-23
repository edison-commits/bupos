/**
 * IndexedDB wrapper for offline POS data.
 *
 * Stores:
 *  - productCatalog: products, variants, categories, inventory cached from server
 *  - pendingTransactions: checkout payloads queued while offline
 */

const DB_NAME = "basicuniformpos";
const DB_VERSION = 1;

export interface PendingTransaction {
  id: string;
  cart: unknown; // Cart snapshot
  tenders: unknown[]; // TenderEntry[]
  approvedExceptions: string[];
  totals: unknown; // CartTotals
  timestamp: string;
  employeeName: string;
  /** Number of sync attempts */
  attempts: number;
  /** Last error message if sync failed */
  lastError?: string;
}

export interface CachedCatalog {
  products: unknown[];
  variants: unknown[];
  categories: unknown[];
  inventory: unknown[];
  cachedAt: string;
}

// Cache the DB instance to prevent connection leak over long POS sessions.
let _dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbInstance) return Promise.resolve(_dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pendingTransactions")) {
        db.createObjectStore("pendingTransactions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("catalog")) {
        db.createObjectStore("catalog", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      _dbInstance = request.result;
      // Reset cached instance if the connection is closed externally
      _dbInstance.onclose = () => { _dbInstance = null; };
      resolve(_dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

// ─── Pending transactions ───────────────────────────────────────────

export async function savePendingTransaction(txn: PendingTransaction): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingTransactions", "readwrite");
    tx.objectStore("pendingTransactions").put(txn);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingTransactions(): Promise<PendingTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingTransactions", "readonly");
    const request = tx.objectStore("pendingTransactions").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function removePendingTransaction(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingTransactions", "readwrite");
    tx.objectStore("pendingTransactions").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingTransactions", "readonly");
    const request = tx.objectStore("pendingTransactions").count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * R32-D10: purge pending transactions older than `maxAgeDays`. Default
 * is 30 days — a retry-exhausted dead letter that never synced carries
 * a full cart snapshot (customer id, line items, tender amounts), and
 * without a TTL it sits in IndexedDB forever until the user uninstalls
 * the PWA. Called on app boot + periodically by use-online-status.
 * Returns the count of purged rows (so ops can surface it).
 */
export async function purgeStaleDeadLetters(maxAgeDays = 30): Promise<number> {
  const db = await openDB();
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingTransactions", "readwrite");
    const store = tx.objectStore("pendingTransactions");
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      const all = getAll.result as PendingTransaction[];
      let purged = 0;
      for (const t of all) {
        const ts = t.timestamp ? Date.parse(t.timestamp) : 0;
        if (Number.isFinite(ts) && ts > 0 && ts < cutoff) {
          store.delete(t.id);
          purged++;
        }
      }
      tx.oncomplete = () => resolve(purged);
      tx.onerror = () => reject(tx.error);
    };
    getAll.onerror = () => reject(getAll.error);
  });
}

// ─── Product catalog cache ──────────────────────────────────────────

export async function cacheCatalog(catalog: CachedCatalog): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("catalog", "readwrite");
    tx.objectStore("catalog").put({ key: "current", ...catalog });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedCatalog(): Promise<CachedCatalog | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("catalog", "readonly");
    const request = tx.objectStore("catalog").get("current");
    request.onsuccess = () => {
      const result = request.result;
      if (result) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { key, ...catalog } = result;
        resolve(catalog as CachedCatalog);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// R46-M3: wipe the cached catalog. Shared POS devices where one
// cashier logs out and a different-tenant cashier logs in would
// otherwise serve the previous tenant's products / inventory / prices
// to the new one during offline mode. Called from clearLocalRegisterState
// on logout.
export async function clearCatalog(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("catalog", "readwrite");
    tx.objectStore("catalog").delete("current");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
