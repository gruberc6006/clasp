import { ClaspError } from "@clasp/core";
import { STORES, type StorageAdapter, type StorageEntry, type StorageWrite, type StoreName } from "./adapter";

const DB_VERSION = 1;

function storageError(message: string, cause: unknown): ClaspError {
  return new ClaspError("STORAGE_FAILURE", message, { cause });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * IndexedDB backend: one database per workspace, one object store per Clasp
 * store, out-of-line string keys. A `commit` is a single IndexedDB
 * transaction, so multi-store writes are atomic.
 */
export class IndexedDbStorage implements StorageAdapter {
  readonly kind = "indexeddb";

  private constructor(
    private readonly db: IDBDatabase,
    readonly name: string,
  ) {}

  static databaseName(workspaceId: string): string {
    return `clasp:${workspaceId}`;
  }

  static open(workspaceId: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IndexedDbStorage> {
    if (!factory) {
      return Promise.reject(new ClaspError("UNAVAILABLE", "IndexedDB is not available in this environment."));
    }
    const name = IndexedDbStorage.databaseName(workspaceId);
    return new Promise<IndexedDbStorage>((resolve, reject) => {
      const request = factory.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading or deleting the database must not be blocked by us.
        db.onversionchange = () => db.close();
        resolve(new IndexedDbStorage(db, name));
      };
      request.onerror = () => reject(storageError(`Could not open workspace storage "${name}".`, request.error));
      request.onblocked = () => reject(storageError(`Workspace storage "${name}" is blocked by another tab.`, undefined));
    });
  }

  /** Permanently deletes a workspace database. */
  static destroy(workspaceId: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
    if (!factory) return Promise.resolve();
    const name = IndexedDbStorage.databaseName(workspaceId);
    return new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(storageError(`Could not delete workspace storage "${name}".`, request.error));
      request.onblocked = () => resolve();
    });
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    try {
      const transaction = this.db.transaction(store, "readonly");
      return (await promisify(transaction.objectStore(store).get(key))) as T | undefined;
    } catch (cause) {
      throw storageError(`Could not read "${key}" from ${store}.`, cause);
    }
  }

  async list<T>(store: StoreName, prefix = ""): Promise<Array<StorageEntry<T>>> {
    try {
      const objectStore = this.db.transaction(store, "readonly").objectStore(store);
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
      const [keys, values] = await Promise.all([
        promisify(objectStore.getAllKeys(range)),
        promisify(objectStore.getAll(range)),
      ]);
      return keys.map((key, index) => ({ key: String(key), value: values[index] as T }));
    } catch (cause) {
      throw storageError(`Could not list ${store}.`, cause);
    }
  }

  commit(writes: readonly StorageWrite[]): Promise<void> {
    if (writes.length === 0) return Promise.resolve();
    const stores = [...new Set(writes.map((write) => write.store))];
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = this.db.transaction(stores, "readwrite");
      } catch (cause) {
        reject(storageError("Could not start a storage transaction.", cause));
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(storageError("Storage transaction was aborted; nothing was written.", transaction.error));
      transaction.onerror = () => reject(storageError("Storage transaction failed; nothing was written.", transaction.error));
      try {
        for (const write of writes) {
          const objectStore = transaction.objectStore(write.store);
          if ("delete" in write) objectStore.delete(write.key);
          else objectStore.put(write.value, write.key);
        }
      } catch (cause) {
        // e.g. a value that cannot be cloned: abort so no partial write survives.
        try {
          transaction.abort();
        } catch {
          // Already aborted by the failing request.
        }
        reject(storageError("A value could not be stored; nothing was written.", cause));
      }
    });
  }

  clear(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.db.transaction([...STORES], "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError("Could not clear workspace storage.", transaction.error));
      for (const store of STORES) transaction.objectStore(store).clear();
    });
  }

  close(): void {
    this.db.close();
  }
}
