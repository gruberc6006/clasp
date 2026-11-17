import {
  ClaspError,
  applyOperations,
  connectionsFrom,
  connectionsTo,
  createId,
  descendantsOf,
  isAssignable,
  isClaspError,
  isJsonObject,
  sortObjects,
  type ClaspGraph,
  type GraphOperation,
  type JsonObject,
  type PortRef,
} from "@clasp/core";
import { TOOL_NAMES, type EntitySpec, type FeatureSpec } from "@clasp/features";
import type { ComponentRegistry } from "@clasp/runtime";
import type { SchemaRegistry } from "@clasp/schemas";
import { z } from "zod";

/**
 * The model-facing plan format.
 *
 * Models never see or produce real object ids. They refer to existing objects
 * by short readable *handles* and name the objects they create with new
 * handles; `resolvePlan` turns that into ordinary graph operations. The model
 * only proposes — nothing here changes an application.
 */
export interface PlanOperation {
  op: "create" | "update" | "delete" | "connect" | "disconnect";
  /** create: handle for the new object. */
  ref?: string;
  /** create: component type. */
  type?: string;
  name?: string;
  /** create/update: handle of the containing object. */
  parent?: string | null;
  /** update/delete: handle of the object. */
  target?: string;
  /** connect/disconnect: "handle.port". */
  from?: string;
  to?: string;
  properties?: Record<string, unknown>;
}

/**
 * What the model replies with. Normally it describes features (and the
 * entities they work on); `operations` is an advanced escape hatch for
 * things features cannot express.
 */
export interface GraphPlan {
  summary: string;
  /** "new" when the request is for a separate application; "current" to change the one open. */
  app?: "new" | "current";
  title?: string;
  subtitle?: string;
  entities?: EntitySpec[];
  features?: FeatureSpec[];
  operations: PlanOperation[];
}

export interface PlanIssue {
  /** Index into `plan.operations`, or -1 for the plan as a whole. */
  index: number;
  message: string;
}

const planSchema = z.object({
  summary: z.string().optional(),
  app: z.enum(["new", "current"]).optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  entities: z.array(z.record(z.string(), z.unknown())).optional(),
  features: z.array(z.record(z.string(), z.unknown())).optional(),
  operations: z.array(
    z.object({
      op: z.enum(["create", "update", "delete", "connect", "disconnect"]),
      ref: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional(),
      parent: z.string().nullable().optional(),
      target: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ).optional(),
});

/** JSON Schema given to backends that support structured output. */
export const PLAN_JSON_SCHEMA: JsonObject = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    app: { type: "string", enum: ["new", "current"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    entities: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          plural: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "type"],
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["text", "longtext", "number", "boolean", "date", "choice"] },
                required: { type: "boolean" },
                options: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    // Every feature property must be listed: structured output only lets the model write listed properties.
    features: {
      type: "array",
      items: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["title", "add", "list", "search", "filter", "sort", "count", "share", "calendar", "board", "tool", "document"] },
          tool: { type: "string", enum: [...TOOL_NAMES] },
          scores: { type: "boolean" },
          entity: { type: "string" },
          name: { type: "string" },
          text: { type: "string" },
          subtitle: { type: "string" },
          title: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          field: { type: "string" },
          button: { type: "string" },
          display: { type: "string", enum: ["list", "table"] },
          toggle: { type: "string" },
          editable: { type: "boolean" },
          removable: { type: "boolean" },
          value: { type: ["string", "number", "boolean", "null"] },
          options: {
            type: "array",
            items: { type: "object", required: ["label"], properties: { label: { type: "string" }, value: { type: ["string", "number", "boolean", "null"] } } },
          },
          direction: { type: "string", enum: ["asc", "desc"] },
          label: { type: "string" },
          where: { type: "object", required: ["field"], properties: { field: { type: "string" }, value: { type: ["string", "number", "boolean", "null"] } } },
          editor: { type: "string", enum: ["text", "richtext", "code", "spreadsheet", "drawing", "sequencer"] },
          columns: { type: "array", items: { type: "string" } },
          files: { type: "boolean" },
        },
      },
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["create", "update", "delete", "connect", "disconnect"] },
          ref: { type: "string" },
          type: { type: "string" },
          name: { type: "string" },
          parent: { type: "string" },
          target: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          properties: { type: "object" },
        },
      },
    },
  },
};

