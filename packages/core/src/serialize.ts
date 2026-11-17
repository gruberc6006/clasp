import { z } from "zod";
import { ClaspError, issue, validationError } from "./errors";
import { isJsonValue, stableStringify } from "./json";
import { GRAPH_FORMAT_VERSION, type ClaspGraph } from "./types";

const portRef = z.object({ objectId: z.string().min(1), port: z.string().min(1) });
const json = z.custom<unknown>((value) => isJsonValue(value), { message: "must be plain JSON" });

const objectSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  typeVersion: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  properties: z.record(z.string(), json),
  parentId: z.string().min(1).optional(),
  order: z.number(),
  ownerId: z.string().optional(),
  metadata: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

const connectionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["value", "event"]),
  source: portRef,
  target: portRef,
});

const named = { name: z.string().min(1), description: z.string().optional() };

const interfaceSchema = z.object({
  actions: z.array(z.object({ ...named, target: portRef })),
  events: z.array(z.object({ ...named, source: portRef })),
  outputs: z.array(z.object({ ...named, source: portRef })),
  inputs: z.array(z.object({ ...named, target: portRef })),
  views: z.array(z.object({ ...named, root: z.string().min(1) })),
});

/** Structural schema of a serialized graph. Semantic checks live in `validateGraph`. */
export const graphSchema = z.object({
  id: z.string().min(1),
  formatVersion: z.literal(GRAPH_FORMAT_VERSION),
  version: z.number().int().nonnegative(),
  objects: z.record(z.string(), objectSchema),
  connections: z.record(z.string(), connectionSchema),
  interface: interfaceSchema,
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    origin: z
      .object({
        appId: z.string(),
        packageId: z.string().optional(),
        version: z.number(),
        name: z.string().optional(),
      })
      .optional(),
  }),
});

/** Canonical JSON for a graph: stable key order, safe to diff and hash. */
export function serializeGraph(graph: ClaspGraph, space?: number): string {
  return stableStringify(graph, space);
}

/**
 * Parses untrusted input into a structurally valid graph.
 * Throws VALIDATION_FAILED with one issue per structural problem.
 */
export function parseGraph(input: unknown): ClaspGraph {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new ClaspError("VALIDATION_FAILED", "Graph is not valid JSON.", { cause });
    }
  }
  const candidate = value as { formatVersion?: unknown } | null;
  if (candidate && typeof candidate === "object" && typeof candidate.formatVersion === "number") {
    if (candidate.formatVersion > GRAPH_FORMAT_VERSION) {
      throw new ClaspError(
        "INCOMPATIBLE",
        `Graph uses format version ${candidate.formatVersion}; this build of Clasp understands up to ${GRAPH_FORMAT_VERSION}.`,
      );
    }
  }
  const parsed = graphSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(
      "Graph is malformed",
      parsed.error.issues.map((entry) =>
        issue("MALFORMED_GRAPH", `${entry.path.join(".") || "graph"}: ${entry.message}`, { path: entry.path.join(".") }),
      ),
    );
  }
  return parsed.data as ClaspGraph;
}
