import { descendantsOf } from "./analysis";
import { ClaspError, hasErrors, issue, validationError, type ClaspIssue } from "./errors";
import { createId, nowIso } from "./ids";
import { deepClone, deepEqual, type JsonObject } from "./json";
import {
  GRAPH_FORMAT_VERSION,
  emptyInterface,
  type ClaspConnection,
  type ClaspGraph,
  type ClaspObject,
  type GraphInterface,
  type GraphOrigin,
  type PortRef,
  type TypeCatalog,
} from "./types";
import { resolveConnection, validateGraph } from "./validate";

/** Input for creating an object. Omitted fields get sensible defaults. */
export interface ObjectInput {
  id?: string;
  type: string;
  typeVersion?: number;
  properties?: JsonObject;
  parentId?: string;
  order?: number;
  name?: string;
  description?: string;
  ownerId?: string;
}

export interface ConnectionInput {
  id?: string;
  source: PortRef;
  target: PortRef;
}

/**
 * The only way a graph changes. Editors, the AI and importers all produce
 * these operations; nobody mutates a graph directly.
 */
export type GraphOperation =
  | { op: "create"; object: ObjectInput }
  | {
      op: "update";
      objectId: string;
      /** Shallow-merged into the existing properties. */
      properties?: JsonObject;
      /** Property names to remove. */
      unset?: string[];
      name?: string;
      description?: string;
      /** `null` moves the object to the root. */
      parentId?: string | null;
      order?: number;
    }
  | { op: "delete"; objectId: string }
  | { op: "connect"; connection: ConnectionInput }
  | { op: "disconnect"; connectionId: string }
  | { op: "setInterface"; interface: GraphInterface }
  | { op: "setMetadata"; name?: string; description?: string; origin?: GraphOrigin };

export type GraphChange =
  | { kind: "object-created"; objectId: string }
  | { kind: "object-updated"; objectId: string }
  | { kind: "object-deleted"; objectId: string }
  | { kind: "connection-created"; connectionId: string }
  | { kind: "connection-deleted"; connectionId: string }
  | { kind: "interface-changed" }
  | { kind: "metadata-changed" };

export interface ApplyOptions {
  catalog?: TypeCatalog;
  /** Timestamp to stamp on changed objects (injectable for deterministic tests). */
  now?: string;
}

export interface ApplyResult {
  graph: ClaspGraph;
  changes: GraphChange[];
  /** Non-blocking findings (warnings) from validation. */
  warnings: ClaspIssue[];
}

export function createGraph(input: { name: string; id?: string; description?: string; now?: string }): ClaspGraph {
  const now = input.now ?? nowIso();
  return {
    id: input.id ?? createId("app"),
    formatVersion: GRAPH_FORMAT_VERSION,
    version: 0,
    objects: {},
    connections: {},
    interface: emptyInterface(),
    metadata: {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
    },
  };
}

function nextOrder(graph: ClaspGraph, parentId: string | undefined): number {
  let max = -1;
  for (const object of Object.values(graph.objects)) {
    if (object.parentId === parentId && object.order > max) max = object.order;
  }
  return max + 1;
}

function fail(code: string, message: string, extra: Partial<ClaspIssue> = {}): never {
  throw validationError("Graph operation rejected", [issue(code, message, extra)]);
}

function pruneInterface(graph: ClaspGraph, removed: ReadonlySet<string>): boolean {
  const before = graph.interface;
  const next: GraphInterface = {
    actions: before.actions.filter((entry) => !removed.has(entry.target.objectId)),
    events: before.events.filter((entry) => !removed.has(entry.source.objectId)),
    outputs: before.outputs.filter((entry) => !removed.has(entry.source.objectId)),
    inputs: before.inputs.filter((entry) => !removed.has(entry.target.objectId)),
    views: before.views.filter((entry) => !removed.has(entry.root)),
  };
  if (deepEqual(before, next)) return false;
  graph.interface = next;
  return true;
}

/**
 * Applies operations as one atomic transaction.
 *
 * The input graph is never modified. Either every operation applies and the
 * resulting graph validates — in which case the new graph is returned — or a
 * VALIDATION_FAILED ClaspError is thrown and nothing changes (rollback by
 * construction).
 */
