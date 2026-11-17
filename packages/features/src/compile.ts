import { childrenOf, createId, type ClaspGraph, type ClaspObject, type GraphOperation, type JsonObject, type JsonValue, type PortRef } from "@clasp/core";
import type { ComponentRegistry } from "@clasp/runtime";
import type { FieldDefinition, SchemaDefinition, SchemaRegistry } from "@clasp/schemas";
import { SchemaView, humanize, resolveEntity, sameEntity, toFieldName, type ResolvedEntity } from "./entities";
import { DOCUMENT_EDITORS, TOOLS, TOOL_NAMES, type EntitySpec, type FeaturePlan, type FeatureSpec } from "./spec";

export interface CompileContext {
  graph: ClaspGraph;
  registry: ComponentRegistry;
  schemas: SchemaRegistry;
}

/** Hook for feature kinds implemented outside this package (documents, files, …). */
export interface FeatureExtension {
  kind: string;
  compile(feature: FeatureSpec, builder: FeatureBuilder): void;
}

export interface CompiledFeatures {
  /** Ordinary graph operations; apply them as one transaction. */
  operations: GraphOperation[];
  /** Schemas to register before applying the operations. */
  schemas: SchemaDefinition[];
  /** What the change does, one line per feature, in plain language. */
  described: string[];
  /** Why parts of the plan could not be compiled. Empty means success. */
  issues: string[];
}

const SOURCES = new Set(["data.collection", "data.reference"]);
const VIEWS = new Set(["ui.list", "ui.table", "ui.calendar", "ui.board"]);

type Slot = "top" | "controls" | "content" | "footer";

interface ListState {
  id: string;
  port: "items" | "rows";
  /** The connection currently feeding the list, if any. */
  feed: { connectionId: string; from: PortRef } | undefined;
  isNew: boolean;
  type: string;
}

interface EntityState {
  entity: ResolvedEntity;
  sourceId: string;
  /** Inputs of the entity's add form, by field, made or found while compiling. */
  formInputs: Map<string, string>;
  /** Calendars that should prefill the form's date input when a day is picked. */
  calendars: Array<{ id: string; field: string }>;
  lists: ListState[];
  /** Where records currently come out of the processing chain. */
  tail: PortRef;
  stagesAdded: boolean;
}

/** Walks a value input upstream through records-processing objects until it reaches a data source. */
function traceSource(graph: ClaspGraph, objectId: string, port: string, depth = 0): string | undefined {
  if (depth > 25) return undefined;
  const feed = Object.values(graph.connections).find(
    (connection) => connection.kind === "value" && connection.target.objectId === objectId && connection.target.port === port,
  );
  if (!feed) return undefined;
  const upstream = graph.objects[feed.source.objectId];
  if (!upstream) return undefined;
  if (SOURCES.has(upstream.type)) return upstream.id;
  return traceSource(graph, upstream.id, "records", depth + 1);
}

/** Where records come out of the filters and sorts chained after a source (the source itself when there are none). */
function chainEnd(graph: ClaspGraph, sourceId: string): PortRef {
  let current: PortRef = { objectId: sourceId, port: "records" };
  for (let depth = 0; depth < 30; depth++) {
    const next = Object.values(graph.connections).find(
      (connection) =>
        connection.kind === "value" &&
        connection.source.objectId === current.objectId &&
        connection.source.port === current.port &&
        connection.target.port === "records" &&
        ["data.filter", "data.sort"].includes(graph.objects[connection.target.objectId]?.type ?? ""),
    );
    if (!next) return current;
    current = { objectId: next.target.objectId, port: "records" };
  }
  return current;
}

function feedOf(graph: ClaspGraph, objectId: string, port: string): ListState["feed"] {
  const connection = Object.values(graph.connections).find(
    (candidate) => candidate.kind === "value" && candidate.target.objectId === objectId && candidate.target.port === port,
  );
  return connection ? { connectionId: connection.id, from: { ...connection.source } } : undefined;
}

function textFields(fields: Record<string, FieldDefinition>): string[] {
  return Object.entries(fields)
    .filter(([, definition]) => definition.type === "string")
    .map(([name]) => name);
}

/**
 * Turns a feature plan into graph operations, reusing what the application
 * already has: an entity's existing collection, window, form and list are
 * found and extended rather than duplicated. Deterministic: the same plan on
 * the same graph always yields the same structure.
 */
export class FeatureBuilder {
  readonly operations: GraphOperation[] = [];
  readonly described: string[] = [];
  readonly issues: string[] = [];
  readonly view: SchemaView;
  private readonly graph: ClaspGraph;
  private readonly registry: ComponentRegistry;
  private readonly entitySpecs: EntitySpec[];
  private readonly entities = new Map<string, EntityState>();
  private readonly created = new Map<string, { type: string; parentId?: string; order: number }>();
  private readonly newSchemas: SchemaDefinition[] = [];
  private windowId: string | undefined;
  private windowIsNew = false;
  private widened = false;
  private slotCounter = 0;