/** Parses a model reply into a plan. Tolerates code fences and surrounding prose. */
export function parsePlan(text: string): GraphPlan {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  let value: unknown;
  let parsed = false;
  for (const candidate of candidates) {
    try {
      value = JSON.parse(candidate);
      parsed = true;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!parsed) throw new ClaspError("VALIDATION_FAILED", "The reply was not JSON.");
  const result = planSchema.safeParse(value);
  if (!result.success) {
    const problem = result.error.issues[0];
    throw new ClaspError(
      "VALIDATION_FAILED",
      `The reply is not a valid plan: ${problem?.path.join(".") || "plan"}: ${problem?.message ?? "invalid"}.`,
    );
  }
  const data = result.data;
  return {
    summary: data.summary ?? "",
    ...(data.app ? { app: data.app } : {}),
    ...(data.title ? { title: data.title } : {}),
    ...(data.subtitle ? { subtitle: data.subtitle } : {}),
    ...(data.entities ? { entities: data.entities as unknown as EntitySpec[] } : {}),
    ...(data.features ? { features: data.features as unknown as FeatureSpec[] } : {}),
    operations: (data.operations ?? []).map((operation) => {
      const { properties, ...rest } = operation;
      return { ...rest, ...(properties ? { properties } : {}) } as PlanOperation;
    }),
  };
}

function toHandle(text: string): string {
  const words = text
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "object";
  const handle = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  return /^[a-zA-Z]/.test(handle) ? handle : `o${handle}`;
}

/** Stable, readable handles for the objects of a graph: handle → object id. */
export function buildHandles(graph: ClaspGraph): Map<string, string> {
  const handles = new Map<string, string>();
  for (const object of sortObjects(Object.values(graph.objects))) {
    const base = toHandle(object.metadata.name ?? object.type.split(".").pop() ?? "object");
    let handle = base;
    for (let suffix = 2; handles.has(handle); suffix++) handle = `${base}${suffix}`;
    handles.set(handle, object.id);
  }
  return handles;
}

function closest(wanted: string, options: readonly string[]): string | undefined {
  const lower = wanted.toLowerCase();
  const tail = lower.split(".").pop() ?? lower;
  return (
    options.find((option) => option.toLowerCase() === lower) ??
    options.find((option) => option.toLowerCase().endsWith(`.${tail}`)) ??
    options.find((option) => option.toLowerCase().includes(tail) || tail.includes(option.toLowerCase().split(".").pop() ?? ""))
  );
}

export interface ResolveOptions {
  /** Permit deleting objects that own data (collections). Off by default. */
  allowDataLoss?: boolean;
  /** When given, form fields are checked against the schema of the collection they write to. */
  schemas?: SchemaRegistry;
}

/**
 * Mistakes that are structurally valid but make an application misbehave at
 * run time. Each finding has a stable key so problems that already existed
 * before a plan can be told apart from problems the plan introduces.
 */
export function lintGraph(graph: ClaspGraph, registry: ComponentRegistry, schemas?: SchemaRegistry): Array<{ key: string; message: string }> {
  const findings: Array<{ key: string; message: string }> = [];
  const name = (id: string): string => graph.objects[id]?.metadata.name ?? graph.objects[id]?.type ?? id;

  // 1. An event whose payload cannot be what the action expects.
  for (const connection of Object.values(graph.connections)) {
    if (connection.kind !== "event") continue;
    const source = graph.objects[connection.source.objectId];
    const target = graph.objects[connection.target.objectId];
    if (!source || !target) continue;
    const event = registry.portsOf(source)?.events.find((port) => port.name === connection.source.port);
    const action = registry.portsOf(target)?.actions.find((port) => port.name === connection.target.port);
    if (event?.payload && action?.payload && !isAssignable(event.payload, action.payload)) {
      findings.push({
        key: `payload:${connection.source.objectId}.${connection.source.port}>${connection.target.objectId}.${connection.target.port}`,
        message: `"${name(source.id)}".${connection.source.port} sends a ${event.payload}, but "${name(target.id)}".${connection.target.port} expects a ${action.payload}. Connect an event that carries a ${action.payload}, or leave this connection out.`,
      });
    }
  }

  // 2. A form whose inputs do not match the records it creates.
  if (schemas) {
    for (const form of Object.values(graph.objects)) {
      if (form.type !== "ui.form") continue;
      for (const connection of connectionsFrom(graph, form.id, "submitted")) {
        const target = graph.objects[connection.target.objectId];
        if (!target || connection.target.port !== "create") continue;
        const schemaId = target.properties.schema;
        if (typeof schemaId !== "string" || !schemas.has(schemaId)) continue;
        const schema = schemas.require(schemaId);
        const fields = Object.keys(schema.fields);
        const provided = new Set<string>();
        for (const input of descendantsOf(graph, form.id)) {
          const field = input.properties.field;
          if (typeof field !== "string" || field === "") continue;
          provided.add(field);
          if (!schema.fields[field]) {
            findings.push({
              key: `field:${input.id}:${target.id}:${field}`,
              message: `"${name(input.id)}" is inside "${name(form.id)}", which creates ${schemaId} records in "${name(target.id)}", but ${schemaId} has no field "${field}". Its fields are: ${fields.join(", ")}. Use one of those, or give this form its own collection with a schema that has the field (e.g. clasp.note for notes).`,
            });
          }
        }
        for (const [field, definition] of Object.entries(schema.fields)) {
          if (definition.required && definition.default === undefined && !provided.has(field)) {
            findings.push({
              key: `required:${form.id}:${target.id}:${field}`,
              message: `"${name(form.id)}" creates ${schemaId} records in "${name(target.id)}", which require "${field}", but no input inside the form has field "${field}".`,
            });
          }
        }
      }
    }
  }
  return findings;
}

export interface ResolvedPlan {
  /** Ordinary graph operations, ready to apply as one transaction. */
  operations: GraphOperation[];
  /** The graph as it would be after applying them. */
  preview: ClaspGraph;
  issues: PlanIssue[];
  /** Handle → object id, including objects the plan creates. */
  handles: Map<string, string>;
}

const ORDER: Record<PlanOperation["op"], number> = { create: 0, update: 1, disconnect: 2, delete: 3, connect: 4 };

/**
 * Translates a plan into graph operations and checks it against the real
 * graph and component registry by simulating it. Nothing is committed.
 *
 * To be forgiving about harmless ordering mistakes, operations are applied
 * creates first, then updates, disconnects, deletes and finally connects.
 * Connecting to an input that already has a connection replaces it.
 */
export function resolvePlan(
  plan: GraphPlan,
  graph: ClaspGraph,
  registry: ComponentRegistry,
  options: ResolveOptions = {},
): ResolvedPlan {
  const issues: PlanIssue[] = [];
  const handles = buildHandles(graph);
  const operations: GraphOperation[] = [];
  let working = graph;
  const types = registry.list().map((definition) => definition.type);

  if (plan.operations.length === 0) issues.push({ index: -1, message: "The plan contains no operations." });

  // Register every new handle first so operations may refer to each other in any order.
  const created = new Map<string, { id: string; index: number }>();
  plan.operations.forEach((operation, index) => {
    if (operation.op !== "create") return;
    if (!operation.ref) {
      issues.push({ index, message: 'A "create" operation needs a "ref" handle.' });
      return;
    }
    if (handles.has(operation.ref)) {
      issues.push({
        index,
        message: `Handle "${operation.ref}" already belongs to an existing object. Use "update" to change it, or pick a new handle to create another object.`,
      });
      return;
    }
    if (created.has(operation.ref)) {
      issues.push({ index, message: `Handle "${operation.ref}" is created twice.` });
      return;
    }
    created.set(operation.ref, { id: createId("obj"), index });
  });
  for (const [handle, entry] of created) handles.set(handle, entry.id);

  const known = (): string => [...handles.keys()].join(", ") || "none";
  /** The model only knows handles, so error messages must not talk in ids. */
  const readable = (message: string): string => {
    let text = message;
    for (const [handle, id] of handles) text = text.split(id).join(handle);
    return text;
  };
  const lookup = (handle: string | null | undefined, index: number, role: string): string | undefined => {
    if (!handle) {
      issues.push({ index, message: `Missing ${role}.` });
      return undefined;
    }
    const id = handles.get(handle);
    if (!id) issues.push({ index, message: `Unknown handle "${handle}" (${role}). Known handles: ${known()}.` });
    return id;
  };
  const endpoint = (value: string | undefined, index: number, role: string): PortRef | undefined => {
    if (!value || !value.includes(".")) {
      issues.push({ index, message: `"${role}" must look like "handle.port", received ${JSON.stringify(value ?? null)}.` });
      return undefined;
    }
    const dot = value.lastIndexOf(".");
    const objectId = lookup(value.slice(0, dot), index, role);
    return objectId ? { objectId, port: value.slice(dot + 1) } : undefined;
  };
  const apply = (operation: GraphOperation, index: number): boolean => {
    try {
      working = applyOperations(working, [operation], { catalog: registry }).graph;
      operations.push(operation);
      return true;
    } catch (error) {
      if (!isClaspError(error)) throw error;
      const messages = error.issues.filter((entry) => entry.severity === "error").map((entry) => entry.message);
      for (const message of messages.length > 0 ? messages : [error.message]) issues.push({ index, message: readable(message) });
      return false;
    }
  };

  // Parents must exist before their children — including the window that
  // parentless interface elements are placed into automatically.
  const depth = (operation: PlanOperation, seen = new Set<string>()): number => {
    if (operation.op !== "create" || operation.type === "ui.window" || !operation.ref || seen.has(operation.ref)) return 0;
    seen.add(operation.ref);
    if (!operation.parent) return registry.get(operation.type ?? "")?.category === "interface" ? 1 : 0;
    const parent = plan.operations.find((candidate) => candidate.op === "create" && candidate.ref === operation.parent);
    return parent ? 1 + depth(parent, seen) : 1;
  };
  const ordered = plan.operations
    .map((operation, index) => ({ operation, index }))
    .sort((a, b) => ORDER[a.operation.op] - ORDER[b.operation.op] || depth(a.operation) - depth(b.operation) || a.index - b.index);

  const windowHandle = (): string | undefined => {
    const windows = [
      ...Object.values(working.objects).filter((object) => object.type === "ui.window").map((object) => object.id),
      ...plan.operations.filter((operation) => operation.op === "create" && operation.type === "ui.window" && operation.ref).map((operation) => handles.get(operation.ref as string)),
    ];
    const unique = [...new Set(windows.filter((id): id is string => Boolean(id)))];
    return unique.length === 1 ? unique[0] : undefined;
  };

  for (const { operation, index } of ordered) {
    switch (operation.op) {
      case "create": {
        const entry = operation.ref ? created.get(operation.ref) : undefined;
        if (!entry || entry.index !== index) break; // already reported
        if (!operation.type) {
          issues.push({ index, message: `"create" of "${operation.ref}" needs a component "type".` });
          break;
        }
        const definition = registry.get(operation.type);
        if (!definition) {
          const suggestion = closest(operation.type, types);
          issues.push({
            index,
            message: `Unknown component type "${operation.type}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Use only types from the catalog.`,
          });
          break;
        }
        let parentId: string | undefined;
        if (operation.parent) {
          parentId = lookup(operation.parent, index, "parent");
          if (!parentId) break;
        } else if (definition.category === "interface" && operation.type !== "ui.window") {
          // Visible elements belong in the window; fill that in when it is unambiguous.
          parentId = windowHandle();
        }
        const properties: JsonObject = {};
        for (const [key, value] of Object.entries(operation.properties ?? {})) {
          if (value !== null && value !== undefined) properties[key] = value as JsonObject[string];
        }
        apply(
          {
            op: "create",
            object: {
              id: entry.id,
              type: operation.type,
              name: operation.name ?? definition.title,
              properties,
              ...(parentId ? { parentId } : {}),
            },
          },
          index,
        );
        break;
      }
      case "update": {
        const objectId = lookup(operation.target, index, "target");
        if (!objectId) break;
        let parentId: string | null | undefined;
        if (operation.parent === null) parentId = null;
        else if (operation.parent) {
          parentId = lookup(operation.parent, index, "parent");
          if (!parentId) break;
        }
        const properties = isJsonObject(operation.properties) ? operation.properties : undefined;
        apply(
          {
            op: "update",
            objectId,
            ...(properties ? { properties } : {}),
            ...(operation.name ? { name: operation.name } : {}),
            ...(parentId !== undefined ? { parentId } : {}),
          },
          index,
        );
        break;
      }
      case "delete": {
        const objectId = lookup(operation.target, index, "target");
        if (!objectId) break;
        const object = working.objects[objectId];
        if (!object) {
          issues.push({ index, message: `"${operation.target}" does not exist (anymore).` });
          break;
        }
        const ownsData = (registry.get(object.type)?.resources?.(object).length ?? 0) > 0;
        if (ownsData && !options.allowDataLoss) {
          issues.push({
            index,
            message: `"${operation.target}" stores the application's data; deleting it would orphan its records. Keep it and change what is connected to it instead.`,
          });
          break;
        }
        apply({ op: "delete", objectId }, index);
        break;
      }
      case "disconnect": {
        const source = endpoint(operation.from, index, "from");
        const target = endpoint(operation.to, index, "to");
        if (!source || !target) break;
        const existing = Object.values(working.connections).find(
          (connection) =>
            connection.source.objectId === source.objectId &&
            connection.source.port === source.port &&
            connection.target.objectId === target.objectId &&
            connection.target.port === target.port,
        );
        // Removing something that is not there is harmless; skip it quietly.
        if (existing) apply({ op: "disconnect", connectionId: existing.id }, index);
        break;
      }
      case "connect": {
        const source = endpoint(operation.from, index, "from");
        const target = endpoint(operation.to, index, "to");
        if (!source || !target) break;
        const occupied = connectionsTo(working, target.objectId, target.port).filter((connection) => connection.kind === "value");
        const duplicate = Object.values(working.connections).some(
          (connection) =>
            connection.source.objectId === source.objectId &&
            connection.source.port === source.port &&
            connection.target.objectId === target.objectId &&
            connection.target.port === target.port,
        );
        if (duplicate) break;
        const before = working;
        const checkpoint = operations.length;
        // A value input holds one connection: connecting replaces whatever was there.
        const targetInfo = working.objects[target.objectId] ? registry.describe(working.objects[target.objectId]!) : undefined;
        const isValueInput = targetInfo?.inputs.some((port) => port.name === target.port) ?? false;
        if (isValueInput) for (const connection of occupied) apply({ op: "disconnect", connectionId: connection.id }, index);
        if (!apply({ op: "connect", connection: { source, target } }, index)) {
          working = before;
          operations.length = checkpoint;
        }
        break;
      }
    }
  }

  // Report only the run-time mistakes this plan introduces, not ones the application already had.
  const existing = new Set(lintGraph(graph, registry, options.schemas).map((finding) => finding.key));
  for (const finding of lintGraph(working, registry, options.schemas)) {
    if (!existing.has(finding.key)) issues.push({ index: -1, message: readable(finding.message) });
  }

  return { operations, preview: working, issues, handles };
}