export function applyOperations(
  graph: ClaspGraph,
  operations: readonly GraphOperation[],
  options: ApplyOptions = {},
): ApplyResult {
  const now = options.now ?? nowIso();
  const catalog = options.catalog;
  // Shallow copies: untouched objects are shared with the previous graph.
  const next: ClaspGraph = {
    ...graph,
    objects: { ...graph.objects },
    connections: { ...graph.connections },
    metadata: { ...graph.metadata },
  };
  const changes: GraphChange[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case "create": {
        const input = operation.object;
        const id = input.id ?? createId("obj");
        if (next.objects[id] || next.connections[id]) fail("DUPLICATE_ID", `An object or connection with id "${id}" already exists.`);
        if (!input.type) fail("INVALID_OBJECT", `Object "${id}" has no type.`, { objectId: id });
        if (input.parentId !== undefined && !next.objects[input.parentId]) {
          fail("MISSING_PARENT", `Parent "${input.parentId}" of new object "${id}" does not exist.`, { objectId: id });
        }
        const info = catalog?.describe({ type: input.type, typeVersion: input.typeVersion ?? 0, properties: input.properties ?? {} });
        const object: ClaspObject = {
          id,
          type: input.type,
          typeVersion: input.typeVersion ?? info?.version ?? 1,
          version: 1,
          properties: deepClone(input.properties ?? {}),
          order: input.order ?? nextOrder(next, input.parentId),
          metadata: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            createdAt: now,
            updatedAt: now,
          },
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        };
        next.objects[id] = object;
        changes.push({ kind: "object-created", objectId: id });
        break;
      }
      case "update": {
        const existing = next.objects[operation.objectId];
        if (!existing) fail("MISSING_OBJECT", `Cannot update missing object "${operation.objectId}".`);
        const properties: JsonObject = { ...existing.properties, ...deepClone(operation.properties ?? {}) };
        for (const key of operation.unset ?? []) delete properties[key];
        const metadata = { ...existing.metadata, updatedAt: now };
        if (operation.name !== undefined) metadata.name = operation.name;
        if (operation.description !== undefined) metadata.description = operation.description;
        const updated: ClaspObject = { ...existing, properties, metadata, version: existing.version + 1 };
        if (operation.parentId !== undefined) {
          if (operation.parentId === null) {
            delete updated.parentId;
          } else {
            if (!next.objects[operation.parentId]) {
              fail("MISSING_PARENT", `Cannot move "${existing.id}" into missing object "${operation.parentId}".`, {
                objectId: existing.id,
              });
            }
            updated.parentId = operation.parentId;
          }
          if (operation.order === undefined && updated.parentId !== existing.parentId) {
            updated.order = nextOrder(next, updated.parentId);
          }
        }
        if (operation.order !== undefined) updated.order = operation.order;
        next.objects[existing.id] = updated;
        changes.push({ kind: "object-updated", objectId: existing.id });
        break;
      }
      case "delete": {
        const existing = next.objects[operation.objectId];
        if (!existing) fail("MISSING_OBJECT", `Cannot delete missing object "${operation.objectId}".`);
        const removed = new Set<string>([existing.id, ...descendantsOf(next, existing.id).map((object) => object.id)]);
        for (const connection of Object.values(next.connections)) {
          if (removed.has(connection.source.objectId) || removed.has(connection.target.objectId)) {
            delete next.connections[connection.id];
            changes.push({ kind: "connection-deleted", connectionId: connection.id });
          }
        }
        for (const id of removed) {
          delete next.objects[id];
          changes.push({ kind: "object-deleted", objectId: id });
        }
        if (pruneInterface(next, removed)) changes.push({ kind: "interface-changed" });
        break;
      }
      case "connect": {
        const input = operation.connection;
        const id = input.id ?? createId("con");
        if (next.connections[id] || next.objects[id]) fail("DUPLICATE_ID", `An object or connection with id "${id}" already exists.`);
        const { resolved, issues } = resolveConnection(next, catalog, input.source, input.target, id);
        if (!resolved || hasErrors(issues)) throw validationError("Connection rejected", issues);
        const connection: ClaspConnection = {
          id,
          kind: resolved.kind,
          source: { ...input.source },
          target: { ...input.target },
        };
        next.connections[id] = connection;
        changes.push({ kind: "connection-created", connectionId: id });
        break;
      }
      case "disconnect": {
        if (!next.connections[operation.connectionId]) {
          fail("MISSING_CONNECTION", `Cannot remove missing connection "${operation.connectionId}".`);
        }
        delete next.connections[operation.connectionId];
        changes.push({ kind: "connection-deleted", connectionId: operation.connectionId });
        break;
      }
      case "setInterface": {
        next.interface = deepClone(operation.interface);
        changes.push({ kind: "interface-changed" });
        break;
      }
      case "setMetadata": {
        if (operation.name !== undefined) {
          if (!operation.name.trim()) fail("INVALID_METADATA", "An application needs a name.");
          next.metadata.name = operation.name;
        }
        if (operation.description !== undefined) next.metadata.description = operation.description;
        if (operation.origin !== undefined) next.metadata.origin = operation.origin;
        changes.push({ kind: "metadata-changed" });
        break;
      }
      default: {
        const unknown: never = operation;
        throw new ClaspError("INVALID_OPERATION", `Unknown graph operation: ${JSON.stringify(unknown)}`);
      }
    }
  }

  const issues = validateGraph(next, catalog);
  if (hasErrors(issues)) throw validationError("Graph transaction rejected", issues);

  if (changes.length > 0) {
    next.version = graph.version + 1;
    next.metadata.updatedAt = now;
  }
  return { graph: next, changes, warnings: issues.filter((entry) => entry.severity === "warning") };
}