  constructor(
    private readonly plan: FeaturePlan,
    context: CompileContext,
  ) {
    this.graph = context.graph;
    this.registry = context.registry;
    this.view = new SchemaView(context.schemas);
    this.entitySpecs = Array.isArray(plan.entities) ? plan.entities.filter((entry) => entry && typeof entry.name === "string") : [];
  }

  // ── primitives for feature implementations ─────────────────────────────

  create(type: string, name: string, properties: Record<string, JsonValue | undefined>, place?: { parentId: string; order: number }): string {
    const id = createId("obj");
    const clean: JsonObject = {};
    for (const [key, value] of Object.entries(properties)) if (value !== undefined) clean[key] = value;
    this.operations.push({
      op: "create",
      object: { id, type, name, properties: clean, ...(place ? { parentId: place.parentId, order: place.order } : {}) },
    });
    this.created.set(id, { type, ...(place ? { parentId: place.parentId } : {}), order: place?.order ?? 0 });
    return id;
  }

  connect(from: PortRef | string, to: PortRef | string): void {
    const ref = (value: PortRef | string): PortRef => {
      if (typeof value !== "string") return value;
      const dot = value.lastIndexOf(".");
      return { objectId: value.slice(0, dot), port: value.slice(dot + 1) };
    };
    this.operations.push({ op: "connect", connection: { source: ref(from), target: ref(to) } });
  }

  update(objectId: string, properties: JsonObject): void {
    this.operations.push({ op: "update", objectId, properties });
  }

  /** True when a value input already has a connection (existing or planned). */
  inputTaken(objectId: string, port: string): boolean {
    const existing = Object.values(this.graph.connections).some(
      (connection) => connection.kind === "value" && connection.target.objectId === objectId && connection.target.port === port,
    );
    const planned = this.operations.some(
      (operation) => operation.op === "connect" && operation.connection.target.objectId === objectId && operation.connection.target.port === port,
    );
    return existing || planned;
  }

  /** The window visible elements go into, created on first use. */
  window(width?: "narrow" | "regular" | "wide"): string {
    if (this.windowId) return this.windowId;
    const existing = childrenOf(this.graph, undefined).find((object) => object.type === "ui.window");
    if (existing) {
      this.windowId = existing.id;
      return existing.id;
    }
    const title = this.plan.title ?? this.graph.metadata.name;
    this.windowId = this.create("ui.window", "Window", {
      title,
      ...(this.plan.subtitle ? { subtitle: this.plan.subtitle } : {}),
      ...(width ? { width } : {}),
    });
    this.windowIsNew = true;
    return this.windowId;
  }

  /** Asks for a wide window (calendars, tables). Only a window created by this compilation is changed. */
  widen(): void {
    const windowId = this.window();
    if (this.windowIsNew && !this.widened) {
      this.widened = true;
      this.update(windowId, { width: "wide" });
    }
  }

  /**
   * Where a new visible element goes. In a new window elements are grouped
   * top → controls → content → footer; in an existing one they are placed
   * around the entity's list (or appended).
   */
  place(slot: Slot, anchorListId?: string): { parentId: string; order: number } {
    const step = ++this.slotCounter * 0.001;
    const windowId = this.window();
    if (this.windowIsNew) {
      const base = { top: 0, controls: 100, content: 200, footer: 300 }[slot];
      return { parentId: windowId, order: base + this.slotCounter };
    }
    const anchor = anchorListId ? (this.graph.objects[anchorListId] ?? undefined) : undefined;
    if (anchor?.parentId && slot !== "top") {
      const order = slot === "controls" ? anchor.order - 0.5 + step : anchor.order + 0.5 + step;
      return { parentId: anchor.parentId, order };
    }
    const siblings = childrenOf(this.graph, windowId);
    const min = siblings.reduce((low, object) => Math.min(low, object.order), 0);
    const max = siblings.reduce((high, object) => Math.max(high, object.order), 0);
    if (slot === "top") return { parentId: windowId, order: min - 1 + step };
    return { parentId: windowId, order: max + 1 + { top: 0, controls: 0.1, content: 0.2, footer: 0.3 }[slot] + step };
  }

  // ── entities ───────────────────────────────────────────────────────────

