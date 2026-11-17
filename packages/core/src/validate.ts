import { executionOrder } from "./analysis";
import { issue, type ClaspIssue } from "./errors";
import { isJsonValue } from "./json";
import {
  isAssignable,
  type ClaspConnection,
  type ClaspGraph,
  type ClaspObject,
  type ConnectionKind,
  type ObjectTypeInfo,
  type PortRef,
  type TypeCatalog,
  type ValueType,
} from "./types";

export interface ResolvedEndpoints {
  kind: ConnectionKind;
  sourceType?: ValueType;
  targetType?: ValueType;
}

function describe(catalog: TypeCatalog | undefined, object: ClaspObject): ObjectTypeInfo | undefined {
  return catalog?.describe(object);
}

/**
 * Works out what a connection between two ports means and whether it is legal.
 * Returns the connection kind, or a list of issues explaining why it cannot exist.
 */
export function resolveConnection(
  graph: ClaspGraph,
  catalog: TypeCatalog | undefined,
  source: PortRef,
  target: PortRef,
  connectionId?: string,
): { resolved?: ResolvedEndpoints; issues: ClaspIssue[] } {
  const issues: ClaspIssue[] = [];
  const sourceObject = graph.objects[source.objectId];
  const targetObject = graph.objects[target.objectId];
  if (!sourceObject) {
    issues.push(issue("MISSING_OBJECT", `Connection source object "${source.objectId}" does not exist.`, { connectionId }));
  }
  if (!targetObject) {
    issues.push(issue("MISSING_OBJECT", `Connection target object "${target.objectId}" does not exist.`, { connectionId }));
  }
  if (!sourceObject || !targetObject) return { issues };

  const sourceInfo = describe(catalog, sourceObject);
  const targetInfo = describe(catalog, targetObject);
  // Without type information (no catalog) we can only check referential integrity.
  if (!sourceInfo || !targetInfo) return { resolved: { kind: "value" }, issues };

  const output = sourceInfo.outputs.find((port) => port.name === source.port);
  const event = sourceInfo.events.find((port) => port.name === source.port);
  const input = targetInfo.inputs.find((port) => port.name === target.port);
  const action = targetInfo.actions.find((port) => port.name === target.port);
  const label = (object: ClaspObject): string => `${object.metadata.name ?? object.id} (${object.type})`;

  if (!output && !event) {
    const available = [...sourceInfo.outputs, ...sourceInfo.events].map((port) => port.name).join(", ") || "none";
    issues.push(
      issue(
        "UNKNOWN_PORT",
        `${label(sourceObject)} has no output or event named "${source.port}". Available: ${available}.`,
        { connectionId, objectId: sourceObject.id, severity: sourceInfo.unresolved ? "warning" : "error" },
      ),
    );
  }
  if (!input && !action) {
    const available = [...targetInfo.inputs, ...targetInfo.actions].map((port) => port.name).join(", ") || "none";
    issues.push(
      issue(
        "UNKNOWN_PORT",
        `${label(targetObject)} has no input or action named "${target.port}". Available: ${available}.`,
        { connectionId, objectId: targetObject.id, severity: targetInfo.unresolved ? "warning" : "error" },
      ),
    );
  }
  if ((!output && !event) || (!input && !action)) {
    return { resolved: { kind: event || action ? "event" : "value" }, issues };
  }

  if (output && input) {
    if (!isAssignable(output.type, input.type)) {
      issues.push(
        issue(
          "TYPE_MISMATCH",
          `Cannot connect ${label(sourceObject)}.${source.port} (${output.type}) to ${label(targetObject)}.${target.port} (${input.type}).`,
          { connectionId },
        ),
      );
    }
    return { resolved: { kind: "value", sourceType: output.type, targetType: input.type }, issues };
  }
  if (event && action) {
    if (event.payload && action.payload && !isAssignable(event.payload, action.payload)) {
      // A warning, not an error: the action still runs, and will report the bad payload itself.
      issues.push(
        issue(
          "PAYLOAD_MISMATCH",
          `${label(sourceObject)}.${source.port} sends ${event.payload}, but ${label(targetObject)}.${target.port} expects ${action.payload}.`,
          { connectionId, severity: "warning" },
        ),
      );
    }
    return { resolved: { kind: "event", sourceType: event.payload, targetType: action.payload }, issues };
  }
  if (output && action) {
    issues.push(
      issue(
        "KIND_MISMATCH",
        `${label(sourceObject)}.${source.port} is a value output but ${label(targetObject)}.${target.port} is an action. Actions are triggered by events; connect an event to it, or connect the value to an input.`,
        { connectionId },
      ),
    );
    return { resolved: { kind: "event" }, issues };
  }
  issues.push(
    issue(
      "KIND_MISMATCH",
      `${label(sourceObject)}.${source.port} is an event but ${label(targetObject)}.${target.port} is a value input. Events trigger actions; connect it to an action instead.`,
      { connectionId },
    ),
  );
  return { resolved: { kind: "event" }, issues };
}

