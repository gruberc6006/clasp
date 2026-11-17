import type { ClaspIssue } from "./errors";
import { Emitter } from "./ids";
import { applyOperations, type ApplyResult, type GraphChange, type GraphOperation } from "./operations";
import type { ClaspGraph, TypeCatalog } from "./types";

export type TransactionOrigin = "user" | "ai" | "runtime" | "import" | "system";

export interface TransactionMeta {
  /** Human-readable description shown in history. */
  label?: string;
  origin?: TransactionOrigin;
  /** Set false to keep the transaction out of the undo stack. */
  history?: boolean;
}

export interface GraphEvent {
  kind: "transaction" | "undo" | "redo" | "replace";
  graph: ClaspGraph;
  previous: ClaspGraph;
  changes: GraphChange[];
  origin: TransactionOrigin;
  label?: string;
}

export interface TransactionResult {
  graph: ClaspGraph;
  changes: GraphChange[];
  warnings: ClaspIssue[];
}

interface HistoryEntry {
  graph: ClaspGraph;
  label?: string;
}

/**
 * Holds the current revision of one graph and is the single place it changes.
 *
 * - `transact` applies operations atomically (all or nothing).
 * - Every committed revision is immutable, so undo/redo are snapshot swaps.
 * - Subscribers (runtime, persistence, editors) are told what changed.
 */
export class GraphStore {
  private current: ClaspGraph;
  private readonly catalog: TypeCatalog | undefined;
  private readonly historyLimit: number;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly events = new Emitter<GraphEvent>();

  constructor(graph: ClaspGraph, options: { catalog?: TypeCatalog; historyLimit?: number } = {}) {
    this.current = graph;
    this.catalog = options.catalog;
    this.historyLimit = options.historyLimit ?? 100;
  }

  get graph(): ClaspGraph {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the transaction `undo()` would revert, if any. */
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  /** Validates and applies operations without committing them. Throws like `transact`. */
  dryRun(operations: readonly GraphOperation[]): ApplyResult {
    return applyOperations(this.current, operations, { catalog: this.catalog });
  }

  /**
   * Commits operations as one transaction. Throws a VALIDATION_FAILED
   * ClaspError — leaving the graph untouched — if any operation is invalid.
   */
  transact(operations: readonly GraphOperation[], meta: TransactionMeta = {}): TransactionResult {
    const result = applyOperations(this.current, operations, { catalog: this.catalog });
    if (result.changes.length === 0) return result;
    const previous = this.current;
    this.current = result.graph;
    if (meta.history !== false) {
      this.undoStack.push({ graph: previous, ...(meta.label !== undefined ? { label: meta.label } : {}) });
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      this.redoStack = [];
    }
    this.events.emit({
      kind: "transaction",
      graph: this.current,
      previous,
      changes: result.changes,
      origin: meta.origin ?? "user",
      ...(meta.label !== undefined ? { label: meta.label } : {}),
    });
    return result;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const previous = this.current;
    this.redoStack.push({ graph: previous, ...(entry.label !== undefined ? { label: entry.label } : {}) });
    this.restore(entry.graph, previous, "undo", entry.label);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const previous = this.current;
    this.undoStack.push({ graph: previous, ...(entry.label !== undefined ? { label: entry.label } : {}) });
    this.restore(entry.graph, previous, "redo", entry.label);
    return true;
  }

  /** Replaces the whole graph (e.g. restoring a stored revision). Undoable. */
  replace(graph: ClaspGraph, meta: TransactionMeta = {}): void {
    const previous = this.current;
    if (meta.history !== false) {
      this.undoStack.push({ graph: previous, ...(meta.label !== undefined ? { label: meta.label } : {}) });
      this.redoStack = [];
    }
    this.restore(graph, previous, "replace", meta.label, meta.origin);
  }

  subscribe(listener: (event: GraphEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  private restore(
    snapshot: ClaspGraph,
    previous: ClaspGraph,
    kind: GraphEvent["kind"],
    label?: string,
    origin: TransactionOrigin = "user",
  ): void {
    // The revision counter stays monotonic even when content goes back in time.
    this.current = { ...snapshot, version: previous.version + 1 };
    this.events.emit({
      kind,
      graph: this.current,
      previous,
      changes: diffGraphs(previous, this.current),
      origin,
      ...(label !== undefined ? { label } : {}),
    });
  }
}

/** Structural diff between two revisions, expressed as graph changes. */
export function diffGraphs(before: ClaspGraph, after: ClaspGraph): GraphChange[] {
  const changes: GraphChange[] = [];
  for (const id of Object.keys(before.connections)) {
    if (!after.connections[id]) changes.push({ kind: "connection-deleted", connectionId: id });
  }
  for (const id of Object.keys(before.objects)) {
    if (!after.objects[id]) changes.push({ kind: "object-deleted", objectId: id });
  }
  for (const [id, object] of Object.entries(after.objects)) {
    const old = before.objects[id];
    if (!old) changes.push({ kind: "object-created", objectId: id });
    else if (old !== object) changes.push({ kind: "object-updated", objectId: id });
  }
  for (const [id, connection] of Object.entries(after.connections)) {
    const old = before.connections[id];
    if (!old) {
      changes.push({ kind: "connection-created", connectionId: id });
    } else if (old !== connection) {
      changes.push({ kind: "connection-deleted", connectionId: id }, { kind: "connection-created", connectionId: id });
    }
  }
  if (before.interface !== after.interface) changes.push({ kind: "interface-changed" });
  if (before.metadata !== after.metadata) changes.push({ kind: "metadata-changed" });
  return changes;
}