  /** Resolves an entity by name: its schema, its data source (found or created) and its lists. */
  entity(name: string): EntityState | undefined {
    if (typeof name !== "string" || !name.trim()) {
      this.issues.push('A feature needs an "entity" naming the records it works on.');
      return undefined;
    }
    for (const [key, state] of this.entities) if (sameEntity(key, name)) return state;
    const spec = this.entitySpecs.find((candidate) => sameEntity(candidate.name, name));
    const resolved = resolveEntity(name, spec, this.view);
    if ("message" in resolved) {
      this.issues.push(resolved.message);
      return undefined;
    }
    for (const schema of resolved.newSchemas) this.newSchemas.push(schema);

    // Find the existing source: same schema (or an ancestor of it), or the same name.
    const sources = Object.values(this.graph.objects).filter((object) => SOURCES.has(object.type));
    const source =
      sources.find((object) => {
        const schemaId = object.properties.schema;
        if (typeof schemaId !== "string") return false;
        if (schemaId === resolved.schemaId) return true;
        return this.view.get(resolved.schemaId)?.lineage.includes(schemaId) === true;
      }) ?? sources.find((object) => sameEntity(object.metadata.name ?? "", resolved.plural));

    let sourceId: string;
    if (source) {
      sourceId = source.id;
      if (source.type === "data.collection" && source.properties.schema !== resolved.schemaId) {
        // The entity gained fields: the collection moves to the extended schema. Its records are kept.
        this.update(source.id, { schema: resolved.schemaId });
        this.described.push(`${resolved.plural} gain new fields; existing ${resolved.plural.toLowerCase()} are kept`);
      }
    } else {
      sourceId = this.create("data.collection", resolved.plural, { schema: resolved.schemaId, exposure: "private" });
      const fields = Object.keys(resolved.fields).join(", ");
      this.described.push(
        resolved.builtin
          ? `Stores ${resolved.plural.toLowerCase()} in the shared ${resolved.name} format`
          : `Stores ${resolved.plural.toLowerCase()} (${fields})`,
      );
    }

    const lists: ListState[] = Object.values(this.graph.objects)
      .filter((object) => VIEWS.has(object.type))
      .map((object) => ({ object, port: (object.type === "ui.table" ? "rows" : "items") as "items" | "rows" }))
      .filter(({ object, port }) => traceSource(this.graph, object.id, port) === sourceId)
      .map(({ object, port }) => ({ id: object.id, port, feed: feedOf(this.graph, object.id, port), isNew: false, type: object.type }));
    const state: EntityState = {
      entity: resolved,
      sourceId,
      formInputs: new Map(),
      calendars: [],
      lists,
      // With no list left, search, filters and sorts may still be chained after the source: new lists join at their end.
      tail: lists[0]?.feed?.from ?? chainEnd(this.graph, sourceId),
      stagesAdded: false,
    };
    // A chain with no list yet still needs one fed from its end.
    if (lists.length === 0 && (state.tail.objectId !== sourceId || state.tail.port !== "records")) state.stagesAdded = true;
    this.entities.set(resolved.name, state);
    return state;
  }

  field(state: EntityState, name: string | undefined, purpose: string): string | undefined {
    if (!name) return undefined;
    const field = toFieldName(name);
    if (state.entity.fields[field]) return field;
    this.issues.push(
      `${state.entity.name} has no field "${name}" (${purpose}). Its fields are: ${Object.keys(state.entity.fields).join(", ")}. Add the field to the entity, or use one of these.`,
    );
    return undefined;
  }

  /** The field a list shows as each row's title. */
  titleField(state: EntityState): string {
    const fields = state.entity.fields;
    if (fields.title) return "title";
    if (fields.name) return "name";
    return textFields(fields)[0] ?? Object.keys(fields)[0] ?? "title";
  }

  /** Adds a records-processing step between the data and the lists. */
  stage(state: EntityState, objectId: string): void {
    this.connect(state.tail, { objectId, port: "records" });
    state.tail = { objectId, port: "records" };
    state.stagesAdded = true;
  }

  // ── compile ────────────────────────────────────────────────────────────

