import { sortObjects, type ClaspGraph } from "@clasp/core";
import { FEATURE_REFERENCE, describeFeatures } from "@clasp/features";
import type { ComponentDescription, ComponentRegistry, PropertySpec } from "@clasp/runtime";
import type { SchemaRegistry } from "@clasp/schemas";
import { buildHandles } from "./plan";

function property(spec: PropertySpec): string {
  const type = spec.type === "enum" ? `enum(${(spec.options ?? []).join("|")})` : spec.type;
  const fallback = spec.default !== undefined ? `=${JSON.stringify(spec.default)}` : "";
  return `${spec.name}:${type}${fallback}`;
}

function names(ports: Array<{ name: string; type?: string; payload?: string }>): string {
  if (ports.length === 0) return "-";
  return ports.map((port) => (port.type ? `${port.name}:${port.type}` : port.name)).join(", ");
}

function component(entry: ComponentDescription): string {
  const lines = [`${entry.type}${entry.container ? " (container: may have children)" : ""} — ${entry.description}`];
  if (entry.properties.length > 0) lines.push(`  properties: ${entry.properties.map(property).join(", ")}`);
  lines.push(`  inputs: ${names(entry.inputs)} | outputs: ${names(entry.outputs)}`);
  lines.push(`  events: ${names(entry.events)} | actions: ${names(entry.actions)}`);
  return lines.join("\n");
}

/** A compact, model-readable listing of every registered component. */
export function describeCatalog(registry: ComponentRegistry): string {
  return registry
    .catalog()
    .map((entry) => component(entry))
    .join("\n");
}

/** A compact listing of the registered record schemas and their fields. */
export function describeSchemas(schemas: SchemaRegistry): string {
  return schemas
    .list()
    .map((schema) => {
      const fields = Object.entries(schema.fields).map(([name, field]) => {
        const type = field.type === "enum" ? `enum(${(field.values ?? []).join("|")})` : field.type;
        const flags = `${field.required ? " required" : ""}${field.default !== undefined ? ` =${JSON.stringify(field.default)}` : ""}`;
        return `${name}:${type}${flags}`;
      });
      return `${schema.id} — ${fields.join(", ")}`;
    })
    .join("\n");
}

