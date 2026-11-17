import type { FieldDefinition, ResolvedSchema, SchemaDefinition, SchemaRegistry } from "@clasp/schemas";
import { FIELD_KINDS, type EntitySpec, type FieldSpec } from "./spec";

// ── names ────────────────────────────────────────────────────────────────

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** "Due date" → "dueDate". */
export function toFieldName(text: string): string {
  const parts = words(text);
  if (parts.length === 0) return "value";
  const name = parts.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join("");
  const safe = /^[a-zA-Z]/.test(name) ? name : `f${name}`;
  return safe === "id" ? "identifier" : safe;
}

/** "dueDate" → "Due date". */
export function humanize(name: string): string {
  const text = words(name).join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "recipe" → "Recipe", "book club member" → "Book club member". */
export function capitalize(text: string): string {
  const trimmed = text.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export function singularize(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Compares entity names loosely: case, spacing and plural do not matter. */
export function sameEntity(a: string, b: string): boolean {
  const norm = (text: string): string => singularize(words(text).join("").toLowerCase());
  return norm(a) === norm(b);
}

// ── schemas ──────────────────────────────────────────────────────────────

/** Built-in entities and the shared schemas they map to. Using them keeps data interoperable. */
export const BUILTIN_ENTITIES: Record<string, string> = {
  task: "clasp.task",
  todo: "clasp.task",
  note: "clasp.note",
  contact: "clasp.contact",
  person: "clasp.contact",
  event: "clasp.event",
  project: "clasp.project",
  document: "clasp.document",
  score: "clasp.score",
};

export function fieldDefinition(spec: FieldSpec): FieldDefinition {
  const title = spec.label ?? humanize(spec.name);
  const required = spec.required === true ? { required: true } : {};
  switch (spec.type) {
    case "number":
      return { type: "number", title, ...required };
    case "boolean":
      return { type: "boolean", title, default: false };
    case "date":
      return { type: "date", title, ...required };
    case "choice":
      return { type: "enum", title, values: spec.options && spec.options.length > 0 ? [...spec.options] : ["yes", "no"], ...required };
    case "longtext":
      return { type: "string", title, ...required, ...(spec.required ? { minLength: 1 } : {}) };
    default:
      return { type: "string", title, ...required, ...(spec.required ? { minLength: 1 } : {}) };
  }
}

export interface ResolvedEntity {
  name: string;
  plural: string;
  schemaId: string;
  fields: Record<string, FieldDefinition>;
  /** Schema definitions that must be registered before the result is used. */
  newSchemas: SchemaDefinition[];
  /** True when the entity uses a built-in schema directly or by extension. */
  builtin: boolean;
}

export interface EntityProblem {
  message: string;
}

/** Schema lookups that also see definitions planned in this same compilation. */
export class SchemaView {
  private readonly pending = new Map<string, SchemaDefinition>();

  constructor(readonly registry: SchemaRegistry) {}

  add(definition: SchemaDefinition): void {
    this.pending.set(definition.id, definition);
  }

  get(id: string): { id: string; version: number; fields: Record<string, FieldDefinition>; lineage: string[] } | undefined {
    const planned = this.pending.get(id);
    if (planned) {
      const parent = planned.extends ? this.get(planned.extends) : undefined;
      return {
        id,
        version: planned.version,
        fields: { ...(parent?.fields ?? {}), ...planned.fields },
        lineage: [id, ...(parent?.lineage ?? [])],
      };
    }
    const resolved: ResolvedSchema | undefined = this.registry.get(id);
    return resolved ? { id: resolved.id, version: resolved.version, fields: resolved.fields, lineage: resolved.lineage } : undefined;
  }
}

/**
 * Decides which schema an entity's records use.
 *
 * - Built-in entities use the shared schema (clasp.task, …); requested
 *   fields it lacks go into an extension schema (`user.task` extends
 *   `clasp.task`), so other applications can still read the records.
 * - Other entities get a `user.<name>` schema. If one exists and lacks
 *   requested fields, a new version adds them (old records stay valid).
 */
export function resolveEntity(name: string, spec: EntitySpec | undefined, schemas: SchemaView): ResolvedEntity | EntityProblem {
  const display = capitalize(singularize(spec?.name ?? name));
  const plural = spec?.plural ? capitalize(spec.plural) : pluralize(display);
  const slug = toFieldName(display);
  const requested: Record<string, FieldDefinition> = {};
  for (const field of spec?.fields ?? []) {
    if (!field || typeof field.name !== "string" || !field.name.trim()) return { message: `A field of "${display}" has no name.` };
    if (!FIELD_KINDS.includes(field.type)) {
      return { message: `Field "${field.name}" of "${display}" has type "${String(field.type)}". Use one of: ${FIELD_KINDS.join(", ")}.` };
    }
    requested[toFieldName(field.name)] = fieldDefinition(field);
  }

  const builtinId = BUILTIN_ENTITIES[slug.toLowerCase()];
  const userId = `user.${slug}`;
  const merge = (base: Record<string, FieldDefinition>): Record<string, FieldDefinition> => {
    const extra: Record<string, FieldDefinition> = {};
    for (const [field, definition] of Object.entries(requested)) if (!base[field]) extra[field] = definition;
    return extra;
  };

  if (builtinId) {
    const base = schemas.get(builtinId);
    if (!base) return { message: `The built-in schema ${builtinId} is not available.` };
    const existingUser = schemas.get(userId);
    // An extension already exists (from an earlier change): build on it.
    const current = existingUser && existingUser.lineage.includes(builtinId) ? existingUser : base;
    const extra = merge(current.fields);
    if (Object.keys(extra).length === 0) {
      return { name: display, plural, schemaId: current.id, fields: current.fields, newSchemas: [], builtin: true };
    }
    const definition: SchemaDefinition = existingUser && current === existingUser
      ? {
          id: userId,
          version: existingUser.version + 1,
          title: display,
          extends: builtinId,
          fields: { ...Object.fromEntries(Object.entries(existingUser.fields).filter(([field]) => !base.fields[field])), ...extra },
        }
      : { id: userId, version: 1, title: display, extends: builtinId, fields: extra };
    schemas.add(definition);
    return { name: display, plural, schemaId: userId, fields: { ...current.fields, ...extra }, newSchemas: [definition], builtin: true };
  }

  const existing = schemas.get(userId);
  if (existing) {
    const extra = merge(existing.fields);
    if (Object.keys(extra).length === 0) return { name: display, plural, schemaId: userId, fields: existing.fields, newSchemas: [], builtin: false };
    const definition: SchemaDefinition = {
      id: userId,
      version: existing.version + 1,
      title: display,
      fields: { ...existing.fields, ...extra },
    };
    schemas.add(definition);
    return { name: display, plural, schemaId: userId, fields: definition.fields, newSchemas: [definition], builtin: false };
  }

  // A new kind of record. Without described fields it gets a title.
  const fields = Object.keys(requested).length > 0 ? requested : { title: fieldDefinition({ name: "title", type: "text", required: true }) };
  const definition: SchemaDefinition = { id: userId, version: 1, title: display, description: `${plural}, defined by an application.`, fields };
  schemas.add(definition);
  return { name: display, plural, schemaId: userId, fields, newSchemas: [definition], builtin: false };
}
