import { ClaspError, nowIso, parseGraph, type ClaspGraph } from "@clasp/core";
import { STORES, type StorageAdapter, type StorageEntry, type StorageWrite, type StoreName } from "./adapter";

/** A saved point in an application's definition history. */
export interface GraphRevision {
  graphId: string;
  version: number;
  savedAt: string;
  label?: string;
  origin?: string;
  graph: ClaspGraph;
}

export type GraphRevisionSummary = Omit<GraphRevision, "graph"> & { objectCount: number; connectionCount: number };

/** Where objects sit on the Build-mode canvas. Never part of the definition. */
export interface PresentationState {
  graphId: string;
  nodes: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

interface KeyedRecord {
  id: string;
  collectionId: string;
}

export type RecordWrite<T extends KeyedRecord = KeyedRecord> =
  | { type: "put"; record: T }
  | { type: "delete"; collectionId: string; id: string };

export const WORKSPACE_DUMP_FORMAT = "clasp.workspace";

/** A complete, portable copy of a workspace's storage. */
export interface WorkspaceDump {
  format: typeof WORKSPACE_DUMP_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  stores: Record<StoreName, StorageEntry[]>;
}

function revisionKey(graphId: string, version: number): string {
  return `${graphId}/${String(version).padStart(10, "0")}`;
}

function recordKey(collectionId: string, id: string): string {
  return `${collectionId}/${id}`;
}

/**
 * Typed access to one workspace's storage, on top of any StorageAdapter.
 *
 * Application definitions (`graphs`, `revisions`) and user data (`records`)
 * are stored separately: saving, replacing or even deleting a definition never
 * touches records unless the caller explicitly asks for that.
 */
export class WorkspaceStorage {
  constructor(
    readonly adapter: StorageAdapter,
    private readonly options: { revisionLimit?: number } = {},
  ) {}

  // ── application definitions ────────────────────────────────────────────

  /** Saves a graph and records it as a revision, atomically. */
  async saveGraph(graph: ClaspGraph, meta: { label?: string; origin?: string; revision?: boolean } = {}): Promise<void> {
    const writes: StorageWrite[] = [{ store: "graphs", key: graph.id, value: graph }];
    if (meta.revision !== false) {
      const revision: GraphRevision = {
        graphId: graph.id,
        version: graph.version,
        savedAt: nowIso(),
        ...(meta.label !== undefined ? { label: meta.label } : {}),
        ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
        graph,
      };
      writes.push({ store: "revisions", key: revisionKey(graph.id, graph.version), value: revision });
    }
    await this.adapter.commit(writes);
    if (meta.revision !== false) await this.trimRevisions(graph.id);
  }

  async loadGraph(id: string): Promise<ClaspGraph | undefined> {
    const stored = await this.adapter.get("graphs", id);
    return stored === undefined ? undefined : parseGraph(stored);
  }

  async loadGraphs(): Promise<ClaspGraph[]> {
    const entries = await this.adapter.list("graphs");
    return entries.map((entry) => parseGraph(entry.value));
  }

  /**
   * Deletes an application definition, its revisions and its canvas layout.
   * Records are kept unless `purgeCollections` lists collection ids to erase.
   */
  async deleteGraph(id: string, options: { purgeCollections?: string[] } = {}): Promise<void> {
    const writes: StorageWrite[] = [
      { store: "graphs", key: id, delete: true },
      { store: "presentation", key: id, delete: true },
    ];
    for (const entry of await this.adapter.list("revisions", `${id}/`)) {
      writes.push({ store: "revisions", key: entry.key, delete: true });
    }
    for (const collectionId of options.purgeCollections ?? []) {
      for (const entry of await this.adapter.list("records", `${collectionId}/`)) {
        writes.push({ store: "records", key: entry.key, delete: true });
      }
    }
    await this.adapter.commit(writes);
  }

  // ── revision history ───────────────────────────────────────────────────

  async listRevisions(graphId: string): Promise<GraphRevisionSummary[]> {
    const entries = await this.adapter.list<GraphRevision>("revisions", `${graphId}/`);
    return entries
      .map(({ value }) => ({
        graphId: value.graphId,
        version: value.version,
        savedAt: value.savedAt,
        ...(value.label !== undefined ? { label: value.label } : {}),
        ...(value.origin !== undefined ? { origin: value.origin } : {}),
        objectCount: Object.keys(value.graph.objects).length,
        connectionCount: Object.keys(value.graph.connections).length,
      }))
      .reverse();
  }