  build(extensions: readonly FeatureExtension[] = []): CompiledFeatures {
    const features: FeatureSpec[] = Array.isArray(this.plan.features) ? [...this.plan.features] : [];
    // Entities described without features: give each a way to add and see records.
    if (features.length === 0) {
      for (const spec of this.entitySpecs) {
        features.push({ kind: "add", entity: spec.name }, { kind: "list", entity: spec.name });
      }
    }
    if (features.length === 0 && !this.plan.title) this.issues.push("The plan describes no features.");
    if (this.plan.title && !features.some((feature) => feature?.kind === "title")) {
      const existing = childrenOf(this.graph, undefined).find((object) => object.type === "ui.window");
      if (existing && existing.properties.title !== this.plan.title && features.length === 0) {
        features.push({ kind: "title", text: this.plan.title, ...(this.plan.subtitle ? { subtitle: this.plan.subtitle } : {}) });
      }
    }
    const handlers = new Map(extensions.map((extension) => [extension.kind, extension]));

    for (const feature of features) {
      if (!feature || typeof feature !== "object" || typeof (feature as { kind?: unknown }).kind !== "string") {
        this.issues.push("Every feature needs a \"kind\".");
        continue;
      }
      const extension = handlers.get(feature.kind);
      if (extension) {
        extension.compile(feature, this);
        continue;
      }
      switch (feature.kind) {
        case "title":
          this.title(feature);
          break;
        case "add":
          this.add(feature);
          break;
        case "list":
          this.list(feature);
          break;
        case "search":
          this.search(feature);
          break;
        case "filter":
          this.filter(feature);
          break;
        case "sort":
          this.sort(feature);
          break;
        case "count":
          this.count(feature);
          break;
        case "share":
          this.share(feature);
          break;
        case "calendar":
          this.calendar(feature);
          break;
        case "board":
          this.board(feature);
          break;
        case "tool":
          this.tool(feature);
          break;
        case "document":
          this.issues.push(
            DOCUMENT_EDITORS.includes(feature.editor)
              ? "Document editors are not available in this workspace."
              : `Unknown editor "${String(feature.editor)}". Use one of: ${DOCUMENT_EDITORS.join(", ")}.`,
          );
          break;
        default:
          this.issues.push(
            `Unknown feature kind "${String((feature as { kind: unknown }).kind)}". Use one of: title, add, list, search, filter, sort, count, share, calendar, board, tool, document.`,
          );
      }
    }
    this.finish();
    return { operations: this.operations, schemas: this.newSchemas, described: this.described, issues: this.issues };
  }

  /** The add-form input for a field: one made in this compilation, or one already in the form. */
  private formInputFor(state: EntityState, field: string): string | undefined {
    const made = state.formInputs.get(field);
    if (made) return made;
    const form = this.formFor(state);
    if (!form) return undefined;
    return Object.values(this.graph.objects).find((object) => {
      if (object.properties.field !== field) return false;
      for (let parent = object.parentId; parent; parent = this.graph.objects[parent]?.parentId) if (parent === form.id) return true;
      return false;
    })?.id;
  }

  private finish(): void {
    for (const state of this.entities.values()) {
      for (const calendar of state.calendars) {
        const input = this.formInputFor(state, calendar.field);
        if (input) this.connect(`${calendar.id}.dayPicked`, `${input}.set`);
      }
    }
    for (const state of this.entities.values()) {
      if (state.stagesAdded && state.lists.length === 0) {
        this.issues.push(`There is no list of ${state.entity.plural.toLowerCase()} to search, filter or sort. Add a "list" feature for ${state.entity.name}.`);
        continue;
      }
      // The first list (and any new ones) receive the processed records.
      state.lists.forEach((list, index) => {
        if (!list.isNew && index > 0) return;
        if (!list.isNew && !state.stagesAdded) return;
        const target = { objectId: list.id, port: list.port };
        if (list.feed && (list.feed.from.objectId !== state.tail.objectId || list.feed.from.port !== state.tail.port)) {
          this.operations.push({ op: "disconnect", connectionId: list.feed.connectionId });
        } else if (list.feed) {
          return;
        }
        this.connect(state.tail, target);
      });
    }
  }

  // ── built-in features ──────────────────────────────────────────────────

  private title(feature: Extract<FeatureSpec, { kind: "title" }>): void {
    if (!feature.text) {
      this.issues.push('A "title" feature needs "text".');
      return;
    }
    this.update(this.window(), { title: feature.text, ...(feature.subtitle ? { subtitle: feature.subtitle } : {}) });
    this.described.push(`Titles the window “${feature.text}”`);
  }

  private formFor(state: EntityState): ClaspObject | undefined {
    return Object.values(this.graph.objects).find(
      (object) =>
        object.type === "ui.form" &&
        Object.values(this.graph.connections).some(
          (connection) => connection.source.objectId === object.id && connection.source.port === "submitted" && connection.target.objectId === state.sourceId,
        ),
    );
  }

