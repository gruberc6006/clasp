import {
  ClaspError,
  createId,
  deepClone,
  graphSchema,
  hasErrors,
  issue,
  nowIso,
  parseGraph,
  stableStringify,
  validateGraph,
  validationError,
  type ClaspGraph,
  type ClaspIssue,
  type ClaspObject,
  type GraphInterface,
  type GraphOrigin,
  type JsonObject,
  type PortRef,
} from "@clasp/core";
import type { ComponentRegistry } from "@clasp/runtime";
import { BUILTIN_SCHEMA_IDS, type SchemaDefinition, type SchemaRegistry } from "@clasp/schemas";
import { z } from "zod";

export const PACKAGE_FORMAT = "clasp.package";
export const PACKAGE_FORMAT_VERSION = 1;
/** Universal API contract version packages are written against. */
export const PACKAGE_API_VERSION = 1;
export const PACKAGE_FILE_EXTENSION = ".clasp.json";

/** A capability the application will ask for once installed. Informational: importing grants nothing. */
export interface PackageCapability {
  capability: string;
  /** Resource id as known in the exporting workspace. */
  resource: string;
  resourceName?: string;
  resourceKind?: string;
  schema?: string;
  actions?: string[];
  reason: string;
}

export interface PackageAsset {
  mimeType: string;
  /** Base64-encoded content. */
  data: string;
}

/**
 * A portable application: its definition and what it depends on.
 *
 * A package never contains records, grants or credentials — it is built from
 * the graph alone, so there is nothing private to leak by default.
 */
export interface ClaspPackage {
  format: typeof PACKAGE_FORMAT;
  formatVersion: typeof PACKAGE_FORMAT_VERSION;
  /** Identity of this export. */
  id: string;
  app: {
    /** Identity of the application in the workspace it was exported from. */
    id: string;
    name: string;
    description?: string;
    /** Definition revision at export time. */
    version: number;
    /** Where the exported application itself came from, if it was a fork or import. */
    origin?: GraphOrigin;
  };
  graph: ClaspGraph;
  requires: {
    api: number;
    components: Array<{ type: string; version: number }>;
    schemas: Array<{ id: string; version: number }>;
    capabilities: PackageCapability[];
  };
  /** Definitions of the non-built-in schemas the application uses. */
  schemas: SchemaDefinition[];
  /** Canvas layout, so the graph looks the same when opened in Build mode. */
  presentation?: { nodes: Record<string, { x: number; y: number }> };
  assets: Record<string, PackageAsset>;
  metadata: {
    exportedAt: string;
    exportedBy: string;
    /** Integrity check of the graph (detects accidental corruption; not a signature). */
    checksum: string;
  };
}

export interface ExportEnvironment {
  registry: ComponentRegistry;
  schemas: SchemaRegistry;
  /** Looks up a resource to describe required capabilities in human terms. */
  describeResource?: (id: string) => { name: string; kind: string; schema?: string } | undefined;
  presentation?: { nodes: Record<string, { x: number; y: number }> };
  assets?: Record<string, PackageAsset>;
  exportedBy?: string;
}

export interface ImportEnvironment {
  registry: ComponentRegistry;
  schemas: SchemaRegistry;
}

export interface DependencyReport {
  ok: boolean;
  issues: ClaspIssue[];
  missingComponents: string[];
  outdatedComponents: Array<{ type: string; required: number; available: number }>;
  missingSchemas: string[];
}

export interface ImportResult {
  /** The application under a brand-new identity. Install it to run it. */
  graph: ClaspGraph;
  presentation?: { nodes: Record<string, { x: number; y: number }> };
  /** Old id → new id, for every object. */
  idMap: Record<string, string>;
  /** Capabilities the application will need; none are granted by importing. */
  requiredCapabilities: PackageCapability[];
  /** References to resources that live outside the package and may not exist here. */
  externalReferences: Array<{ objectId: string; property: string; resource: string }>;
  registeredSchemas: string[];
  warnings: ClaspIssue[];
}

/** Small, fast, non-cryptographic hash (cyrb53) used as an integrity check. */
export function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function schemaIdsOf(graph: ClaspGraph, registry: ComponentRegistry): string[] {
  const ids = new Set<string>();
  for (const object of Object.values(graph.objects)) {
    for (const spec of registry.get(object.type)?.properties ?? []) {
      const value = object.properties[spec.name];
      if (spec.type === "schema" && typeof value === "string" && value) ids.add(value);
    }
  }
  return [...ids].sort();
}

