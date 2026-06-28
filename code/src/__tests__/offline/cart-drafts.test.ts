import { beforeEach, describe, expect, it } from "vitest";
import { getAllCartDrafts, getCartDraft, removeCartDraft, saveCartDraft, type CartDraft } from "@/lib/offline/idb-store";

class MemoryObjectStore {
  constructor(private readonly data: Map<string, unknown>) {}

  put(value: { key?: string; id?: string }) {
    const request = makeRequest<unknown>();
    queueMicrotask(() => {
      this.data.set(String(value.key ?? value.id), structuredClone(value));
      request.succeed(value);
    });
    return request;
  }

  get(key: string) {
    const request = makeRequest<unknown>();
    queueMicrotask(() => request.succeed(this.data.get(key) ?? undefined));
    return request;
  }

  getAll() {
    const request = makeRequest<unknown[]>();
    queueMicrotask(() => request.succeed([...this.data.values()].map((v) => structuredClone(v))));
    return request;
  }

  delete(key: string) {
    const request = makeRequest<undefined>();
    queueMicrotask(() => {
      this.data.delete(key);
      request.succeed(undefined);
    });
    return request;
  }

  count() {
    const request = makeRequest<number>();
    queueMicrotask(() => request.succeed(this.data.size));
    return request;
  }
}

class MemoryTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;

  constructor(private readonly stores: Map<string, Map<string, unknown>>) {
    setTimeout(() => this.oncomplete?.(), 0);
  }

  objectStore(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return new MemoryObjectStore(store);
  }
}

class MemoryDB {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  constructor(private readonly stores: Map<string, Map<string, unknown>>) {}

  createObjectStore(name: string) {
    this.stores.set(name, new Map());
  }

  transaction(name: string) {
    return new MemoryTransaction(this.stores).objectStore(name), new MemoryTransaction(this.stores);
  }
}

function makeRequest<T>() {
  return {
    result: undefined as T | undefined,
    error: null as Error | null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
    succeed(value: T) {
      this.result = value;
      this.onsuccess?.();
    },
  };
}

function installIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>();
  const db = new MemoryDB(stores);
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request = {
          result: db,
          error: null,
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
  });
}

function draft(key = "draft-1"): CartDraft {
  return {
    key,
    cart: { id: "cart-1", items: [{ id: "line-1" }] },
    approvedExceptions: ["discount_threshold"],
    appliedPromo: null,
    exchangeCredit: null,
    pendingApprovalIntent: null,
    screen: "selling",
    savedAt: "2026-06-19T12:00:00.000Z",
    registerSessionId: "session-1",
    employeeId: "employee-1",
    locationId: "loc-1",
    deviceId: "device-1",
  };
}

describe("cart draft IndexedDB store", () => {
  beforeEach(() => installIndexedDB());

  it("saves and gets a cart draft", async () => {
    await saveCartDraft(draft());

    await expect(getCartDraft("draft-1")).resolves.toMatchObject({
      key: "draft-1",
      approvedExceptions: ["discount_threshold"],
      registerSessionId: "session-1",
    });
  });

  it("returns all cart drafts and removes drafts", async () => {
    await saveCartDraft(draft("draft-1"));
    await saveCartDraft(draft("draft-2"));

    await expect(getAllCartDrafts()).resolves.toHaveLength(2);

    await removeCartDraft("draft-1");
    await expect(getCartDraft("draft-1")).resolves.toBeNull();
    await expect(getAllCartDrafts()).resolves.toHaveLength(1);
  });
});
