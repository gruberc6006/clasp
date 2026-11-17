import { ClaspError, deepClone } from "@clasp/core";

/**
 * The separate stores of a workspace. Definitions, data, permissions,
 * presentation and history never share a store.
 */
export const STORES = ["graphs", "revisions", "records", "grants", "presentation", "schemas", "meta"] as const;
export type StoreName = (typeof STORES)[number];

export type StorageWrite =
  | { store: StoreName; key: string; value: unknown }
  | { store: StoreName; key: string; delete: true };

export interface StorageEntry<T = unknown> {
  key: string;
  value: T;
}

/**
 * A minimal transactional key-value backend. Everything above this interface
 * is backend-agnostic; implement it to add SQLite, the filesystem, or a sync
 * engine.
 */
export interface StorageAdapter {
  readonly kind: string;
  get<T = unknown>(store: StoreName, key: string): Promise<T | undefined>;
  /** Entries whose key starts with `prefix` (all entries when omitted), in key order. */
  list<T = unknown>(store: StoreName, prefix?: string): Promise<Array<StorageEntry<T>>>;
  /** Applies every write atomically: all of them are stored, or none are. */
  commit(writes: readonly StorageWrite[]): Promise<void>;
  /** Removes everything. */
  clear(): Promise<void>;
  close(): void;
}

/** In-memory backend for tests and ephemeral (non-persistent) sessions. */
export class MemoryStorage implements StorageAdapter {
  readonly kind = "memory";
  private stores = new Map<StoreName, Map<string, unknown>>(STORES.map((name) => [name, new Map()]));
  /** Test hook: when set, the next commit rejects with this error and writes nothing. */
  failNextCommit: Error | undefined;

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return deepClone(this.table(store).get(key)) as T | undefined;
  }

  async list<T>(store: StoreName, prefix = ""): Promise<Array<StorageEntry<T>>> {
    return [...this.table(store).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value: deepClone(value) as T }));
  }

  async commit(writes: readonly StorageWrite[]): Promise<void> {
    if (this.failNextCommit) {
      const failure = this.failNextCommit;
      this.failNextCommit = undefined;
      throw new ClaspError("STORAGE_FAILURE", failure.message, { cause: failure });
    }
    for (const write of writes) this.table(write.store); // validate every store before touching anything
    for (const write of writes) {
      if ("delete" in write) this.table(write.store).delete(write.key);
      else this.table(write.store).set(write.key, deepClone(write.value));
    }
  }

  async clear(): Promise<void> {
    this.stores = new Map<StoreName, Map<string, unknown>>(STORES.map((name) => [name, new Map()]));
  }

  close(): void {}

  private table(store: StoreName): Map<string, unknown> {
    const table = this.stores.get(store);
    if (!table) throw new ClaspError("STORAGE_FAILURE", `Unknown store "${store}".`);
    return table;
  }
}