/** Builds a portable package from an application's definition. */
export function exportPackage(graph: ClaspGraph, environment: ExportEnvironment): ClaspPackage {
  const { registry, schemas } = environment;
  const issues = validateGraph(graph, registry);
  if (hasErrors(issues)) throw validationError(`"${graph.metadata.name}" cannot be exported`, issues);

  const types = [...new Set(Object.values(graph.objects).map((object) => object.type))].sort();
  const components = types.map((type) => ({ type, version: registry.get(type)?.version ?? 1 }));

  const required: Array<{ id: string; version: number }> = [];
  const bundled: SchemaDefinition[] = [];
  const seen = new Set<string>();
  const include = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const schema = schemas.get(id);
    if (!schema) return; // reported by checkDependencies on the importing side
    if (schema.extends) include(schema.extends);
    required.push({ id: schema.id, version: schema.version });
    if (!BUILTIN_SCHEMA_IDS.includes(schema.id)) bundled.push(...schemas.definitionsOf(schema.id));
  };
  for (const id of schemaIdsOf(graph, registry)) include(id);

  const capabilities: PackageCapability[] = [];
  for (const object of Object.values(graph.objects)) {
    for (const requirement of registry.get(object.type)?.requirements?.(object) ?? []) {
      const described = environment.describeResource?.(requirement.resource);
      capabilities.push({
        capability: requirement.capability,
        resource: requirement.resource,
        ...(described ? { resourceName: described.name, resourceKind: described.kind } : {}),
        ...(described?.schema ? { schema: described.schema } : {}),
        ...(requirement.actions ? { actions: [...requirement.actions] } : {}),
        reason: requirement.reason,
      });
    }
  }

  const copy = deepClone(graph);
  return {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    id: createId("pkg"),
    app: {
      id: graph.id,
      name: graph.metadata.name,
      ...(graph.metadata.description ? { description: graph.metadata.description } : {}),
      version: graph.version,
      ...(graph.metadata.origin ? { origin: deepClone(graph.metadata.origin) } : {}),
    },
    graph: copy,
    requires: { api: PACKAGE_API_VERSION, components, schemas: required, capabilities },
    schemas: bundled,
    ...(environment.presentation ? { presentation: deepClone(environment.presentation) } : {}),
    assets: deepClone(environment.assets ?? {}),
    metadata: {
      exportedAt: nowIso(),
      exportedBy: environment.exportedBy ?? "Clasp",
      checksum: checksum(stableStringify(copy)),
    },
  };
}

const point = z.object({ x: z.number(), y: z.number() });

const packageSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
  id: z.string().min(1),
  app: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.number().int().nonnegative(),
    origin: z.object({ appId: z.string(), packageId: z.string().optional(), version: z.number(), name: z.string().optional() }).optional(),
  }),
  graph: graphSchema,
  requires: z.object({
    api: z.number().int().positive(),
    components: z.array(z.object({ type: z.string().min(1), version: z.number().int().positive() })),
    schemas: z.array(z.object({ id: z.string().min(1), version: z.number().int().positive() })),
    capabilities: z.array(
      z.object({
        capability: z.string().min(1),
        resource: z.string().min(1),
        resourceName: z.string().optional(),
        resourceKind: z.string().optional(),
        schema: z.string().optional(),
        actions: z.array(z.string()).optional(),
        reason: z.string(),
      }),
    ),
  }),
  schemas: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      title: z.string(),
      description: z.string().optional(),
      extends: z.string().optional(),
      fields: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
  ),
  presentation: z.object({ nodes: z.record(z.string(), point) }).optional(),
  assets: z.record(z.string(), z.object({ mimeType: z.string(), data: z.string() })),
  metadata: z.object({ exportedAt: z.string(), exportedBy: z.string(), checksum: z.string() }),
});

/**
 * Parses and structurally validates an untrusted package.
 * Throws VALIDATION_FAILED (malformed or corrupted) or INCOMPATIBLE (newer format).
 */
