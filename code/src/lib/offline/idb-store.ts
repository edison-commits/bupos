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

function openDB(): Promise<IDBDatabase> {
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

    request.onsuccess = () => resolve(request.result);
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
