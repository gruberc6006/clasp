import { ClaspError, Emitter, deepClone, hasErrors, issue, type ClaspIssue, type JsonObject, type JsonValue } from "@clasp/core";

export type FieldType = "string" | "number" | "boolean" | "date" | "datetime" | "enum" | "reference" | "list" | "json";

export interface FieldDefinition {
  type: FieldType;
  title?: string;
  description?: string;
  required?: boolean;
  default?: JsonValue;
  /** Allowed values for `enum` fields. */
  values?: string[];
  /** Schema id that `reference` fields point at. The value is a record id. */
  ref?: string;
  /** Element type for `list` fields. */
  items?: FieldType;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface SchemaDefinition {
  /** Stable identifier, e.g. `clasp.task`. */
  id: string;
  version: number;
  title: string;
  description?: string;
  /** Parent schema id; inherited fields are part of this schema too. */
  extends?: string;
  fields: Record<string, FieldDefinition>;
}

export interface SchemaRef {
  id: string;
  version?: number;
}

/** A schema with its inherited fields merged in. */
export interface ResolvedSchema extends SchemaDefinition {
  /** Ids of this schema and every ancestor, nearest first. */
  lineage: string[];
}

/**
 * An explicit translation between two schemas. Field names that happen to
 * match are never assumed to mean the same thing across unrelated schemas —
 * a mapping must say so.
 */
export interface SchemaMapping {
  from: string;
  to: string;
  /** For each target field: the source field to copy, or a constant. */
  fields: Record<string, string | { const: JsonValue }>;
}

export interface CompatibilityReport {
  compatible: boolean;
  /** How compatibility was established. */
  via?: "identical" | "version" | "extends" | "mapping";
  issues: ClaspIssue[];
}

export interface ValidationResult {
  ok: boolean;
  /** The validated data with defaults applied (only meaningful when ok). */
  value: JsonObject;
  issues: ClaspIssue[];
}

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SCHEMA_ID = /^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;
const RESERVED_FIELDS = new Set(["id"]);
const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "date", "datetime", "enum", "reference", "list", "json"];

