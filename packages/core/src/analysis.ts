import type { ClaspConnection, ClaspGraph, ClaspObject } from "./types";

/** Deterministic ordering used wherever siblings or peers must be ordered. */
function compareObjects(a: ClaspObject, b: ClaspObject): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.metadata.createdAt !== b.metadata.createdAt) return a.metadata.createdAt < b.metadata.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortObjects(objects: ClaspObject[]): ClaspObject[] {
  return [...objects].sort(compareObjects);
}

/** Children of `parentId`, or the root objects when `parentId` is undefined. */
export function childrenOf(graph: ClaspGraph, parentId: string | undefined): ClaspObject[] {
  return sortObjects(Object.values(graph.objects).filter((object) => object.parentId === parentId));
}

/** Every object nested (at any depth) inside `objectId`, in depth-first order. */
export function descendantsOf(graph: ClaspGraph, objectId: string): ClaspObject[] {
  const result: ClaspObject[] = [];
  const visit = (id: string): void => {
    for (const child of childrenOf(graph, id)) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(objectId);
  return result;
}

export function ancestorsOf(graph: ClaspGraph, objectId: string): ClaspObject[] {
  const result: ClaspObject[] = [];
  const seen = new Set<string>([objectId]);
  let current = graph.objects[objectId]?.parentId;
  while (current && !seen.has(current)) {
    const parent = graph.objects[current];
    if (!parent) break;
    result.push(parent);
    seen.add(current);
    current = parent.parentId;
  }
  return result;
}

export function connectionsFrom(graph: ClaspGraph, objectId: string, port?: string): ClaspConnection[] {
  return Object.values(graph.connections).filter(
    (connection) => connection.source.objectId === objectId && (port === undefined || connection.source.port === port),
  );
}

export function connectionsTo(graph: ClaspGraph, objectId: string, port?: string): ClaspConnection[] {
  return Object.values(graph.connections).filter(
    (connection) => connection.target.objectId === objectId && (port === undefined || connection.target.port === port),
  );
}

/** Objects whose output values feed `objectId` (direct value dependencies). */
export function dependenciesOf(graph: ClaspGraph, objectId: string): string[] {
  const ids = new Set<string>();
  for (const connection of connectionsTo(graph, objectId)) {
    if (connection.kind === "value") ids.add(connection.source.objectId);
  }
  return [...ids];
}

/** Objects that consume values produced by `objectId` (direct value dependents). */
export function dependentsOf(graph: ClaspGraph, objectId: string): string[] {
  const ids = new Set<string>();
  for (const connection of connectionsFrom(graph, objectId)) {
    if (connection.kind === "value") ids.add(connection.target.objectId);
  }
  return [...ids];
}

export interface ExecutionOrder {
  /** Every object id, dependencies before dependents, ties broken deterministically. */
  order: string[];
  /** Objects that participate in a value-dependency cycle (empty when acyclic). */
  cyclic: string[];
}

/**
 * Deterministic execution order: a topological sort over value connections.
 * Event connections do not constrain order — they fire at run time.
 */
export function executionOrder(graph: ClaspGraph): ExecutionOrder {
  const objects = sortObjects(Object.values(graph.objects));
  const pending = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const object of objects) {
    pending.set(object.id, 0);
    dependents.set(object.id, new Set());
  }
  const seenEdges = new Set<string>();
  for (const connection of Object.values(graph.connections)) {
    if (connection.kind !== "value") continue;
    const from = connection.source.objectId;
    const to = connection.target.objectId;
    if (from === to || !pending.has(from) || !pending.has(to)) continue;
    const key = `${from}>${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    dependents.get(from)?.add(to);
    pending.set(to, (pending.get(to) ?? 0) + 1);
  }

  const rank = new Map(objects.map((object, index) => [object.id, index]));
  const ready = objects.filter((object) => pending.get(object.id) === 0).map((object) => object.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    const next: string[] = [];
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (pending.get(dependent) ?? 0) - 1;
      pending.set(dependent, remaining);
      if (remaining === 0) next.push(dependent);
    }
    if (next.length > 0) {
      ready.push(...next);
      ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    }
  }

  const placed = new Set(order);
  const unplaced = objects.filter((object) => !placed.has(object.id)).map((object) => object.id);
  // Objects merely downstream of a cycle are unplaced too; peel them off so
  // only genuine cycle members are reported.
  const inCycle = new Set(unplaced);
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const id of inCycle) {
      const feedsCycle = [...(dependents.get(id) ?? [])].some((dependent) => inCycle.has(dependent));
      if (!feedsCycle) {
        inCycle.delete(id);
        peeled = true;
      }
    }
  }
  // Unplaced objects still get a slot so callers can report on them.
  return { order: [...order, ...unplaced], cyclic: unplaced.filter((id) => inCycle.has(id)) };
}

export interface ObjectQuery {
  type?: string | RegExp;
  name?: string;
  parentId?: string | null;
}

/** Object discovery inside one graph. */
export function findObjects(graph: ClaspGraph, query: ObjectQuery = {}): ClaspObject[] {
  return sortObjects(
    Object.values(graph.objects).filter((object) => {
      if (query.type !== undefined) {
        const matches = typeof query.type === "string" ? object.type === query.type : query.type.test(object.type);
        if (!matches) return false;
      }
      if (query.name !== undefined && object.metadata.name !== query.name) return false;
      if (query.parentId !== undefined && (object.parentId ?? null) !== query.parentId) return false;
      return true;
    }),
  );
}

export function findObject(graph: ClaspGraph, query: ObjectQuery): ClaspObject | undefined {
  return findObjects(graph, query)[0];
}