  async loadRevision(graphId: string, version: number): Promise<ClaspGraph> {
    const stored = await this.adapter.get<GraphRevision>("revisions", revisionKey(graphId, version));
    if (!stored) throw new ClaspError("NOT_FOUND", `Revision ${version} of "${graphId}" is not stored.`);
    return parseGraph(stored.graph);
  }

  private async trimRevisions(graphId: string): Promise<void> {
    const limit = this.options.revisionLimit ?? 50;
    const entries = await this.adapter.list("revisions", `${graphId}/`);
    if (entries.length <= limit) return;
    const stale = entries.slice(0, entries.length - limit);
    await this.adapter.commit(stale.map((entry) => ({ store: "revisions" as const, key: entry.key, delete: true as const })));
  }

  // ── application data (records) ─────────────────────────────────────────

  async loadRecords<T extends KeyedRecord = KeyedRecord>(): Promise<T[]> {
    const entries = await this.adapter.list<T>("records");
    return entries.map((entry) => entry.value);
  }

  /** Applies record writes atomically. */
  commitRecords(writes: ReadonlyArray<RecordWrite>): Promise<void> {
    return this.adapter.commit(
      writes.map((write): StorageWrite =>
        write.type === "put"
          ? { store: "records", key: recordKey(write.record.collectionId, write.record.id), value: write.record }
          : { store: "records", key: recordKey(write.collectionId, write.id), delete: true },
      ),
    );
  }

  // ── permissions ────────────────────────────────────────────────────────

  async loadGrants<T extends { id: string }>(): Promise<T[]> {
    const entries = await this.adapter.list<T>("grants");
    return entries.map((entry) => entry.value);
  }

  /** Replaces the stored grants with exactly `grants`, atomically. */
  async saveGrants(grants: ReadonlyArray<{ id: string }>): Promise<void> {
    const keep = new Set(grants.map((grant) => grant.id));
    const writes: StorageWrite[] = grants.map((grant) => ({ store: "grants", key: grant.id, value: grant }));
    for (const entry of await this.adapter.list("grants")) {
      if (!keep.has(entry.key)) writes.push({ store: "grants", key: entry.key, delete: true });
    }
    await this.adapter.commit(writes);
  }

  // ── presentation state ─────────────────────────────────────────────────

  loadPresentation(graphId: string): Promise<PresentationState | undefined> {
    return this.adapter.get<PresentationState>("presentation", graphId);
  }

  savePresentation(state: PresentationState): Promise<void> {
    return this.adapter.commit([{ store: "presentation", key: state.graphId, value: state }]);
  }

  // ── custom schemas ─────────────────────────────────────────────────────

  async loadSchemas<T extends { id: string; version: number }>(): Promise<T[]> {
    const entries = await this.adapter.list<T>("schemas");
    return entries.map((entry) => entry.value);
  }

  saveSchema(schema: { id: string; version: number }): Promise<void> {
    return this.adapter.commit([{ store: "schemas", key: `${schema.id}@${schema.version}`, value: schema }]);
  }

  // ── workspace metadata ─────────────────────────────────────────────────

  getMeta<T>(key: string): Promise<T | undefined> {
    return this.adapter.get<T>("meta", key);
  }

  setMeta(key: string, value: unknown): Promise<void> {
    return this.adapter.commit([{ store: "meta", key, value }]);
  }

  // ── whole-workspace import / export ────────────────────────────────────

  async exportAll(): Promise<WorkspaceDump> {
    const stores = {} as Record<StoreName, StorageEntry[]>;
    for (const store of STORES) stores[store] = await this.adapter.list(store);
    return { format: WORKSPACE_DUMP_FORMAT, formatVersion: 1, exportedAt: nowIso(), stores };
  }

  /** Replaces the workspace's contents with a dump. Graphs are validated first. */
  async importAll(dump: WorkspaceDump): Promise<void> {
    if (dump?.format !== WORKSPACE_DUMP_FORMAT || dump.formatVersion !== 1) {
      throw new ClaspError("INCOMPATIBLE", "This is not a Clasp workspace export this build understands.");
    }
    for (const entry of dump.stores.graphs ?? []) parseGraph(entry.value);
    const writes: StorageWrite[] = [];
    for (const store of STORES) {
      for (const entry of dump.stores[store] ?? []) writes.push({ store, key: entry.key, value: entry.value });
    }
    await this.adapter.clear();
    await this.adapter.commit(writes);
  }
}