function checkValue(type: FieldType, field: FieldDefinition, value: JsonValue, path: string): ClaspIssue[] {
  const bad = (message: string): ClaspIssue[] => [issue("INVALID_FIELD", `${path}: ${message}`, { path })];
  switch (type) {
    case "string": {
      if (typeof value !== "string") return bad("expected text");
      if (field.minLength !== undefined && value.trim().length < field.minLength) {
        return bad(field.minLength === 1 ? "must not be empty" : `must be at least ${field.minLength} characters`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) return bad(`must be at most ${field.maxLength} characters`);
      return [];
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("expected a number");
      if (field.min !== undefined && value < field.min) return bad(`must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) return bad(`must be at most ${field.max}`);
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : bad("expected true or false");
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? []
        : bad("expected a date (YYYY-MM-DD)");
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? [] : bad("expected an ISO date-time");
    case "enum":
      return typeof value === "string" && (field.values ?? []).includes(value)
        ? []
        : bad(`expected one of: ${(field.values ?? []).join(", ")}`);
    case "reference":
      return typeof value === "string" && value.length > 0 ? [] : bad("expected a record id");
    case "list": {
      if (!Array.isArray(value)) return bad("expected a list");
      const itemType = field.items ?? "json";
      return value.flatMap((entry, index) => checkValue(itemType, {} as FieldDefinition, entry, `${path}[${index}]`));
    }
    case "json":
      return [];
  }
}

function versionKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/**
 * The shared vocabulary of a workspace: which record types exist, what their
 * fields mean and how they relate. Collections declare a schema; the Universal
 * API validates every write against it.
 */
export class SchemaRegistry {
  private readonly definitions = new Map<string, SchemaDefinition>();
  private readonly latestVersion = new Map<string, number>();
  private readonly mappings = new Map<string, SchemaMapping>();
  private readonly events = new Emitter<{ kind: "schema" | "mapping"; id: string }>();

  /** Registers a schema version. Re-registering an identical definition is a no-op. */
  register(definition: SchemaDefinition): void {
    const problems = this.checkDefinition(definition);
    if (hasErrors(problems)) {
      throw new ClaspError("VALIDATION_FAILED", `Schema "${definition.id}" is invalid: ${problems[0]?.message}`, {
        issues: problems,
      });
    }
    const key = versionKey(definition.id, definition.version);
    const existing = this.definitions.get(key);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(definition)) return;
      throw new ClaspError(
        "CONFLICT",
        `Schema ${definition.id} v${definition.version} is already registered with a different definition. Publish a new version instead.`,
      );
    }
    this.definitions.set(key, deepClone(definition));
    if ((this.latestVersion.get(definition.id) ?? 0) < definition.version) {
      this.latestVersion.set(definition.id, definition.version);
    }
    this.events.emit({ kind: "schema", id: definition.id });
  }

  has(id: string, version?: number): boolean {
    const resolvedVersion = version ?? this.latestVersion.get(id);
    return resolvedVersion !== undefined && this.definitions.has(versionKey(id, resolvedVersion));
  }

  /** Returns the schema (latest version unless one is given) with inherited fields merged in. */
  get(id: string, version?: number): ResolvedSchema | undefined {
    const resolvedVersion = version ?? this.latestVersion.get(id);
    if (resolvedVersion === undefined) return undefined;
    const definition = this.definitions.get(versionKey(id, resolvedVersion));
    if (!definition) return undefined;
    const lineage = [definition.id];
    let fields = { ...definition.fields };
    let parentId = definition.extends;
    while (parentId && !lineage.includes(parentId)) {
      const parent = this.definitions.get(versionKey(parentId, this.latestVersion.get(parentId) ?? -1));
      if (!parent) break;
      lineage.push(parent.id);
      fields = { ...parent.fields, ...fields };
      parentId = parent.extends;
    }
    return { ...deepClone(definition), fields: deepClone(fields), lineage };
  }

  /** Like `get`, but throws NOT_FOUND. */
  require(id: string, version?: number): ResolvedSchema {
    const schema = this.get(id, version);
    if (!schema) {
      throw new ClaspError("NOT_FOUND", `Schema "${id}"${version !== undefined ? ` v${version}` : ""} is not registered.`);
    }
    return schema;
  }

  /** Latest version of every registered schema, sorted by id. */
  list(): ResolvedSchema[] {
    return [...this.latestVersion.keys()].sort().map((id) => this.require(id));
  }

  versions(id: string): number[] {
    return [...this.definitions.values()]
      .filter((definition) => definition.id === id)
      .map((definition) => definition.version)
      .sort((a, b) => a - b);
  }

  /** Raw (unresolved) definitions of every version — used for persistence and packaging. */
  definitionsOf(id: string): SchemaDefinition[] {
    return this.versions(id).map((version) => deepClone(this.definitions.get(versionKey(id, version)) as SchemaDefinition));
  }

  /**
   * Validates record data. With `partial`, only the supplied fields are
   * checked (used for updates); otherwise required fields must be present and
   * defaults are applied.
   */
  validate(ref: SchemaRef, data: unknown, options: { partial?: boolean } = {}): ValidationResult {
    const schema = this.require(ref.id, ref.version);
    const issues: ClaspIssue[] = [];
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, value: {}, issues: [issue("INVALID_RECORD", "Record data must be an object.")] };
    }
    const input = data as Record<string, unknown>;
    const value: JsonObject = {};
    for (const key of Object.keys(input)) {
      if (!schema.fields[key]) {
        issues.push(
          issue("UNKNOWN_FIELD", `"${key}" is not a field of ${schema.id}. Fields: ${Object.keys(schema.fields).join(", ")}.`, {
            path: key,
          }),
        );
      }
    }
    for (const [name, field] of Object.entries(schema.fields)) {
      const supplied = input[name];
      if (supplied === undefined || supplied === null) {
        if (options.partial) {
          if (supplied === null) {
            if (field.required) issues.push(issue("REQUIRED_FIELD", `${name}: is required and cannot be cleared.`, { path: name }));
            else value[name] = null;
          }
          continue;
        }
        if (field.default !== undefined) value[name] = deepClone(field.default);
        else if (field.required) issues.push(issue("REQUIRED_FIELD", `${name}: is required.`, { path: name }));
        continue;
      }
      const found = checkValue(field.type, field, supplied as JsonValue, name);
      if (found.length > 0) issues.push(...found);
      else value[name] = deepClone(supplied as JsonValue);
    }
    return { ok: !hasErrors(issues), value, issues };
  }

  /**
   * Can data stored as `provider` be read by something written against `consumer`?
   * True when they are the same schema, when the provider is a newer version
   * that still has every field the consumer knows, when the provider extends
   * the consumer, or when an explicit mapping exists.
   */
  checkCompatibility(provider: SchemaRef, consumer: SchemaRef): CompatibilityReport {
    const have = this.get(provider.id, provider.version);
    const want = this.get(consumer.id, consumer.version);
    if (!have) return { compatible: false, issues: [issue("UNKNOWN_SCHEMA", `Schema "${provider.id}" is not registered.`)] };
    if (!want) return { compatible: false, issues: [issue("UNKNOWN_SCHEMA", `Schema "${consumer.id}" is not registered.`)] };

    if (have.id === want.id || have.lineage.includes(want.id)) {
      const issues: ClaspIssue[] = [];
      for (const [name, field] of Object.entries(want.fields)) {
        const provided = have.fields[name];
        if (!provided) {
          issues.push(issue("MISSING_FIELD", `${have.id} v${have.version} has no field "${name}" expected by ${want.id} v${want.version}.`, { path: name }));
        } else if (provided.type !== field.type) {
          issues.push(issue("FIELD_TYPE_CHANGED", `Field "${name}" is ${provided.type} in ${have.id} v${have.version} but ${field.type} in ${want.id} v${want.version}.`, { path: name }));
        }
      }
      if (issues.length > 0) return { compatible: false, issues };
      const via = have.id !== want.id ? "extends" : have.version === want.version ? "identical" : "version";
      return { compatible: true, via, issues: [] };
    }

    if (this.findMapping(have.id, want.id)) return { compatible: true, via: "mapping", issues: [] };
    return {
      compatible: false,
      issues: [
        issue(
          "UNRELATED_SCHEMAS",
          `${have.id} and ${want.id} are unrelated. Register an explicit mapping to read one as the other.`,
        ),
      ],
    };
  }

  /** Registers an explicit translation from one schema to another. */
  registerMapping(mapping: SchemaMapping): void {
    const from = this.require(mapping.from);
    const to = this.require(mapping.to);
    const issues: ClaspIssue[] = [];
    for (const [target, source] of Object.entries(mapping.fields)) {
      if (!to.fields[target]) issues.push(issue("UNKNOWN_FIELD", `Mapping target "${target}" is not a field of ${to.id}.`));
      if (typeof source === "string" && !from.fields[source]) {
        issues.push(issue("UNKNOWN_FIELD", `Mapping source "${source}" is not a field of ${from.id}.`));
      }
    }
    for (const [name, field] of Object.entries(to.fields)) {
      if (field.required && field.default === undefined && mapping.fields[name] === undefined) {
        issues.push(issue("REQUIRED_FIELD", `Mapping must provide required field "${name}" of ${to.id}.`));
      }
    }
    if (issues.length > 0) {
      throw new ClaspError("VALIDATION_FAILED", `Mapping ${mapping.from} → ${mapping.to} is invalid: ${issues[0]?.message}`, { issues });
    }
    this.mappings.set(`${mapping.from}>${mapping.to}`, deepClone(mapping));
    this.events.emit({ kind: "mapping", id: `${mapping.from}>${mapping.to}` });
  }

  findMapping(from: string, to: string): SchemaMapping | undefined {
    return this.mappings.get(`${from}>${to}`);
  }

  listMappings(): SchemaMapping[] {
    return [...this.mappings.values()].map((mapping) => deepClone(mapping));
  }

  /**
   * Translates field data stored as `from` into the shape of `to`.
   * Throws INCOMPATIBLE when the schemas are unrelated and unmapped.
   */
  mapFields(from: SchemaRef, to: SchemaRef, fields: JsonObject): JsonObject {
    const report = this.checkCompatibility(from, to);
    if (!report.compatible) {
      throw new ClaspError("INCOMPATIBLE", report.issues[0]?.message ?? `${from.id} cannot be read as ${to.id}.`, {
        issues: report.issues,
      });
    }
    const target = this.require(to.id, to.version);
    const result: JsonObject = {};
    if (report.via === "mapping") {
      const mapping = this.findMapping(from.id, to.id) as SchemaMapping;
      for (const [name, field] of Object.entries(target.fields)) {
        const rule = mapping.fields[name];
        if (rule === undefined) {
          if (field.default !== undefined) result[name] = deepClone(field.default);
        } else if (typeof rule === "string") {
          const value = fields[rule];
          if (value !== undefined) result[name] = deepClone(value);
        } else {
          result[name] = deepClone(rule.const);
        }
      }
      return result;
    }
    for (const name of Object.keys(target.fields)) {
      const value = fields[name];
      if (value !== undefined) result[name] = deepClone(value);
    }
    return result;
  }

  onChange(listener: (event: { kind: "schema" | "mapping"; id: string }) => void): () => void {
    return this.events.subscribe(listener);
  }

  private checkDefinition(definition: SchemaDefinition): ClaspIssue[] {
    const issues: ClaspIssue[] = [];
    if (!SCHEMA_ID.test(definition.id)) {
      issues.push(issue("INVALID_SCHEMA", `Schema id "${definition.id}" must be namespaced, e.g. "clasp.task" or "acme.invoice".`));
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      issues.push(issue("INVALID_SCHEMA", "Schema version must be a positive integer."));
    }
    if (!definition.title?.trim()) issues.push(issue("INVALID_SCHEMA", "Schema needs a title."));
    if (definition.extends !== undefined && !this.latestVersion.has(definition.extends)) {
      issues.push(issue("UNKNOWN_SCHEMA", `Parent schema "${definition.extends}" is not registered.`));
    }
    for (const [name, field] of Object.entries(definition.fields ?? {})) {
      const at = { path: name };
      if (!FIELD_NAME.test(name) || RESERVED_FIELDS.has(name)) {
        issues.push(issue("INVALID_FIELD", `"${name}" is not a valid field name.`, at));
      }
      if (!FIELD_TYPES.includes(field.type)) issues.push(issue("INVALID_FIELD", `Field "${name}" has unknown type "${String(field.type)}".`, at));
      if (field.type === "enum" && !(field.values && field.values.length > 0)) {
        issues.push(issue("INVALID_FIELD", `Enum field "${name}" must list its values.`, at));
      }
      if (field.type === "reference" && !field.ref) {
        issues.push(issue("INVALID_FIELD", `Reference field "${name}" must name the schema it refers to.`, at));
      }
      if (field.default !== undefined && FIELD_TYPES.includes(field.type)) {
        for (const found of checkValue(field.type, field, field.default, name)) {
          issues.push(issue("INVALID_FIELD", `Default of ${found.message}`, at));
        }
      }
    }
    return issues;
  }
}
