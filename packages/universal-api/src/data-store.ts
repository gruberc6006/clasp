import { ClaspError, Emitter, createId, deepEqual, nowIso, toClaspError, validationError, type JsonObject } from "@clasp/core";
import type { SchemaRegistry } from "@clasp/schemas";
import type { ClaspRecord, RecordChange, RecordOperation } from "./types";

export type RecordWrite = { type: "put"; record: ClaspRecord } | { type: "delete"; collectionId: string; id: string };

/** Durable backing for records. `@clasp/persistence`'s WorkspaceStorage satisfies this. */
export interface RecordPersistence {
  loadRecords(): Promise<ClaspRecord[]>;
  /** Must apply every write atomically. */
  commitRecords(writes: ReadonlyArray<RecordWrite>): Promise<void>;
}

export interface CollectionChange {
  collectionId: string;
  changes: RecordChange[];
}

function byCreation(a: ClaspRecord, b: ClaspRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The authoritative home of application data.
 *
 * Records live here — keyed by collection id — and nowhere else: not in
 * graphs, not in component state. The store is deliberately not reachable
 * from application code; applications go through the kernel, which
 * authorizes each call before touching it.
 *
 * Every mutation is transactional: operations are validated against the
 * collection's schema and applied to a copy, the copy is persisted, and only
 * then does it become visible and are changes announced.
 */
export class DataStore {
  private readonly collections = new Map<string, Map<string, ClaspRecord>>();
  private readonly collectionSchemas = new Map<string, { id: string; version: number }>();
  private readonly events = new Emitter<CollectionChange>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly schemas: SchemaRegistry,
    private readonly persistence?: RecordPersistence,
  ) {}

  /** Loads persisted records. Call once before use. */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    let records: ClaspRecord[];
    try {
      records = await this.persistence.loadRecords();
    } catch (cause) {
      throw toClaspError(cause, "STORAGE_FAILURE");
    }
    for (const record of records) this.table(record.collectionId).set(record.id, record);
  }

  /** Declares a collection and the schema its records must satisfy. Existing records are kept. */
  declareCollection(collectionId: string, schema: { id: string; version: number }): void {
    this.collectionSchemas.set(collectionId, { ...schema });
    this.table(collectionId);
  }

  /** Forgets a collection's declaration. Its records stay in storage. */
  retireCollection(collectionId: string): void {
    this.collectionSchemas.delete(collectionId);
  }

  isDeclared(collectionId: string): boolean {
    return this.collectionSchemas.has(collectionId);
  }

  schemaOf(collectionId: string): { id: string; version: number } | undefined {
    return this.collectionSchemas.get(collectionId);
  }

  /** Every collection id that has a declaration or stored records. */
  collectionIds(): string[] {
    return [...this.collections.keys()].sort();
  }

  /** All records of a collection, oldest first. */
  list(collectionId: string): ClaspRecord[] {
    return [...(this.collections.get(collectionId)?.values() ?? [])].sort(byCreation);
  }

  get(collectionId: string, id: string): ClaspRecord | undefined {
    return this.collections.get(collectionId)?.get(id);
  }

  count(collectionId: string): number {
    return this.collections.get(collectionId)?.size ?? 0;
  }

  /**
   * Applies record operations atomically. Rejects — changing nothing — with
   * VALIDATION_FAILED, NOT_FOUND, ALREADY_EXISTS, CONFLICT or STORAGE_FAILURE.
   */
  apply(collectionId: string, operations: readonly RecordOperation[]): Promise<RecordChange[]> {
    const run = this.queue.then(() => this.applyNow(collectionId, operations));
    // Keep the queue alive after failures; each caller still sees its own rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Permanently erases every record of a collection. */
  purge(collectionId: string): Promise<RecordChange[]> {
    const run = this.queue.then(async () => {
      const table = this.collections.get(collectionId);
      if (!table || table.size === 0) {
        this.collections.delete(collectionId);
        return [];
      }
      const removed = [...table.values()];
      await this.persist(removed.map((record) => ({ type: "delete" as const, collectionId, id: record.id })));
      if (this.collectionSchemas.has(collectionId)) table.clear();
      else this.collections.delete(collectionId);
      const changes: RecordChange[] = removed.map((record) => ({ type: "deleted", collectionId, record }));
      this.events.emit({ collectionId, changes });
      return changes;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  onChange(listener: (change: CollectionChange) => void): () => void {
    return this.events.subscribe(listener);
  }

  private async applyNow(collectionId: string, operations: readonly RecordOperation[]): Promise<RecordChange[]> {
    const schema = this.collectionSchemas.get(collectionId);
    if (!schema) throw new ClaspError("NOT_FOUND", `Collection "${collectionId}" is not declared by any application.`);
    const draft = new Map(this.table(collectionId));
    const changes: RecordChange[] = [];
    const writes: RecordWrite[] = [];
    const now = nowIso();

    for (const operation of operations) {
      switch (operation.operation) {
        case "create": {
          const result = this.schemas.validate(schema, operation.data);
          if (!result.ok) throw validationError(`Cannot create ${schema.id} record`, result.issues);
          const id = operation.id ?? createId("rec");
          if (draft.has(id)) throw new ClaspError("ALREADY_EXISTS", `Record "${id}" already exists in "${collectionId}".`);
          const record: ClaspRecord = { id, collectionId, schema: { ...schema }, version: 1, createdAt: now, updatedAt: now, fields: result.value };
          draft.set(id, record);
          changes.push({ type: "created", collectionId, record });
          writes.push({ type: "put", record });
          break;
        }
        case "update": {
          const existing = draft.get(operation.id);
          if (!existing) throw new ClaspError("NOT_FOUND", `Record "${operation.id}" does not exist in "${collectionId}".`);
          if (operation.expectedVersion !== undefined && operation.expectedVersion !== existing.version) {
            throw new ClaspError(
              "CONFLICT",
              `Record "${operation.id}" is at version ${existing.version}, not ${operation.expectedVersion}. Reload and try again.`,
              { details: { currentVersion: existing.version } },
            );
          }
          const result = this.schemas.validate(schema, operation.data, { partial: true });
          if (!result.ok) throw validationError(`Cannot update ${schema.id} record`, result.issues);
          const fields: JsonObject = { ...existing.fields };
          for (const [name, value] of Object.entries(result.value)) {
            if (value === null) delete fields[name];
            else fields[name] = value;
          }
          if (deepEqual(fields, existing.fields)) break; // nothing actually changes
          const record: ClaspRecord = { ...existing, schema: { ...schema }, version: existing.version + 1, updatedAt: now, fields };
          draft.set(record.id, record);
          changes.push({ type: "updated", collectionId, record, previous: existing });
          writes.push({ type: "put", record });
          break;
        }
        case "delete": {
          const existing = draft.get(operation.id);
          if (!existing) throw new ClaspError("NOT_FOUND", `Record "${operation.id}" does not exist in "${collectionId}".`);
          if (operation.expectedVersion !== undefined && operation.expectedVersion !== existing.version) {
            throw new ClaspError("CONFLICT", `Record "${operation.id}" is at version ${existing.version}, not ${operation.expectedVersion}.`);
          }
          draft.delete(existing.id);
          changes.push({ type: "deleted", collectionId, record: existing });
          writes.push({ type: "delete", collectionId, id: existing.id });
          break;
        }
        default:
          throw new ClaspError("VALIDATION_FAILED", `Unknown record operation: ${JSON.stringify(operation)}`);
      }
    }

    if (changes.length === 0) return [];
    await this.persist(writes);
    this.collections.set(collectionId, draft);
    this.events.emit({ collectionId, changes });
    return changes;
  }

  private async persist(writes: RecordWrite[]): Promise<void> {
    if (!this.persistence || writes.length === 0) return;
    try {
      await this.persistence.commitRecords(writes);
    } catch (cause) {
      const error = toClaspError(cause, "STORAGE_FAILURE");
      throw new ClaspError("STORAGE_FAILURE", `The change could not be saved and was not applied: ${error.message}`, { cause });
    }
  }

  private table(collectionId: string): Map<string, ClaspRecord> {
    let table = this.collections.get(collectionId);
    if (!table) {
      table = new Map();
      this.collections.set(collectionId, table);
    }
    return table;
  }
}