function validateObject(graph: ClaspGraph, catalog: TypeCatalog | undefined, object: ClaspObject): ClaspIssue[] {
  const issues: ClaspIssue[] = [];
  const at = { objectId: object.id };
  if (!isJsonValue(object.properties)) {
    issues.push(issue("INVALID_PROPERTIES", `Properties of "${object.id}" are not plain JSON.`, at));
  }
  if (object.parentId !== undefined) {
    const parent = graph.objects[object.parentId];
    if (!parent) {
      issues.push(issue("MISSING_PARENT", `Parent "${object.parentId}" of "${object.id}" does not exist.`, at));
    } else {
      const parentInfo = describe(catalog, parent);
      if (parentInfo && !parentInfo.container) {
        issues.push(
          issue(
            "NOT_A_CONTAINER",
            `"${parent.metadata.name ?? parent.id}" (${parent.type}) cannot contain other objects.`,
            at,
          ),
        );
      }
      // Walk up to detect containment cycles.
      const seen = new Set<string>([object.id]);
      let current: string | undefined = object.parentId;
      while (current) {
        if (seen.has(current)) {
          issues.push(issue("CONTAINMENT_CYCLE", `"${object.id}" is nested inside itself.`, at));
          break;
        }
        seen.add(current);
        current = graph.objects[current]?.parentId;
      }
    }
  }
  if (catalog) {
    const info = describe(catalog, object);
    if (!info) {
      issues.push(issue("UNKNOWN_TYPE", `No component is registered for type "${object.type}".`, at));
    } else {
      if (object.typeVersion > info.version) {
        issues.push(
          issue(
            "TYPE_VERSION_AHEAD",
            `"${object.id}" was authored for ${object.type} v${object.typeVersion}, but only v${info.version} is registered.`,
            at,
          ),
        );
      }
      for (const found of info.validateProperties?.(object.properties) ?? []) {
        issues.push({ ...found, objectId: found.objectId ?? object.id });
      }
    }
  }
  return issues;
}