  private input(state: EntityState, field: string, place: { parentId: string; order: number }, withLabel: boolean): { id: string; submits: boolean } | undefined {
    const definition = state.entity.fields[field];
    if (!definition) return undefined;
    const label = definition.title ?? humanize(field);
    const required = definition.required === true ? { required: true } : {};
    switch (definition.type) {
      case "number":
        return { id: this.create("ui.numberInput", `${label} input`, { field, label: withLabel ? label : undefined, placeholder: label, ...required }, place), submits: true };
      case "boolean":
        return { id: this.create("ui.checkbox", `${label} checkbox`, { field, label }, place), submits: false };
      case "enum":
        return {
          id: this.create("ui.select", `${label} select`, { field, label: withLabel ? label : undefined, options: [...(definition.values ?? [])], placeholder: label, ...required }, place),
          submits: false,
        };
      case "date":
      case "datetime":
        return { id: this.create("ui.textInput", `${label} input`, { field, label, inputType: "date", ...required }, place), submits: false };
      case "string": {
        const long = /notes|description|body|content|comment|details/i.test(field);
        return {
          id: this.create(
            "ui.textInput",
            `${label} input`,
            {
              field,
              label: withLabel ? label : undefined,
              placeholder: `${state.entity.name} ${label.toLowerCase()}`,
              multiline: long ? true : undefined,
              ...required,
            },
            place,
          ),
          submits: !long,
        };
      }
      default:
        return undefined;
    }
  }

