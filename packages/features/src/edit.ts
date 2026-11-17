import { applyOperations, childrenOf, createId, descendantsOf, type ClaspGraph, type ClaspConnection, type ClaspObject, type GraphOperation, type JsonValue } from "@clasp/core";
import type { FieldDefinition, SchemaRegistry } from "@clasp/schemas";
import { compileFeatures, type CompileContext, type CompiledFeatures, type FeatureExtension } from "./compile";
import { BUILTIN_ENTITIES, SchemaView, capitalize, humanize, pluralize, resolveEntity } from "./entities";
import { TOOLS, TOOL_NAMES, type DocumentEditor, type FeatureKind, type FeatureSpec, type ToolName } from "./spec";

/**
 * Reading an application back as features, and changing it feature by
 * feature. Each recognized feature knows the objects that make it up, so it
 * can be removed or changed without touching anything else. Records are never
 * deleted: the place records are kept cannot be removed here.
 */

export interface PresentEntity {
  /** Entity name as features use it, e.g. "Recipe". */
  name: string;
  plural: string;
  schemaId: string;
  fields: Record<string, FieldDefinition>;
  sourceId: string;
  /** False when the records come from another application, or their kind cannot be named back. */
  editable: boolean;
  shared: boolean;
}

export interface PresentFeature {
  /** Stable for a given graph: the kind and the main object's id. */
  key: string;
  kind: FeatureKind;
  /** What it does, in plain words. */
  label: string;
  entity?: string;
  /** Its parameters, as a feature spec: where a change starts from. */
  spec: FeatureSpec;
  /** The objects that make it up (children go with their parents). */
  objects: string[];
  /** Why it cannot be removed, when it cannot. */
  locked?: string;
  /** Whether its parameters can be changed here. */
  editable: boolean;
}

export interface FeatureInventory {
  entities: PresentEntity[];
  features: PresentFeature[];
  /** Objects no feature accounts for — built by hand in Build mode. */
  other: string[];
}

const SOURCES = new Set(["data.collection", "data.reference"]);
const STAGES = new Set(["data.filter", "data.sort"]);
const EDITORS: Record<string, DocumentEditor> = {
  "ui.textInput": "text",
  "ui.richText": "richtext",
  "ui.codeEditor": "code",
  "ui.spreadsheet": "spreadsheet",
  "ui.canvas": "drawing",
  "ui.sequencer": "sequencer",
};

// ── graph helpers ────────────────────────────────────────────────────────

function feed(graph: ClaspGraph, objectId: string, port: string): ClaspConnection | undefined {
  return Object.values(graph.connections).find(
    (connection) => connection.kind === "value" && connection.target.objectId === objectId && connection.target.port === port,
  );
}

function outgoing(graph: ClaspGraph, objectId: string, port: string): ClaspConnection[] {
  return Object.values(graph.connections).filter((connection) => connection.source.objectId === objectId && connection.source.port === port);
}

/** The data source a records input ultimately reads, through filters and sorts. */
function sourceOf(graph: ClaspGraph, objectId: string, port: string): ClaspObject | undefined {
  let connection = feed(graph, objectId, port);
  for (let depth = 0; connection && depth < 30; depth++) {
    const upstream = graph.objects[connection.source.objectId];
    if (!upstream) return undefined;
    if (SOURCES.has(upstream.type)) return upstream;
    if (!STAGES.has(upstream.type)) return undefined;
    connection = feed(graph, upstream.id, "records");
  }
  return undefined;
}

