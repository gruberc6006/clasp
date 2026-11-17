import { ClaspError, issue, stableStringify, validationError, type ClaspIssue } from "@clasp/core";
import type { ComponentRegistry } from "@clasp/runtime";
import type { SchemaDefinition, SchemaMapping, SchemaRegistry } from "@clasp/schemas";
import { checkDependencies, validatePackage, type ClaspPackage } from "@clasp/sharing";
import { z } from "zod";

export const EXTENSION_FORMAT = "clasp.extension";
export const EXTENSION_FORMAT_VERSION = 1;

/**
 * What a genuine sandbox for executable extensions must provide before Clasp
 * will run third-party code. None of this exists yet, which is why
 * `installExtension` refuses executable contributions. See docs/extensions.md.
 */
export const SANDBOX_REQUIREMENTS: readonly string[] = [
  "A separate execution context with its own global scope (a Worker in a sandboxed, cross-origin iframe, or a WebAssembly runtime): no access to the host's DOM, storage, cookies or JavaScript objects.",
  "No ambient authority: no network, filesystem, clock-as-side-channel or other host API unless the user granted the matching capability to that extension.",
  "The only channel to the workspace is a message-passing bridge to the Universal API, bound by the host to the extension's own identity and authorized by the kernel on every call.",
  "Only structured-clonable JSON crosses the boundary; functions, object references and shared memory do not.",
  "Enforced CPU and memory budgets, with the host able to terminate a context that exceeds them.",
  "A declared, user-approved capability manifest; anything not declared is denied.",
];

export interface ExtensionTemplate {
  id: string;
  name: string;
  description?: string;
  /** A regular Clasp package; importing it is how the template is instantiated. */
  package: ClaspPackage;
}

/**
 * A declarative extension pack: data only, no code. It can teach a workspace
 * new record schemas, mappings between schemas, and application templates
 * built from components the workspace already has.
 */
export interface ExtensionManifest {
  format: typeof EXTENSION_FORMAT;
  formatVersion: typeof EXTENSION_FORMAT_VERSION;
  /** Namespaced identifier, e.g. `acme.crm`. Contributed schemas must live under it. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  contributes: {
    schemas?: SchemaDefinition[];
    mappings?: SchemaMapping[];
    templates?: ExtensionTemplate[];
  };
}

export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  /** Schema versions this installation added (already-present identical ones are not repeated). */
  schemas: string[];
  mappings: string[];
  templates: ExtensionTemplate[];
}

const EXECUTABLE_KEYS = ["components", "code", "scripts", "main", "entry", "wasm", "executable"];

const manifestSchema = z.object({
  format: z.literal(EXTENSION_FORMAT),
  formatVersion: z.literal(EXTENSION_FORMAT_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, "must be namespaced, e.g. acme.crm"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must look like 1.0.0"),
  description: z.string().optional(),
  author: z.string().optional(),
  contributes: z.object({
    schemas: z.array(z.record(z.string(), z.unknown())).optional(),
    mappings: z.array(z.object({ from: z.string(), to: z.string(), fields: z.record(z.string(), z.unknown()) })).optional(),
    templates: z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional(), package: z.unknown() }))
      .optional(),
  }),
});

/**
 * Parses an untrusted extension manifest. Rejects anything executable with
 * INVALID_OPERATION, and anything malformed with VALIDATION_FAILED.
 */