export function validatePackage(input: unknown): ClaspPackage {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new ClaspError("VALIDATION_FAILED", "This file is not valid JSON, so it cannot be a Clasp package.", { cause });
    }
  }
  const header = value as { format?: unknown; formatVersion?: unknown } | null;
  if (!header || typeof header !== "object" || header.format !== PACKAGE_FORMAT) {
    throw new ClaspError("VALIDATION_FAILED", "This file is not a Clasp package.");
  }
  if (typeof header.formatVersion === "number" && header.formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new ClaspError(
      "INCOMPATIBLE",
      `This package uses format version ${header.formatVersion}; this build of Clasp understands up to ${PACKAGE_FORMAT_VERSION}.`,
    );
  }
  const parsed = packageSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(
      "The package is malformed",
      parsed.error.issues.map((entry) =>
        issue("MALFORMED_PACKAGE", `${entry.path.join(".") || "package"}: ${entry.message}`, { path: entry.path.join(".") }),
      ),
    );
  }
  const pkg = parsed.data as unknown as ClaspPackage;
  pkg.graph = parseGraph(pkg.graph);
  if (checksum(stableStringify(pkg.graph)) !== pkg.metadata.checksum) {
    throw new ClaspError("VALIDATION_FAILED", "The package's contents do not match its checksum; it was modified or corrupted after export.");
  }
  if (pkg.requires.api > PACKAGE_API_VERSION) {
    throw new ClaspError("INCOMPATIBLE", `This package needs Universal API v${pkg.requires.api}; this workspace provides v${PACKAGE_API_VERSION}.`);
  }
  return pkg;
}

/** Checks whether this workspace has the components and schemas a package needs. */
export function checkDependencies(pkg: ClaspPackage, environment: ImportEnvironment): DependencyReport {
  const issues: ClaspIssue[] = [];
  const missingComponents: string[] = [];
  const outdatedComponents: DependencyReport["outdatedComponents"] = [];
  const missingSchemas: string[] = [];

  for (const component of pkg.requires.components) {
    const available = environment.registry.get(component.type);
    if (!available) {
      missingComponents.push(component.type);
      issues.push(issue("MISSING_COMPONENT", `Component "${component.type}" is not available in this workspace.`));
    } else if (available.version < component.version) {
      outdatedComponents.push({ type: component.type, required: component.version, available: available.version });
      issues.push(
        issue("OUTDATED_COMPONENT", `The package needs ${component.type} v${component.version}; this workspace has v${available.version}.`),
      );
    }
  }
  // Every type used by the graph must be declared, so a tampered `requires` cannot hide a dependency.
  const declared = new Set(pkg.requires.components.map((component) => component.type));
  for (const object of Object.values(pkg.graph.objects)) {
    if (!declared.has(object.type) && !environment.registry.has(object.type) && !missingComponents.includes(object.type)) {
      missingComponents.push(object.type);
      issues.push(issue("MISSING_COMPONENT", `Component "${object.type}" is used but not available in this workspace.`));
    }
  }

  const bundled = new Set(pkg.schemas.map((schema) => schema.id));
  for (const schema of pkg.requires.schemas) {
    if (bundled.has(schema.id)) continue;
    if (!environment.schemas.has(schema.id)) {
      missingSchemas.push(schema.id);
      issues.push(issue("MISSING_SCHEMA", `Schema "${schema.id}" is not registered here and is not bundled with the package.`));
    } else if (!environment.schemas.has(schema.id, schema.version) && environment.schemas.require(schema.id).version < schema.version) {
      issues.push(
        issue("OUTDATED_SCHEMA", `The package needs ${schema.id} v${schema.version}; this workspace has v${environment.schemas.require(schema.id).version}.`),
      );
    }
  }
  return { ok: !hasErrors(issues), issues, missingComponents, outdatedComponents, missingSchemas };
}

function remapRef(ref: PortRef, ids: Map<string, string>): PortRef {
  return { objectId: ids.get(ref.objectId) ?? ref.objectId, port: ref.port };
}

/**
 * Turns a package into a new, independent application definition.
 *
 * Every object, every connection and the application itself receive fresh
 * identities, so the result shares nothing with the original: no grants
 * (grants name the original's id), no records (collections are keyed by the
 * new object ids) and no runtime state. References to resources outside the
 * package are kept verbatim; they resolve — and need permission — in the
 * importing workspace like any other reference.
 */