function viewPort(object: ClaspObject): string {
  return object.type === "ui.table" ? "rows" : "items";
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The entity name features use for records of `schemaId` ("Task" for clasp.task, a schema's title otherwise). */
export function entityNameFor(schemaId: string, schemas: SchemaRegistry): string {
  const builtin = Object.entries(BUILTIN_ENTITIES).find(([, id]) => id === schemaId);
  if (builtin) return capitalize(builtin[0]);
  const schema = schemas.get(schemaId);
  return schema?.title ?? capitalize(humanize(schemaId.split(".").pop() ?? schemaId));
}

// ── recognition ──────────────────────────────────────────────────────────

/** Reads an application as features. */
export function inventory(graph: ClaspGraph, schemas: SchemaRegistry): FeatureInventory {
  const view = new SchemaView(schemas);
  const claimed = new Set<string>();
  const features: PresentFeature[] = [];
  const claim = (ids: string[]): void => {
    for (const id of ids) {
      claimed.add(id);
      for (const child of descendantsOf(graph, id)) claimed.add(child.id);
    }
  };

  // Where records are kept.
  const entities: PresentEntity[] = [];
  for (const source of Object.values(graph.objects).filter((object) => SOURCES.has(object.type))) {
    const schemaId = text(source.properties.schema);
    if (!schemaId) continue;
    const name = entityNameFor(schemaId, schemas);
    const resolved = resolveEntity(name, undefined, view);
    const roundTrips = !("message" in resolved) && (resolved.schemaId === schemaId || view.get(resolved.schemaId)?.lineage.includes(schemaId) === true);
    const fields = schemas.get(schemaId)?.fields ?? {};
    entities.push({
      name,
      plural: text(source.metadata.name) ?? pluralize(name),
      schemaId,
      fields,
      sourceId: source.id,
      editable: source.type === "data.collection" && roundTrips,
      shared: source.properties.exposure === "discoverable",
    });
  }
  const entityOf = (source: ClaspObject | undefined): PresentEntity | undefined => (source ? entities.find((entity) => entity.sourceId === source.id) : undefined);
  const lower = (entity: PresentEntity): string => entity.plural.toLowerCase();

  // Ready-made tools (games bring their score list along).
  for (const object of Object.values(graph.objects)) {
    const tool = TOOL_NAMES.find((candidate) => {
      const spec = TOOLS[candidate] as { type: string; properties: Record<string, string> };
      return spec.type === object.type && (spec.properties.mode === undefined || spec.properties.mode === (object.properties.mode ?? "clock"));
    });
    if (!tool) continue;
    const objects = [object.id];
    const scores = outgoing(graph, object.id, "finished").map((connection) => graph.objects[connection.target.objectId]).find((target) => target?.type === "data.collection");
    if (scores) {
      for (const sort of outgoing(graph, scores.id, "records").map((connection) => graph.objects[connection.target.objectId])) {
        if (sort?.type !== "data.sort") continue;
        objects.push(sort.id);
        for (const list of outgoing(graph, sort.id, "records").map((connection) => graph.objects[connection.target.objectId])) if (list?.type === "ui.list") objects.push(list.id);
      }
      const heading = Object.values(graph.objects).find((candidate) => candidate.type === "ui.text" && candidate.metadata.name === "Scores heading");
      if (heading) objects.push(heading.id);
      claim([scores.id]); // the scores stay: they are records
    }
    claim(objects);
    features.push({
      key: `tool:${object.id}`,
      kind: "tool",
      label: `${(TOOLS[tool] as { noun: string }).noun}${scores ? ", with a high-score list" : ""}`,
      spec: { kind: "tool", tool },
      objects,
      editable: true,
    });
  }

  // Documents: the document, its toolbar and its editor.
  for (const document of Object.values(graph.objects).filter((object) => object.type === "data.document")) {
    const objects = [document.id];
    const editor = feed(graph, document.id, "content");
    const editorObject = editor ? graph.objects[editor.source.objectId] : undefined;
    if (editorObject) objects.push(editorObject.id);
    const toolbars = new Set<string>();
    for (const connection of Object.values(graph.connections)) {
      if (connection.target.objectId !== document.id || connection.kind !== "event") continue;
      const button = graph.objects[connection.source.objectId];
      if (button?.type === "ui.button" && button.parentId && graph.objects[button.parentId]?.type === "ui.container") toolbars.add(button.parentId);
    }
    objects.push(...toolbars);
    claim(objects);
    const editorKind = editorObject ? (EDITORS[editorObject.type] ?? "text") : "text";
    features.push({
      key: `document:${document.id}`,
      kind: "document",
      label: `A ${editorKind === "richtext" ? "word processor" : editorKind === "code" ? "code editor" : editorKind === "drawing" ? "drawing canvas" : editorKind === "sequencer" ? "step sequencer" : editorKind === "spreadsheet" ? "spreadsheet" : "text editor"} that opens and saves files`,
      spec: { kind: "document", editor: editorKind, files: true },
      objects,
      editable: false,
    });
  }

  // Forms that add records.
  for (const form of Object.values(graph.objects).filter((object) => object.type === "ui.form" && !claimed.has(object.id))) {
    const target = outgoing(graph, form.id, "submitted").map((connection) => graph.objects[connection.target.objectId]).find((object) => object && SOURCES.has(object.type));
    const entity = entityOf(target);
    if (!entity) continue;
    const inputs = descendantsOf(graph, form.id).filter((object) => typeof object.properties.field === "string");
    const fields = inputs.sort((a, b) => a.order - b.order).map((object) => object.properties.field as string);
    const button = descendantsOf(graph, form.id).find((object) => object.type === "ui.button");
    claim([form.id]);
    features.push({
      key: `add:${form.id}`,
      kind: "add",
      label: `A form to add ${lower(entity)} (${fields.map((field) => humanize(field).toLowerCase()).join(", ")})`,
      entity: entity.name,
      spec: { kind: "add", entity: entity.name, fields, ...(text(button?.properties.label) ? { button: text(button?.properties.label) as string } : {}) },
      objects: [form.id],
      editable: entity.editable,
    });
  }

  // Lists, tables, calendars and boards.
  for (const object of Object.values(graph.objects).filter((candidate) => ["ui.list", "ui.table", "ui.calendar", "ui.board"].includes(candidate.type) && !claimed.has(candidate.id))) {
    const entity = entityOf(sourceOf(graph, object.id, viewPort(object)));
    if (!entity) continue;
    claim([object.id]);
    const base = { objects: [object.id], entity: entity.name, editable: entity.editable };
    if (object.type === "ui.calendar") {
      const field = text(object.properties.dateField) ?? "start";
      features.push({ ...base, key: `calendar:${object.id}`, kind: "calendar", label: `A month calendar of ${lower(entity)} by ${humanize(field).toLowerCase()}`, spec: { kind: "calendar", entity: entity.name, field } });
    } else if (object.type === "ui.board") {
      const field = text(object.properties.groupField) ?? "status";
      const columns = Array.isArray(object.properties.columns) ? object.properties.columns.filter((column): column is string => typeof column === "string") : [];
      features.push({
        ...base,
        key: `board:${object.id}`,
        kind: "board",
        label: `A board of ${lower(entity)} in columns by ${humanize(field).toLowerCase()}${columns.length ? ` (${columns.join(", ")})` : ""}`,
        spec: { kind: "board", entity: entity.name, field, ...(columns.length ? { columns } : {}) },
      });
    } else if (object.type === "ui.table") {
      const columns = Array.isArray(object.properties.columns) ? object.properties.columns : [];
      const fields = columns.map((column) => (column && typeof column === "object" && !Array.isArray(column) ? text((column as { field?: JsonValue }).field) : undefined)).filter((field): field is string => field !== undefined);
      const editable = columns.some((column) => column && typeof column === "object" && !Array.isArray(column) && (column as { editable?: JsonValue }).editable === true);
      const removable = object.properties.removable === true;
      features.push({
        ...base,
        key: `list:${object.id}`,
        kind: "list",
        label: `A table of ${lower(entity)}${fields.length ? ` (${fields.map((field) => humanize(field).toLowerCase()).join(", ")})` : ""}${editable ? " you can edit" : ""}`,
        spec: { kind: "list", entity: entity.name, display: "table", ...(fields.length ? { fields } : {}), editable, removable },
      });
    } else {
      const title = text(object.properties.titleField);
      const subtitle = text(object.properties.subtitleField);
      const toggle = text(object.properties.checkField);
      const editable = object.properties.editable === true;
      const removable = object.properties.removable === true;
      const abilities = [toggle ? `tick off as ${humanize(toggle).toLowerCase()}` : undefined, editable ? "edit" : undefined, removable ? "remove" : undefined].filter(Boolean);
      features.push({
        ...base,
        key: `list:${object.id}`,
        kind: "list",
        label: `A list of ${lower(entity)}${abilities.length ? ` you can ${abilities.join(", ")}` : ""}`,
        spec: {
          kind: "list",
          entity: entity.name,
          display: "list",
          ...(title ? { fields: [title, ...(subtitle ? [subtitle] : [])] } : {}),
          ...(toggle ? { toggle } : {}),
          editable,
          removable,
        },
      });
    }
  }

  // Search, filters and sorts between the records and the lists.
  for (const stage of Object.values(graph.objects).filter((object) => STAGES.has(object.type) && !claimed.has(object.id))) {
    const entity = entityOf(sourceOf(graph, stage.id, "records"));
    if (!entity) continue;
    const field = text(stage.properties.field);
    if (!field) continue;
    const base = { entity: entity.name, editable: entity.editable };
    if (stage.type === "data.sort") {
      const direction = stage.properties.direction === "desc" ? "desc" : "asc";
      claim([stage.id]);
      features.push({
        ...base,
        key: `sort:${stage.id}`,
        kind: "sort",
        label: `Sorts ${lower(entity)} by ${humanize(field).toLowerCase()}${direction === "desc" ? ", largest or latest first" : ""}`,
        spec: { kind: "sort", entity: entity.name, field, direction },
        objects: [stage.id],
      });
      continue;
    }
    const control = feed(graph, stage.id, "value");
    const controlObject = control ? graph.objects[control.source.objectId] : undefined;
    if (controlObject?.type === "ui.textInput" && stage.properties.operator === "contains") {
      claim([stage.id, controlObject.id]);
      features.push({
        ...base,
        key: `search:${stage.id}`,
        kind: "search",
        label: `Search ${lower(entity)} by ${humanize(field).toLowerCase()}`,
        spec: { kind: "search", entity: entity.name, field },
        objects: [stage.id, controlObject.id],
      });
    } else if (controlObject?.type === "ui.tabs") {
      claim([stage.id, controlObject.id]);
      features.push({
        ...base,
        key: `filter:${stage.id}`,
        kind: "filter",
        label: `Tabs that filter ${lower(entity)} by ${humanize(field).toLowerCase()}`,
        spec: { kind: "filter", entity: entity.name, field },
        objects: [stage.id, controlObject.id],
      });
    } else if (!control && stage.properties.value !== undefined && stage.properties.value !== null && stage.properties.operator === "eq") {
      claim([stage.id]);
      features.push({
        ...base,
        key: `filter:${stage.id}`,
        kind: "filter",
        label: `Shows only ${lower(entity)} whose ${humanize(field).toLowerCase()} is ${JSON.stringify(stage.properties.value)}`,
        spec: { kind: "filter", entity: entity.name, field, value: stage.properties.value },
        objects: [stage.id],
      });
    }
  }

  // Counts.
  for (const aggregate of Object.values(graph.objects).filter((object) => object.type === "data.aggregate" && object.properties.operation === "count" && !claimed.has(object.id))) {
    const entity = entityOf(sourceOf(graph, aggregate.id, "records"));
    if (!entity) continue;
    const label = outgoing(graph, aggregate.id, "value").map((connection) => graph.objects[connection.target.objectId]).find((object) => object?.type === "ui.text");
    const objects = [aggregate.id, ...(label ? [label.id] : [])];
    const words = text(label?.properties.text)?.replace(/^\{value\}\s*/, "").trim() || lower(entity);
    const whereField = text(aggregate.properties.whereField);
    claim(objects);
    features.push({
      key: `count:${aggregate.id}`,
      kind: "count",
      label: whereField
        ? `Counts ${lower(entity)} whose ${humanize(whereField).toLowerCase()} is ${JSON.stringify(aggregate.properties.whereValue ?? null)}, shown as “N ${words}”`
        : `Counts ${lower(entity)}, shown as “N ${words}”`,
      entity: entity.name,
      spec: { kind: "count", entity: entity.name, label: words, ...(whereField ? { where: { field: whereField, value: aggregate.properties.whereValue ?? null } } : {}) },
      objects,
      editable: entity.editable,
    });
  }

  // Sharing, and the records themselves.
  for (const entity of entities) {
    claim([entity.sourceId]);
    if (entity.shared && graph.objects[entity.sourceId]?.type === "data.collection") {
      features.push({
        key: `share:${entity.sourceId}`,
        kind: "share",
        label: `Other applications can find ${lower(entity)} (and must ask you to read them)`,
        entity: entity.name,
        spec: { kind: "share", entity: entity.name },
        objects: [],
        editable: false,
      });
    }
  }

  // The window title.
  const window = childrenOf(graph, undefined).find((object) => object.type === "ui.window");
  if (window) {
    claimed.add(window.id);
    const fromFile = feed(graph, window.id, "title") !== undefined;
    const title = text(window.properties.title) ?? graph.metadata.name;
    features.unshift({
      key: `title:${window.id}`,
      kind: "title",
      label: fromFile ? "The window is titled with the open file's name" : `The window is titled “${title}”`,
      spec: { kind: "title", text: title, ...(text(window.properties.subtitle) ? { subtitle: text(window.properties.subtitle) as string } : {}) },
      objects: [window.id],
      locked: "Every window has a title. Change it instead.",
      editable: !fromFile,
    });
  }

  const other = Object.values(graph.objects)
    .filter((object) => !claimed.has(object.id))
    // Plain layout containers that only hold features are not "built by hand".
    .filter((object) => !(object.type === "ui.container" && descendantsOf(graph, object.id).every((child) => claimed.has(child.id))))
    .map((object) => object.id);
  return { entities, features, other };
}

// ── removing and changing ────────────────────────────────────────────────

export interface Removal {
  operations: GraphOperation[];
  /** Other features removed with it, in plain words (e.g. the search of a list that is going away). */
  alsoRemoves: string[];
}

/**
 * Removes a feature: its objects go, and anything that flowed through it is
 * reconnected (a removed search no longer sits between the records and the
 * list). Records and the place they are kept are never removed.
 */
export function removeFeature(graph: ClaspGraph, feature: PresentFeature, options: { cascade?: boolean } = {}): Removal {
  if (feature.locked) return { operations: [], alsoRemoves: [] };
  if (feature.kind === "share") {
    const sourceId = feature.key.slice("share:".length);
    return { operations: [{ op: "update", objectId: sourceId, properties: { exposure: "private" } }], alsoRemoves: [] };
  }
  const operations: GraphOperation[] = [];
  const alsoRemoves: string[] = [];
  const removing = new Set(feature.objects);

  if (feature.kind === "search" || feature.kind === "filter" || feature.kind === "sort") {
    // Splice the step out of the chain.
    const stage = graph.objects[feature.objects[0] as string];
    const upstream = stage ? feed(graph, stage.id, "records") : undefined;
    for (const id of feature.objects) operations.push({ op: "delete", objectId: id });
    if (stage && upstream) {
      for (const connection of outgoing(graph, stage.id, "records")) {
        if (removing.has(connection.target.objectId)) continue;
        operations.push({ op: "connect", connection: { id: createId("con"), source: { ...upstream.source }, target: { ...connection.target } } });
      }
    }
    return { operations, alsoRemoves };
  }

  if (["list", "calendar", "board"].includes(feature.kind)) {
    const viewObject = graph.objects[feature.objects[0] as string];
    const source = viewObject ? sourceOf(graph, viewObject.id, viewPort(viewObject)) : undefined;
    const viewFeed = viewObject ? feed(graph, viewObject.id, viewPort(viewObject)) : undefined;
    if (viewObject && source && viewFeed) {
      const otherViews = Object.values(graph.objects).filter(
        (object) => object.id !== viewObject.id && ["ui.list", "ui.table", "ui.calendar", "ui.board"].includes(object.type) && sourceOf(graph, object.id, viewPort(object))?.id === source.id,
      );
      const throughSteps = viewFeed.source.objectId !== source.id;
      if (throughSteps && otherViews.length > 0) {
        // Hand the search, filters and sorts over to the next view.
        const next = otherViews[0] as ClaspObject;
        const nextFeed = feed(graph, next.id, viewPort(next));
        if (nextFeed && nextFeed.source.objectId === source.id) {
          operations.push({ op: "disconnect", connectionId: nextFeed.id });
          operations.push({ op: "delete", objectId: viewObject.id });
          operations.push({ op: "connect", connection: { id: createId("con"), source: { ...viewFeed.source }, target: { objectId: next.id, port: viewPort(next) } } });
          return { operations, alsoRemoves };
        }
      } else if (throughSteps && otherViews.length === 0 && options.cascade !== false) {
        // The last view: its search, filters and sorts have nothing left to work on.
        for (const step of chainFrom(graph, source.id)) {
          const control = feed(graph, step.id, "value");
          const controlObject = control ? graph.objects[control.source.objectId] : undefined;
          operations.push({ op: "delete", objectId: step.id });
          if (controlObject && (controlObject.type === "ui.textInput" || controlObject.type === "ui.tabs")) operations.push({ op: "delete", objectId: controlObject.id });
          alsoRemoves.push(step.type === "data.sort" ? `sorting by ${humanize(String(step.properties.field ?? ""))}` : controlObject?.type === "ui.textInput" ? "its search" : `its ${humanize(String(step.properties.field ?? ""))} filter`);
        }
      }
    }
  }
  for (const id of feature.objects) if (graph.objects[id]) operations.push({ op: "delete", objectId: id });
  // Deleting a parent deletes its children; don't delete them twice.
  const deleted = new Set<string>();
  const unique = operations.filter((operation) => {
    if (operation.op !== "delete") return true;
    const covered = [...deleted].some((id) => descendantsOf(graph, id).some((child) => child.id === operation.objectId));
    if (deleted.has(operation.objectId) || covered) return false;
    deleted.add(operation.objectId);
    return true;
  });
  return { operations: unique, alsoRemoves };
}

/** The filters and sorts chained directly after a source, in order. */
function chainFrom(graph: ClaspGraph, sourceId: string): ClaspObject[] {
  const chain: ClaspObject[] = [];
  let current = { objectId: sourceId, port: "records" };
  for (let depth = 0; depth < 30; depth++) {
    const next = outgoing(graph, current.objectId, current.port)
      .map((connection) => graph.objects[connection.target.objectId])
      .find((object) => object && STAGES.has(object.type) && feed(graph, object.id, "records")?.source.objectId === current.objectId);
    if (!next) break;
    chain.push(next);
    current = { objectId: next.id, port: "records" };
  }
  return chain;
}

/**
 * Changes a feature's parameters: it is removed (without taking anything else
 * along) and compiled again from `next`, as one change. A title is simply
 * updated.
 */
export function changeFeature(feature: PresentFeature, next: FeatureSpec, context: CompileContext, extensions: readonly FeatureExtension[] = []): CompiledFeatures {
  if (!feature.editable) return { operations: [], schemas: [], described: [], issues: ["This feature cannot be changed here."] };
  if (next.kind !== feature.kind) return { operations: [], schemas: [], described: [], issues: ["A feature keeps its kind when it is changed. Remove it and add another instead."] };
  const removal = next.kind === "title" ? { operations: [], alsoRemoves: [] } : removeFeature(context.graph, feature, { cascade: false });
  let intermediate = context.graph;
  try {
    intermediate = applyOperations(context.graph, removal.operations, { catalog: context.registry }).graph;
  } catch (error) {
    return { operations: [], schemas: [], described: [], issues: [error instanceof Error ? error.message : String(error)] };
  }
  const compiled = compileFeatures({ features: [next] }, { ...context, graph: intermediate }, extensions);
  if (compiled.issues.length > 0) return compiled;
  return { ...compiled, operations: [...removal.operations, ...compiled.operations] };
}

/** Kinds of feature a person can add, with what each needs. */
export const ADDABLE_FEATURES: ReadonlyArray<{ kind: FeatureKind | "records"; label: string; hint: string }> = [
  { kind: "records", label: "A kind of record", hint: "Keep things like books, recipes or expenses — with a form to add them and a list" },
  { kind: "add", label: "Form", hint: "Add records by filling in a form" },
  { kind: "list", label: "List or table", hint: "Show records; tick, edit or remove them" },
  { kind: "search", label: "Search", hint: "Find records by typing" },
  { kind: "filter", label: "Filter", hint: "Tabs by a yes/no or choice field, or only matching records" },
  { kind: "sort", label: "Sort", hint: "Put records in order" },
  { kind: "count", label: "Count", hint: "Show how many there are" },
  { kind: "calendar", label: "Calendar", hint: "Show records on a month calendar by a date" },
  { kind: "board", label: "Board", hint: "Cards in columns by a choice field" },
  { kind: "share", label: "Share", hint: "Let other applications find these records (they still must ask you)" },
  { kind: "tool", label: "Ready-made tool or game", hint: "Calculator, clock, terminal, games…" },
  { kind: "document", label: "Document editor", hint: "Write, calculate, draw or make music, with files" },
];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as string[]).includes(value);
}