export function validateExtension(input: unknown): ExtensionManifest {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new ClaspError("VALIDATION_FAILED", "The extension manifest is not valid JSON.", { cause });
    }
  }
  if (!value || typeof value !== "object" || (value as { format?: unknown }).format !== EXTENSION_FORMAT) {
    throw new ClaspError("VALIDATION_FAILED", "This is not a Clasp extension manifest.");
  }
  const raw = value as Record<string, unknown>;
  const contributes = (raw.contributes && typeof raw.contributes === "object" ? raw.contributes : {}) as Record<string, unknown>;
  const executable = EXECUTABLE_KEYS.filter((key) => key in raw || key in contributes);
  if (executable.length > 0) {
    throw new ClaspError(
      "INVALID_OPERATION",
      `This extension wants to contribute executable code (${executable.join(", ")}). Clasp does not run third-party code: this build has no isolation boundary that could contain it. Only declarative extensions (schemas, mappings, templates) can be installed.`,
      { details: { sandboxRequirements: [...SANDBOX_REQUIREMENTS] } },
    );
  }
  if (typeof raw.formatVersion === "number" && raw.formatVersion > EXTENSION_FORMAT_VERSION) {
    throw new ClaspError("INCOMPATIBLE", `This extension uses manifest version ${raw.formatVersion}; this build understands up to ${EXTENSION_FORMAT_VERSION}.`);
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(
      "The extension manifest is malformed",
      parsed.error.issues.map((entry) => issue("MALFORMED_EXTENSION", `${entry.path.join(".") || "manifest"}: ${entry.message}`)),
    );
  }
  const manifest = parsed.data as unknown as ExtensionManifest;
  const issues: ClaspIssue[] = [];
  for (const schema of manifest.contributes.schemas ?? []) {
    if (typeof schema.id !== "string" || !schema.id.startsWith(`${manifest.id}.`)) {
      issues.push(issue("FOREIGN_NAMESPACE", `Schema "${String(schema.id)}" must be named under the extension's own namespace "${manifest.id}.".`));
    }
  }
  if (issues.length > 0) throw validationError("The extension manifest is invalid", issues);
  manifest.contributes.templates = (manifest.contributes.templates ?? []).map((template) => ({
    ...template,
    package: validatePackage(template.package),
  }));
  return manifest;
}

/**
 * Installs a declarative extension into a workspace: registers its schemas
 * and mappings and returns its templates. Everything is checked before
 * anything is registered, so a rejected extension changes nothing.
 */
export function installExtension(input: unknown, environment: { schemas: SchemaRegistry; registry: ComponentRegistry }): InstalledExtension {
  const manifest = validateExtension(input);
  const { schemas, registry } = environment;
  const contributed = manifest.contributes.schemas ?? [];

  const issues: ClaspIssue[] = [];
  for (const schema of contributed) {
    if (!schemas.has(schema.id, schema.version)) continue;
    const existing = schemas.definitionsOf(schema.id).find((definition) => definition.version === schema.version);
    if (stableStringify(existing) !== stableStringify(schema)) {
      issues.push(issue("SCHEMA_CONFLICT", `${schema.id} v${schema.version} is already registered with a different definition.`));
    }
  }
  const bundled = new Set(contributed.map((schema) => schema.id));
  for (const template of manifest.contributes.templates ?? []) {
    const report = checkDependencies(template.package, { registry, schemas });
    for (const found of report.issues) {
      // Schemas this very extension contributes will exist by the time the template is used.
      if (found.code === "MISSING_SCHEMA" && [...bundled].some((id) => found.message.includes(`"${id}"`))) continue;
      issues.push(issue(found.code, `Template "${template.name}": ${found.message}`));
    }
  }
  if (issues.length > 0) throw validationError(`"${manifest.name}" cannot be installed`, issues);

  const added: string[] = [];
  const ordered = [...contributed].sort((a, b) => Number(Boolean(a.extends)) - Number(Boolean(b.extends)) || a.version - b.version);
  for (const schema of ordered) {
    if (schemas.has(schema.id, schema.version)) continue;
    schemas.register(schema);
    added.push(`${schema.id}@${schema.version}`);
  }
  const mappings: string[] = [];
  for (const mapping of manifest.contributes.mappings ?? []) {
    schemas.registerMapping(mapping);
    mappings.push(`${mapping.from}>${mapping.to}`);
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    schemas: added,
    mappings,
    templates: manifest.contributes.templates ?? [],
  };
}