export function importPackage(input: unknown, environment: ImportEnvironment, options: { name?: string } = {}): ImportResult {
  const pkg = validatePackage(input);
  const dependencies = checkDependencies(pkg, environment);
  if (!dependencies.ok) {
    throw new ClaspError("INCOMPATIBLE", `"${pkg.app.name}" cannot run here: ${dependencies.issues[0]?.message}`, {
      issues: dependencies.issues,
    });
  }

  const registeredSchemas: string[] = [];
  const order = [...pkg.schemas].sort((a, b) => Number(Boolean(a.extends)) - Number(Boolean(b.extends)) || a.version - b.version);
  for (const schema of order) {
    if (environment.schemas.has(schema.id, schema.version)) {
      const existing = environment.schemas.definitionsOf(schema.id).find((definition) => definition.version === schema.version);
      if (stableStringify(existing) !== stableStringify(schema)) {
        throw new ClaspError(
          "CONFLICT",
          `The package bundles ${schema.id} v${schema.version}, but this workspace already has a different definition of it.`,
        );
      }
      continue;
    }
    environment.schemas.register(schema);
    registeredSchemas.push(`${schema.id}@${schema.version}`);
  }

  const source = pkg.graph;
  const ids = new Map<string, string>();
  for (const id of Object.keys(source.objects)) ids.set(id, createId("obj"));
  const appId = createId("app");
  const now = nowIso();
  const externalReferences: ImportResult["externalReferences"] = [];

  const objects: Record<string, ClaspObject> = {};
  for (const object of Object.values(source.objects)) {
    const id = ids.get(object.id) as string;
    const properties: JsonObject = deepClone(object.properties);
    for (const name of environment.registry.get(object.type)?.references ?? []) {
      const value = properties[name];
      if (typeof value !== "string" || !value) continue;
      if (ids.has(value)) properties[name] = ids.get(value) as string;
      else if (value === source.id) properties[name] = appId;
      else externalReferences.push({ objectId: id, property: name, resource: value });
    }
    const { parentId: _parent, ownerId: _owner, ...rest } = object;
    objects[id] = {
      ...rest,
      id,
      version: 1,
      properties,
      ...(object.parentId !== undefined ? { parentId: ids.get(object.parentId) ?? object.parentId } : {}),
      metadata: { ...object.metadata, createdAt: now, updatedAt: now },
    };
  }

  const connections: ClaspGraph["connections"] = {};
  for (const connection of Object.values(source.connections)) {
    const id = createId("con");
    connections[id] = { id, kind: connection.kind, source: remapRef(connection.source, ids), target: remapRef(connection.target, ids) };
  }

  const face: GraphInterface = {
    actions: source.interface.actions.map((entry) => ({ ...entry, target: remapRef(entry.target, ids) })),
    events: source.interface.events.map((entry) => ({ ...entry, source: remapRef(entry.source, ids) })),
    outputs: source.interface.outputs.map((entry) => ({ ...entry, source: remapRef(entry.source, ids) })),
    inputs: source.interface.inputs.map((entry) => ({ ...entry, target: remapRef(entry.target, ids) })),
    views: source.interface.views.map((entry) => ({ ...entry, root: ids.get(entry.root) ?? entry.root })),
  };

  const graph: ClaspGraph = {
    id: appId,
    formatVersion: source.formatVersion,
    version: 1,
    objects,
    connections,
    interface: face,
    metadata: {
      name: options.name ?? pkg.app.name,
      ...(pkg.app.description ? { description: pkg.app.description } : {}),
      createdAt: now,
      updatedAt: now,
      origin: { appId: pkg.app.id, packageId: pkg.id, version: pkg.app.version, name: pkg.app.name },
    },
  };

  const issues = validateGraph(graph, environment.registry);
  if (hasErrors(issues)) throw validationError(`"${pkg.app.name}" is not a valid application`, issues);

  const presentation = pkg.presentation
    ? {
        nodes: Object.fromEntries(
          Object.entries(pkg.presentation.nodes)
            .filter(([id]) => ids.has(id))
            .map(([id, position]) => [ids.get(id) as string, position]),
        ),
      }
    : undefined;

  return {
    graph,
    ...(presentation ? { presentation } : {}),
    idMap: Object.fromEntries(ids),
    requiredCapabilities: deepClone(pkg.requires.capabilities),
    externalReferences,
    registeredSchemas,
    warnings: issues.filter((entry) => entry.severity === "warning"),
  };
}

/** Copies an application into a new, independent one that remembers where it came from. */
export function forkGraph(
  graph: ClaspGraph,
  environment: ExportEnvironment & ImportEnvironment,
  options: { name?: string } = {},
): ImportResult {
  const pkg = exportPackage(graph, environment);
  return importPackage(pkg, environment, { name: options.name ?? `${graph.metadata.name} (fork)` });
}

/** Serializes a package for saving to a file. */
export function serializePackage(pkg: ClaspPackage): string {
  return JSON.stringify(pkg, null, 2);
}

/** A filesystem-friendly file name for a package. */
export function packageFileName(pkg: ClaspPackage): string {
  const slug = pkg.app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  return `${slug}${PACKAGE_FILE_EXTENSION}`;
}
