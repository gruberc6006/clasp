import { childrenOf, type ClaspGraph, type ClaspObject } from "@clasp/core";
import type { SchemaRegistry } from "@clasp/schemas";
import { humanize, singularize } from "./entities";
import { TOOLS, TOOL_NAMES } from "./spec";

const SOURCES = new Set(["data.collection", "data.reference"]);
const VIEWS = new Set(["ui.list", "ui.table", "ui.calendar", "ui.board"]);

function name(object: ClaspObject | undefined): string {
  return object?.metadata.name ?? object?.type ?? "?";
}

function feeding(graph: ClaspGraph, objectId: string, port: string): ClaspObject | undefined {
  const connection = Object.values(graph.connections).find(
    (candidate) => candidate.kind === "value" && candidate.target.objectId === objectId && candidate.target.port === port,
  );
  return connection ? graph.objects[connection.source.objectId] : undefined;
}

/** The chain of processing steps between a list and its data, nearest the data first. */
function pipeline(graph: ClaspGraph, list: ClaspObject): { source: ClaspObject | undefined; steps: ClaspObject[] } {
  const steps: ClaspObject[] = [];
  let current = feeding(graph, list.id, list.type === "ui.table" ? "rows" : "items");
  for (let depth = 0; current && depth < 25; depth++) {
    if (SOURCES.has(current.type)) return { source: current, steps: steps.reverse() };
    steps.push(current);
    current = feeding(graph, current.id, "records");
  }
  return { source: undefined, steps: steps.reverse() };
}

function step(object: ClaspObject): string {
  const field = object.properties.field;
  switch (object.type) {
    case "data.filter": {
      const fixed = object.properties.value;
      const operator = object.properties.operator === "contains" ? "search" : "filter";
      return fixed !== undefined && fixed !== null ? `${operator} ${String(field)} = ${JSON.stringify(fixed)}` : `${operator} by ${String(field)}`;
    }
    case "data.sort":
      return `sort by ${String(field)} ${object.properties.direction === "desc" ? "desc" : "asc"}`;
    default:
      return name(object);
  }
}

/**
 * Describes an application at the level of entities and features — what a
 * person (or a model) needs to know to ask for a change, without wiring.
 */
export function describeFeatures(graph: ClaspGraph, schemas: SchemaRegistry): string {
  const lines: string[] = [];
  const windows = childrenOf(graph, undefined).filter((object) => object.type === "ui.window");
  if (Object.keys(graph.objects).length === 0) return `Application "${graph.metadata.name}" is empty.`;
  lines.push(`Application "${graph.metadata.name}"${windows.length > 0 ? `, window${windows.length > 1 ? "s" : ""} ${windows.map((window) => `“${String(window.properties.title ?? name(window))}”`).join(", ")}` : ", no window"}`);

  const sources = Object.values(graph.objects).filter((object) => SOURCES.has(object.type));
  if (sources.length > 0) lines.push("Entities:");
  for (const source of sources) {
    const schemaId = typeof source.properties.schema === "string" ? source.properties.schema : undefined;
    const schema = schemaId ? schemas.get(schemaId) : undefined;
    const entity = schema?.title ?? singularize(name(source));
    const fields = schema
      ? Object.entries(schema.fields)
          .map(([field, definition]) => {
            const type = definition.type === "enum" ? `choice: ${(definition.values ?? []).join("|")}` : definition.type === "string" ? "text" : definition.type;
            return `${field} (${type}${definition.required ? ", required" : ""})`;
          })
          .join(", ")
      : "unknown fields";
    const where = source.type === "data.reference" ? `read from another application through “${name(source)}”` : `stored in “${name(source)}”`;
    const shared = source.properties.exposure === "discoverable" ? ", shared" : "";
    lines.push(`  ${entity} — ${where}${shared}; fields: ${fields}`);
  }

  const features: string[] = [];
  for (const form of Object.values(graph.objects).filter((object) => object.type === "ui.form")) {
    const target = Object.values(graph.connections).find((connection) => connection.source.objectId === form.id && connection.source.port === "submitted");
    const inputs = Object.values(graph.objects)
      .filter((object) => typeof object.properties.field === "string")
      .filter((object) => {
        let parent = object.parentId;
        while (parent) {
          if (parent === form.id) return true;
          parent = graph.objects[parent]?.parentId;
        }
        return false;
      })
      .map((object) => object.properties.field as string);
    if (target) features.push(`add form “${name(form)}” creating records in “${name(graph.objects[target.target.objectId])}” with ${inputs.join(", ") || "no fields"}`);
  }
  for (const list of Object.values(graph.objects).filter((object) => VIEWS.has(object.type))) {
    const { source, steps } = pipeline(graph, list);
    const check = typeof list.properties.checkField === "string" ? `, checkbox ${list.properties.checkField}` : "";
    const through = steps.length > 0 ? `, through ${steps.map(step).join(" → ")}` : "";
    const kind = list.type === "ui.table" ? "table" : list.type === "ui.calendar" ? `calendar (by ${String(list.properties.dateField ?? "date")})` : list.type === "ui.board" ? `board (columns by ${String(list.properties.groupField ?? "status")})` : "list";
    features.push(`${kind} “${name(list)}” of “${name(source)}”${check}${through}`);
  }
  for (const aggregate of Object.values(graph.objects).filter((object) => object.type === "data.aggregate")) {
    const where = typeof aggregate.properties.whereField === "string" ? ` where ${aggregate.properties.whereField} = ${JSON.stringify(aggregate.properties.whereValue ?? null)}` : "";
    features.push(`count “${name(aggregate)}” of “${name(feeding(graph, aggregate.id, "records"))}”${where}`);
  }
  for (const object of Object.values(graph.objects)) {
    if (object.type === "data.document") features.push(`document “${name(object)}” (${String(object.properties.kind ?? "text")})`);
    const tool = TOOL_NAMES.find((candidate) => {
      const spec = TOOLS[candidate] as { type: string; properties: Record<string, string> };
      return spec.type === object.type && (spec.properties.mode === undefined || spec.properties.mode === (object.properties.mode ?? "clock"));
    });
    if (tool) features.push(`tool ${tool} “${name(object)}”`);
  }
  if (features.length > 0) {
    lines.push("Features present:");
    for (const feature of features) lines.push(`  ${feature}`);
  }
  const others = Object.values(graph.objects).filter((object) => !SOURCES.has(object.type) && object.type.startsWith("workflow."));
  if (others.length > 0) lines.push(`Background steps: ${others.map((object) => `${name(object)} (${humanize(object.type.split(".")[1] ?? "")})`).join(", ")}`);
  return lines.join("\n");
}