function compact(value: unknown, limit = 160): string {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Describes one application for the model: its objects (by handle) and
 * connections. Only this application is described — never other
 * applications, and never any records.
 */
export function describeGraph(graph: ClaspGraph): string {
  const handles = buildHandles(graph);
  const byId = new Map([...handles].map(([handle, id]) => [id, handle]));
  const objects = sortObjects(Object.values(graph.objects));
  if (objects.length === 0) return `Application "${graph.metadata.name}" is empty: it has no objects yet.`;
  const lines = [`Application "${graph.metadata.name}"`, "Objects (handle: type \"name\" parent=handle properties):"];
  for (const object of objects) {
    const parent = object.parentId ? ` parent=${byId.get(object.parentId) ?? "?"}` : "";
    const properties = Object.keys(object.properties).length > 0 ? ` ${compact(object.properties)}` : "";
    lines.push(`  ${byId.get(object.id)}: ${object.type} "${object.metadata.name ?? ""}"${parent}${properties}`);
  }
  const connections = Object.values(graph.connections);
  lines.push(connections.length > 0 ? "Connections:" : "Connections: none");
  for (const connection of connections) {
    lines.push(
      `  ${byId.get(connection.source.objectId)}.${connection.source.port} -> ${byId.get(connection.target.objectId)}.${connection.target.port}`,
    );
  }
  return lines.join("\n");
}

export const SYSTEM_RULES = `You are the construction assistant inside Clasp, where applications are built from deterministic components.
You never write code. You describe WHAT the application does, as features; Clasp builds the components and wiring.
Reply with exactly ONE JSON object and nothing else:
{"summary": "<one sentence>", "app": "new" or "current", "title": "<window title, for a new application>", "entities": [ ... ], "features": [ ... ]}

"app": use "new" when the request asks for a separate application ("make a calendar app", "build me a recipe tracker") — then describe that application from scratch and give it a "title". Use "current" when the request changes the application under CURRENT APPLICATION. If CURRENT APPLICATION is empty, use "current".

${FEATURE_REFERENCE}

Rules:
1. Prefer built-in entities (Task, Note, Contact, Event, Project, Document) when they fit, so other applications can share the data.
2. Use field names exactly as the entity defines them. When an entity needs a new field, list the entity with just that field in "entities".
3. When changing an existing application, describe only what to ADD or change. Features that already exist are reused, never duplicated, and data is never deleted.
4. Do only what was asked. Never add entities, lists or editors the request did not ask for.
5. When the request names a ready-made instrument — a calculator, clock, stopwatch, timer, terminal, system monitor, or the games tic-tac-toe, pairs/memory, word guess/hangman-style, or a snake-style game (glowworm) — use one "tool" feature for it. Do not imitate it with tasks, lists or a text editor.

Example — request: "A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and see only vegetarian ones."
{"summary": "A recipe box with search and a vegetarian filter.", "title": "Recipe Box",
 "entities": [{"name": "Recipe", "fields": [{"name": "title", "type": "text", "required": true}, {"name": "servings", "type": "number"}, {"name": "vegetarian", "type": "boolean"}]}],
 "features": [{"kind": "add", "entity": "Recipe"}, {"kind": "list", "entity": "Recipe"}, {"kind": "search", "entity": "Recipe", "field": "title"}, {"kind": "filter", "entity": "Recipe", "field": "vegetarian"}, {"kind": "count", "entity": "Recipe", "label": "recipes"}]}

Example — request, with an empty CURRENT APPLICATION: "a calculator"
{"summary": "A calculator.", "app": "current", "title": "Calculator", "features": [{"kind": "tool", "tool": "calculator"}]}

Example — request on an application that already has tasks: "Only show tasks that are not done."
{"summary": "Shows only incomplete tasks.", "features": [{"kind": "filter", "entity": "Task", "field": "completed", "value": false}]}

ADVANCED — only for things features cannot express, you may add "operations" (low-level edits), referring to objects by the handles listed under CURRENT APPLICATION WIRING:
{"op":"create","ref":"<new handle>","type":"<component type>","name":"<short name>","parent":"<handle of a container>","properties":{...}}
{"op":"update","target":"<handle>","properties":{...}}   {"op":"delete","target":"<handle>"}
{"op":"connect","from":"<handle>.<output or event>","to":"<handle>.<input or action>"}   {"op":"disconnect","from":"<handle>.<port>","to":"<handle>.<port>"}
Outputs connect to inputs; events connect to actions; visible (ui.*) objects need a parent inside a ui.window; never delete a data.collection.`;

export interface PromptInput {
  request: string;
  graph: ClaspGraph;
  registry: ComponentRegistry;
  schemas: SchemaRegistry;
}

/** The system message: rules plus the catalog of what exists. */
export function buildSystemPrompt(input: Pick<PromptInput, "registry" | "schemas">): string {
  return [
    SYSTEM_RULES,
    "",
    "RECORD SCHEMAS (built-in entities and their fields)",
    describeSchemas(input.schemas),
    "",
    "COMPONENT CATALOG (ADVANCED operations only)",
    describeCatalog(input.registry),
  ].join("\n");
}

/** The user message: the application being edited — by features, then by wiring — then the request. */
export function buildUserPrompt(input: Pick<PromptInput, "request" | "graph"> & { schemas?: SchemaRegistry }): string {
  return [
    "CURRENT APPLICATION",
    input.schemas ? describeFeatures(input.graph, input.schemas) : `Application "${input.graph.metadata.name}"`,
    "",
    "CURRENT APPLICATION WIRING (ADVANCED)",
    describeGraph(input.graph),
    "",
    `REQUEST: ${input.request.trim()}`,
  ].join("\n");
}