  private add(feature: Extract<FeatureSpec, { kind: "add" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const spec = this.entitySpecs.find((candidate) => sameEntity(candidate.name, feature.entity));
    let fields: string[];
    if (Array.isArray(feature.fields) && feature.fields.length > 0) {
      fields = feature.fields.map((name) => this.field(state, name, "in the add form")).filter((name): name is string => name !== undefined);
    } else if (spec?.fields?.length) {
      fields = spec.fields.map((entry) => toFieldName(entry.name)).filter((name) => state.entity.fields[name]);
      // Built-in entities: their required fields come first.
      for (const [name, definition] of Object.entries(state.entity.fields)) {
        if (definition.required && !fields.includes(name)) fields.unshift(name);
      }
    } else {
      const required = Object.entries(state.entity.fields)
        .filter(([, definition]) => definition.required)
        .map(([name]) => name);
      fields = required.length > 0 ? required : [this.titleField(state)];
    }
    fields = fields.filter((name) => ["string", "number", "boolean", "enum", "date", "datetime"].includes(state.entity.fields[name]?.type ?? ""));
    if (fields.length === 0) {
      this.issues.push(`The add form for ${state.entity.name} has no fields it can show.`);
      return;
    }

    const existing = this.formFor(state);
    if (existing) {
      // Extend the existing form with the fields it lacks.
      const present = new Set(
        Object.values(this.graph.objects)
          .filter((object) => typeof object.properties.field === "string")
          .filter((object) => {
            let parent = object.parentId;
            while (parent) {
              if (parent === existing.id) return true;
              parent = this.graph.objects[parent]?.parentId;
            }
            return false;
          })
          .map((object) => object.properties.field as string),
      );
      const missing = fields.filter((field) => !present.has(field));
      if (missing.length === 0) return;
      const children = childrenOf(this.graph, existing.id);
      const button = children.find((child) => child.type === "ui.button");
      const order = button ? button.order : (children.at(-1)?.order ?? 0) + 1;
      missing.forEach((field, index) => {
        const made = this.input(state, field, { parentId: existing.id, order: order - 0.5 + index * 0.01 }, true);
        if (made) state.formInputs.set(field, made.id);
      });
      this.described.push(`Adds ${missing.map((field) => humanize(field).toLowerCase()).join(", ")} to the form for new ${state.entity.plural.toLowerCase()}`);
      return;
    }

    const inline = fields.length === 1 && state.entity.fields[fields[0] as string]?.type === "string";
    const place = this.place("top");
    const formId = this.create("ui.form", feature.name ?? `New ${state.entity.name.toLowerCase()} form`, inline ? { direction: "row", gap: "small" } : { direction: "column", gap: "medium" }, place);
    let firstSubmitting: string | undefined;
    fields.forEach((field, index) => {
      const made = this.input(state, field, { parentId: formId, order: index }, !inline);
      if (made) state.formInputs.set(field, made.id);
      if (made?.submits && !firstSubmitting) firstSubmitting = made.id;
    });
    const label = feature.button ?? `Add ${state.entity.name}`;
    const buttonId = this.create("ui.button", `${label} button`, { label, variant: "primary" }, { parentId: formId, order: fields.length });
    this.connect(`${buttonId}.click`, `${formId}.submit`);
    if (firstSubmitting && inline) this.connect(`${firstSubmitting}.submitted`, `${formId}.submit`);
    this.connect(`${formId}.submitted`, `${state.sourceId}.create`);
    // An existing calendar fills in the new form's date when a day is picked.
    for (const list of state.lists) {
      const calendar = this.graph.objects[list.id];
      if (list.isNew || calendar?.type !== "ui.calendar") continue;
      const field = typeof calendar.properties.dateField === "string" ? calendar.properties.dateField : undefined;
      if (field && state.formInputs.has(field) && !state.calendars.some((entry) => entry.id === list.id)) state.calendars.push({ id: list.id, field });
    }
    this.described.push(`A form to add ${state.entity.plural.toLowerCase()} (${fields.map((field) => humanize(field).toLowerCase()).join(", ")})`);
  }

  private list(feature: Extract<FeatureSpec, { kind: "list" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const display = feature.display === "table" ? "table" : "list";
    const type = display === "table" ? "ui.table" : "ui.list";
    const fields = (feature.fields ?? []).map((name) => this.field(state, name, "in the list")).filter((name): name is string => name !== undefined);
    const toggle = feature.toggle ? this.field(state, feature.toggle, "as the checkbox") : undefined;
    if (feature.toggle && !toggle) return;
    if (toggle && state.entity.fields[toggle]?.type !== "boolean") {
      this.issues.push(`"${feature.toggle}" is not a true/false field of ${state.entity.name}, so it cannot be a checkbox.`);
      return;
    }
    const editable = feature.editable !== false;
    const removable = feature.removable !== false;
    const plural = state.entity.plural.toLowerCase();

    if (display === "table") {
      const columnFields = fields.length > 0 ? fields : Object.keys(state.entity.fields).filter((name) => !["reference", "list", "json"].includes(state.entity.fields[name]?.type ?? ""));
      const columns = columnFields.map((field) => ({
        field,
        label: state.entity.fields[field]?.title ?? humanize(field),
        ...(editable && ["string", "number"].includes(state.entity.fields[field]?.type ?? "") ? { editable: true } : {}),
      }));
      const existing = state.lists.find((list) => list.type === type);
      if (existing) {
        this.update(existing.id, { columns, removable });
        this.described.push(`Shows ${plural} in a table with columns ${columnFields.join(", ")}`);
        return;
      }
      this.widen();
      const id = this.create(type, feature.name ?? `${state.entity.name} table`, { columns, removable, emptyText: `No ${plural} yet.` }, this.place("content"));
      if (editable) this.connect(`${id}.change`, `${state.sourceId}.update`);
      if (removable) this.connect(`${id}.remove`, `${state.sourceId}.delete`);
      state.lists.push({ id, port: "rows", feed: undefined, isNew: true, type });
      this.described.push(`A table of ${plural}${editable ? " you can edit" : ""}`);
      return;
    }

    const title = fields[0] ?? this.titleField(state);
    const subtitle =
      fields[1] ??
      (this.entitySpecs.find((spec) => sameEntity(spec.name, feature.entity))?.fields ?? [])
        .map((entry) => toFieldName(entry.name))
        .find((name) => name !== title && name !== toggle && ["string", "number", "date", "enum"].includes(state.entity.fields[name]?.type ?? ""));
    const check = toggle ?? Object.keys(state.entity.fields).find((name) => state.entity.fields[name]?.type === "boolean");
    const properties: JsonObject = {
      titleField: title,
      ...(subtitle ? { subtitleField: subtitle } : {}),
      ...(check ? { checkField: check } : {}),
      editable,
      removable,
    };
    const existing = state.lists.find((list) => list.type === type);
    if (existing) {
      this.update(existing.id, properties);
      this.described.push(`The list of ${plural} shows ${humanize(title).toLowerCase()}${check ? ` with a ${humanize(check).toLowerCase()} checkbox` : ""}`);
      return;
    }
    const id = this.create(type, feature.name ?? `${state.entity.name} list`, { ...properties, emptyText: `No ${plural} yet.` }, this.place("content"));
    if (editable || check) this.connect(`${id}.change`, `${state.sourceId}.update`);
    if (removable) this.connect(`${id}.remove`, `${state.sourceId}.delete`);
    state.lists.push({ id, port: "items", feed: undefined, isNew: true, type });
    const abilities = [check ? `tick off as ${humanize(check).toLowerCase()}` : undefined, editable ? "edit" : undefined, removable ? "remove" : undefined].filter(Boolean);
    this.described.push(`A list of ${plural}${abilities.length > 0 ? ` you can ${abilities.join(", ")}` : ""}`);
  }

  private search(feature: Extract<FeatureSpec, { kind: "search" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const field = feature.field ? this.field(state, feature.field, "to search") : this.titleField(state);
    if (!field) return;
    const plural = state.entity.plural.toLowerCase();
    const anchor = state.lists[0]?.id;
    const input = this.create("ui.textInput", feature.name ?? `${state.entity.plural} search`, { placeholder: `Search ${plural}…` }, this.place("controls", anchor));
    const filter = this.create("data.filter", `${state.entity.plural} search filter`, { field, operator: "contains" });
    this.connect(`${input}.value`, `${filter}.value`);
    this.stage(state, filter);
    this.described.push(`Search ${plural} by ${humanize(field).toLowerCase()}`);
  }

  private filter(feature: Extract<FeatureSpec, { kind: "filter" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const field = this.field(state, feature.field, "to filter by");
    if (!field) return;
    const definition = state.entity.fields[field] as FieldDefinition;
    const label = definition.title ?? humanize(field);
    const plural = state.entity.plural.toLowerCase();

    if (feature.value !== undefined && feature.value !== null) {
      const filter = this.create("data.filter", feature.name ?? `${label} filter`, { field, operator: "eq", value: feature.value });
      this.stage(state, filter);
      this.described.push(`Shows only ${plural} whose ${label.toLowerCase()} is ${JSON.stringify(feature.value)}`);
      return;
    }
    let options: Array<{ label: string; value: JsonValue }>;
    if (Array.isArray(feature.options) && feature.options.length > 0) {
      options = [{ label: "All", value: null }, ...feature.options.filter((option) => option && typeof option.label === "string")];
    } else if (definition.type === "boolean") {
      options = [
        { label: "All", value: null },
        { label, value: true },
        { label: `Not ${label.toLowerCase()}`, value: false },
      ];
    } else if (definition.type === "enum") {
      options = [{ label: "All", value: null }, ...(definition.values ?? []).map((value) => ({ label: humanize(value), value }))];
    } else {
      this.issues.push(`Tabs can only filter by a true/false or choice field; "${feature.field}" is ${definition.type}. Use "search", or give the filter a "value".`);
      return;
    }
    const tabs = this.create("ui.tabs", feature.name ?? `${label} tabs`, { options }, this.place("controls", state.lists[0]?.id));
    const filter = this.create("data.filter", `${label} filter`, { field, operator: "eq" });
    this.connect(`${tabs}.value`, `${filter}.value`);
    this.stage(state, filter);
    this.described.push(`Filter ${plural} by ${label.toLowerCase()}`);
  }

  private sort(feature: Extract<FeatureSpec, { kind: "sort" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const field = this.field(state, feature.field, "to sort by");
    if (!field) return;
    const direction = feature.direction === "desc" ? "desc" : "asc";
    const sort = this.create("data.sort", feature.name ?? `Sort by ${humanize(field).toLowerCase()}`, { field, direction });
    this.stage(state, sort);
    this.described.push(`Sorts ${state.entity.plural.toLowerCase()} by ${humanize(field).toLowerCase()}${direction === "desc" ? ", newest/largest first" : ""}`);
  }

  private count(feature: Extract<FeatureSpec, { kind: "count" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const plural = state.entity.plural.toLowerCase();
    let where: JsonObject = {};
    if (feature.where && typeof feature.where === "object") {
      const field = this.field(state, feature.where.field, "in the count");
      if (!field) return;
      where = { whereField: field, whereOperator: "eq", whereValue: feature.where.value ?? null };
    }
    const label = feature.label ?? plural;
    const aggregate = this.create("data.aggregate", feature.name ?? `${state.entity.plural} count`, { operation: "count", ...where });
    const text = this.create("ui.text", `${humanize(label)} label`, { text: `{value} ${label}`, variant: "muted" }, this.place("footer", state.lists[0]?.id));
    this.connect(`${state.sourceId}.records`, `${aggregate}.records`);
    this.connect(`${aggregate}.value`, `${text}.value`);
    this.described.push(`Shows how many ${label} there are`);
  }

  private calendar(feature: Extract<FeatureSpec, { kind: "calendar" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const fields = state.entity.fields;
    const dated = Object.keys(fields).filter((name) => fields[name]?.type === "date" || fields[name]?.type === "datetime");
    const field = feature.field ? this.field(state, feature.field, "to place on the calendar") : (["start", "date", "dueDate"].find((name) => dated.includes(name)) ?? dated[0]);
    if (feature.field && !field) return;
    if (!field) {
      this.issues.push(`${state.entity.name} has no date field to place on a calendar. Add one (type "date") to the entity.`);
      return;
    }
    if (!dated.includes(field)) {
      this.issues.push(`"${feature.field}" is not a date field of ${state.entity.name}, so it cannot place records on a calendar.`);
      return;
    }
    if (state.lists.some((list) => list.type === "ui.calendar")) return; // already has one
    this.widen();
    const id = this.create(
      "ui.calendar",
      feature.name ?? `${state.entity.name} calendar`,
      { dateField: field, titleField: this.titleField(state) },
      this.place("content"),
    );
    state.lists.push({ id, port: "items", feed: undefined, isNew: true, type: "ui.calendar" });
    state.calendars.push({ id, field });
    this.described.push(`A month calendar of ${state.entity.plural.toLowerCase()} by ${humanize(field).toLowerCase()}; clicking a day fills in the date`);
  }

  private board(feature: Extract<FeatureSpec, { kind: "board" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const fields = state.entity.fields;
    const choices = Object.keys(fields).filter((name) => fields[name]?.type === "enum");
    const field = feature.field ? this.field(state, feature.field, "to make the board's columns from") : (["status", "stage", "state", "column"].find((name) => choices.includes(name)) ?? choices[0]);
    if (feature.field && !field) return;
    if (!field) {
      this.issues.push(`${state.entity.name} has no choice field to make columns from. Add one (type "choice", with the columns as options) to the entity.`);
      return;
    }
    const definition = fields[field];
    if (definition?.type !== "enum") {
      this.issues.push(`"${field}" is not a choice field of ${state.entity.name}, so it cannot make the board's columns.`);
      return;
    }
    const options = definition.values ?? [];
    const columns = feature.columns && feature.columns.length > 0 ? feature.columns.filter((column) => options.includes(column)) : [...options];
    if (columns.length === 0) {
      this.issues.push(`None of the columns ${JSON.stringify(feature.columns)} is an option of ${humanize(field).toLowerCase()} (${options.join(", ")}).`);
      return;
    }
    if (state.lists.some((list) => list.type === "ui.board")) return; // already has one
    this.widen();
    const id = this.create(
      "ui.board",
      feature.name ?? `${state.entity.name} board`,
      { groupField: field, columns, titleField: this.titleField(state) },
      this.place("content"),
    );
    state.lists.push({ id, port: "items", feed: undefined, isNew: true, type: "ui.board" });
    this.connect(`${id}.change`, `${state.sourceId}.update`);
    this.connect(`${id}.remove`, `${state.sourceId}.delete`);
    this.described.push(`A board of ${state.entity.plural.toLowerCase()} in columns by ${humanize(field).toLowerCase()} (${columns.join(", ")}); cards can be dragged between columns`);
  }

  /** A ready-made instrument in the window; games also get a high-score list. */
  private tool(feature: Extract<FeatureSpec, { kind: "tool" }>): void {
    const tool = TOOLS[feature.tool as keyof typeof TOOLS] as (typeof TOOLS)[keyof typeof TOOLS] | undefined;
    if (!tool) {
      this.issues.push(`Unknown tool "${String(feature.tool)}". Use one of: ${TOOL_NAMES.join(", ")}.`);
      return;
    }
    if (!this.registry.has(tool.type)) {
      this.issues.push(`The ${String(feature.tool)} is not available in this workspace.`);
      return;
    }
    const mode = (tool.properties as Record<string, string>).mode;
    const exists = Object.values(this.graph.objects).some((object) => object.type === tool.type && (mode === undefined || object.properties.mode === mode));
    if (exists) return; // already there
    this.window(tool.width);
    const id = this.create(tool.type, feature.name ?? humanize(String(feature.tool)), { ...tool.properties }, this.place("content"));
    let described = tool.noun;
    if ("game" in tool && tool.game && feature.scores !== false) {
      const scores = this.create("data.collection", "Scores", { schema: "clasp.score", exposure: "private" });
      const best = this.create("data.sort", "Best first", { field: "score", direction: "desc" });
      this.create("ui.text", "Scores heading", { text: "High scores", variant: "heading" }, this.place("content"));
      const list = this.create(
        "ui.list",
        "High scores",
        { titleField: "summary", subtitleField: "playedOn", removable: true, emptyText: "Finish a game to get on the board." },
        this.place("content"),
      );
      this.connect(`${id}.finished`, `${scores}.create`);
      this.connect(`${scores}.records`, `${best}.records`);
      this.connect(`${best}.records`, `${list}.items`);
      this.connect(`${list}.remove`, `${scores}.delete`);
      described += ", with a high-score list";
    }
    this.described.push(described);
  }

  private share(feature: Extract<FeatureSpec, { kind: "share" }>): void {
    const state = this.entity(feature.entity);
    if (!state) return;
    const source = this.graph.objects[state.sourceId];
    const isNew = this.created.has(state.sourceId);
    if (!isNew && source?.type !== "data.collection") {
      this.issues.push(`${state.entity.plural} belong to another application; only their owner can share them.`);
      return;
    }
    this.update(state.sourceId, { exposure: "discoverable" });
    this.described.push(`Other applications can discover ${state.entity.plural.toLowerCase()} (and ask you for access)`);
  }
}

/** Compiles a feature plan against an application's graph. */
export function compileFeatures(plan: FeaturePlan, context: CompileContext, extensions: readonly FeatureExtension[] = []): CompiledFeatures {
  return new FeatureBuilder(plan, context).build(extensions);
}
