import { childrenOf, connectionsFrom, connectionsTo, sortObjects, type ClaspGraph, type ClaspObject } from "@clasp/core";
import type { ComponentRegistry } from "@clasp/runtime";

export interface Point {
  x: number;
  y: number;
}

export const NODE_WIDTH = 224;
const COLUMN = 300;
const GAP = 28;

/** Rough rendered height of a node, used only to stack nodes without overlap. */
export function estimateHeight(object: ClaspObject, registry: ComponentRegistry): number {
  const ports = registry.portsOf(object);
  const rows = ports ? Math.max(ports.inputs.length + ports.actions.length, ports.outputs.length + ports.events.length) : 0;
  return 52 + rows * 22 + (rows > 0 ? 12 : 0);
}

function isVisual(object: ClaspObject, registry: ComponentRegistry): boolean {
  return registry.get(object.type)?.category === "interface" || object.parentId !== undefined;
}

/** Lays out a whole graph: the interface tree on the left by depth, everything else in dependency columns to its right. */
function fullLayout(graph: ClaspGraph, registry: ComponentRegistry): Record<string, Point> {
  const positions: Record<string, Point> = {};
  const objects = sortObjects(Object.values(graph.objects));
  const visual = objects.filter((object) => isVisual(object, registry));
  const others = objects.filter((object) => !isVisual(object, registry));

  // Interface tree: one column per depth, rows in document order.
  let cursor = 0;
  let maxDepth = -1;
  const place = (object: ClaspObject, depth: number): void => {
    positions[object.id] = { x: depth * COLUMN, y: cursor };
    maxDepth = Math.max(maxDepth, depth);
    const children = childrenOf(graph, object.id);
    if (children.length === 0) {
      cursor += estimateHeight(object, registry) + GAP;
      return;
    }
    const start = cursor;
    for (const child of children) place(child, depth + 1);
    cursor = Math.max(cursor, start + estimateHeight(object, registry) + GAP);
  };
  for (const root of visual.filter((object) => object.parentId === undefined || !graph.objects[object.parentId])) place(root, 0);

  // Data, logic and workflow objects: ranked by how far downstream they are of each other.
  const otherIds = new Set(others.map((object) => object.id));
  const rank = new Map<string, number>();
  const rankOf = (id: string, seen: Set<string>): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    let value = 0;
    for (const connection of connectionsTo(graph, id)) {
      if (otherIds.has(connection.source.objectId) && connection.source.objectId !== id) {
        value = Math.max(value, rankOf(connection.source.objectId, seen) + 1);
      }
    }
    rank.set(id, value);
    return value;
  };
  const originX = (maxDepth + 1) * COLUMN + (maxDepth >= 0 ? 80 : 0);
  const columnCursor = new Map<number, number>();
  for (const object of others) {
    const column = rankOf(object.id, new Set());
    const y = columnCursor.get(column) ?? 0;
    positions[object.id] = { x: originX + column * COLUMN, y };
    columnCursor.set(column, y + estimateHeight(object, registry) + GAP);
  }
  return positions;
}

function collides(point: Point, taken: readonly Point[]): boolean {
  return taken.some((other) => Math.abs(other.x - point.x) < NODE_WIDTH + 16 && Math.abs(other.y - point.y) < 96);
}

/**
 * Returns positions for every object: stored ones are kept, objects without
 * one are placed — the whole graph when nothing is stored yet, otherwise near
 * the objects they are related to.
 */
export function layoutMissing(graph: ClaspGraph, registry: ComponentRegistry, stored: Record<string, Point>): Record<string, Point> {
  const ids = Object.keys(graph.objects);
  const known: Record<string, Point> = {};
  for (const id of ids) {
    const position = stored[id];
    if (position) known[id] = position;
  }
  const missing = ids.filter((id) => !known[id]);
  if (missing.length === 0) return known;
  if (Object.keys(known).length === 0) return fullLayout(graph, registry);

  const fallback = fullLayout(graph, registry);
  const bottom = Math.max(...Object.values(known).map((point) => point.y)) + 160;
  for (const object of sortObjects(missing.map((id) => graph.objects[id] as ClaspObject))) {
    const neighbours = [
      ...connectionsTo(graph, object.id).map((connection) => ({ id: connection.source.objectId, dx: COLUMN })),
      ...connectionsFrom(graph, object.id).map((connection) => ({ id: connection.target.objectId, dx: -COLUMN })),
      ...(object.parentId ? [{ id: object.parentId, dx: COLUMN }] : []),
    ].filter((entry) => known[entry.id]);
    let point: Point;
    if (neighbours.length > 0) {
      const x = neighbours.reduce((sum, entry) => sum + (known[entry.id] as Point).x + entry.dx, 0) / neighbours.length;
      const y = neighbours.reduce((sum, entry) => sum + (known[entry.id] as Point).y, 0) / neighbours.length;
      point = { x: Math.round(x), y: Math.round(y) };
    } else {
      point = { x: (fallback[object.id] as Point).x, y: bottom };
    }
    const taken = Object.values(known);
    for (let attempt = 0; attempt < 40 && collides(point, taken); attempt++) point = { x: point.x, y: point.y + 104 };
    known[object.id] = point;
  }
  return known;
}

export function samePositions(a: Record<string, Point>, b: Record<string, Point>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] !== undefined && a[key]?.x === b[key]?.x && a[key]?.y === b[key]?.y);
}