function validateInterface(graph: ClaspGraph, catalog: TypeCatalog | undefined): ClaspIssue[] {
  const issues: ClaspIssue[] = [];
  const names = new Set<string>();
  const claim = (group: string, name: string): void => {
    if (!name.trim()) issues.push(issue("INVALID_INTERFACE", `An exposed ${group} has an empty name.`));
    const key = `${group}:${name}`;
    if (names.has(key)) issues.push(issue("INVALID_INTERFACE", `Exposed ${group} "${name}" is declared twice.`));
    names.add(key);
  };
  const check = (
    group: string,
    name: string,
    ref: PortRef,
    pick: (info: ObjectTypeInfo) => Array<{ name: string }>,
  ): void => {
    claim(group, name);
    const object = graph.objects[ref.objectId];
    if (!object) {
      issues.push(issue("INVALID_INTERFACE", `Exposed ${group} "${name}" points at missing object "${ref.objectId}".`));
      return;
    }
    const info = describe(catalog, object);
    if (info && !pick(info).some((port) => port.name === ref.port)) {
      issues.push(
        issue("INVALID_INTERFACE", `Exposed ${group} "${name}" points at unknown port "${ref.port}" on ${object.type}.`, {
          objectId: object.id,
          severity: info.unresolved ? "warning" : "error",
        }),
      );
    }
  };
  for (const entry of graph.interface.actions) check("action", entry.name, entry.target, (info) => info.actions);
  for (const entry of graph.interface.events) check("event", entry.name, entry.source, (info) => info.events);
  for (const entry of graph.interface.outputs) check("output", entry.name, entry.source, (info) => info.outputs);
  for (const entry of graph.interface.inputs) check("input", entry.name, entry.target, (info) => info.inputs);
  for (const entry of graph.interface.views) {
    claim("view", entry.name);
    if (!graph.objects[entry.root]) {
      issues.push(issue("INVALID_INTERFACE", `Exposed view "${entry.name}" points at missing object "${entry.root}".`));
    }
  }
  return issues;
}

/**
 * Validates a whole graph: referential integrity, containment, port and type
 * compatibility, single-writer inputs, dependency cycles and the public interface.
 * Pass a catalog to also validate types, ports and properties.
 */
export function validateGraph(graph: ClaspGraph, catalog?: TypeCatalog): ClaspIssue[] {
  const issues: ClaspIssue[] = [];
  for (const [key, object] of Object.entries(graph.objects)) {
    if (key !== object.id) issues.push(issue("ID_MISMATCH", `Object stored under "${key}" has id "${object.id}".`));
    issues.push(...validateObject(graph, catalog, object));
  }

  const inputWriters = new Map<string, ClaspConnection>();
  const seenPairs = new Set<string>();
  for (const [key, connection] of Object.entries(graph.connections)) {
    if (key !== connection.id) {
      issues.push(issue("ID_MISMATCH", `Connection stored under "${key}" has id "${connection.id}".`));
    }
    if (graph.objects[connection.id]) {
      issues.push(issue("DUPLICATE_ID", `Id "${connection.id}" is used by both an object and a connection.`));
    }
    const { resolved, issues: found } = resolveConnection(
      graph,
      catalog,
      connection.source,
      connection.target,
      connection.id,
    );
    issues.push(...found);
    if (resolved && catalog && resolved.kind !== connection.kind && !found.some((entry) => entry.severity === "error")) {
      issues.push(
        issue("KIND_MISMATCH", `Connection "${connection.id}" is stored as ${connection.kind} but resolves to ${resolved.kind}.`, {
          connectionId: connection.id,
        }),
      );
    }
    const pair = `${connection.source.objectId}.${connection.source.port}>${connection.target.objectId}.${connection.target.port}`;
    if (seenPairs.has(pair)) {
      issues.push(issue("DUPLICATE_CONNECTION", `The same two ports are connected more than once.`, { connectionId: connection.id }));
    }
    seenPairs.add(pair);
    if (connection.kind === "value") {
      const slot = `${connection.target.objectId}.${connection.target.port}`;
      if (inputWriters.has(slot)) {
        const target = graph.objects[connection.target.objectId];
        issues.push(
          issue(
            "INPUT_ALREADY_CONNECTED",
            `Input "${connection.target.port}" of "${target?.metadata.name ?? connection.target.objectId}" already has a connection. Disconnect it first.`,
            { connectionId: connection.id, objectId: connection.target.objectId },
          ),
        );
      }
      inputWriters.set(slot, connection);
    }
  }

  const { cyclic } = executionOrder(graph);
  if (cyclic.length > 0) {
    const names = cyclic.map((id) => graph.objects[id]?.metadata.name ?? id).join(", ");
    issues.push(
      issue("DEPENDENCY_CYCLE", `These objects depend on each other's values in a cycle and cannot be ordered: ${names}.`),
    );
  }

  issues.push(...validateInterface(graph, catalog));
  return issues;
}
