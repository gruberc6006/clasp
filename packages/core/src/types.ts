import type { ClaspIssue } from "./errors";
import type { JsonObject, JsonValue } from "./json";

/**
 * The universal object model.
 *
 * A `ClaspGraph` is a pure *definition*: it says which objects exist, how they
 * are configured, how they nest and how their ports are wired. It deliberately
 * contains none of the following, each of which lives in its own layer:
 *
 *  - runtime state      → `@clasp/runtime` (port values, component state)
 *  - application data   → `@clasp/universal-api` DataStore (records)
 *  - presentation state → `@clasp/persistence` presentation store (canvas layout)
 *  - permissions        → `@clasp/permissions` (grants)
 *  - history            → `GraphStore` undo stack + persisted revisions
 */

/** The value types that may flow through a port. */
export type ValueType = "any" | "string" | "number" | "boolean" | "record" | "records" | "list" | "object";

export const VALUE_TYPES: readonly ValueType[] = [
  "any",
  "string",
  "number",
  "boolean",
  "record",
  "records",
  "list",
  "object",
];

/** A value port. Inputs receive values, outputs publish them. */
export interface PortSpec {
  name: string;
  type: ValueType;
  description?: string;
  /** Schema id carried by `record` / `records` ports, when known. */
  schema?: string;
}

/** An event an object can emit. Events connect to actions. */
export interface EventSpec {
  name: string;
  description?: string;
  payload?: ValueType;
}

/** An action an object can perform when an event (or an API call) triggers it. */
export interface ActionSpec {
  name: string;
  description?: string;
  payload?: ValueType;
}

/** What the graph engine needs to know about an object type to validate it. */
export interface ObjectTypeInfo {
  type: string;
  version: number;
  inputs: PortSpec[];
  outputs: PortSpec[];
  events: EventSpec[];
  actions: ActionSpec[];
  /** Whether objects of this type may contain child objects. */
  container: boolean;
  /**
   * True when ports depend on something outside the graph that could not be
   * resolved (e.g. an embedded application that is not installed). Unknown
   * ports are then reported as warnings instead of errors.
   */
  unresolved?: boolean;
  validateProperties?(properties: JsonObject): ClaspIssue[];
}

/**
 * Source of type information. `@clasp/runtime`'s ComponentRegistry implements
 * this; core never depends on concrete components.
 */
export interface TypeCatalog {
  describe(object: Pick<ClaspObject, "type" | "typeVersion" | "properties">): ObjectTypeInfo | undefined;
}

export interface ObjectMetadata {
  name?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaspObject {
  /** Globally unique identity. Never reused. */
  id: string;
  /** Registered component type, e.g. `ui.button`. */
  type: string;
  /** Version of the component definition this object was authored against. */
  typeVersion: number;
  /** Revision of this object; incremented by every update. */
  version: number;
  /** Configuration only. Runtime state never lives here. */
  properties: JsonObject;
  /** Containing object (nested composition). Absent for root objects. */
  parentId?: string;
  /** Position among siblings (ascending). */
  order: number;
  ownerId?: string;
  metadata: ObjectMetadata;
}

export interface PortRef {
  objectId: string;
  port: string;
}

/** `value` connections carry data output → input; `event` connections trigger event → action. */
export type ConnectionKind = "value" | "event";

export interface ClaspConnection {
  id: string;
  kind: ConnectionKind;
  source: PortRef;
  target: PortRef;
}

/**
 * The public face of an application. Other applications can only reach what
 * is declared here, and only through the Universal API.
 */
export interface GraphInterface {
  /** Externally invocable actions, each bound to one internal action port. */
  actions: Array<{ name: string; description?: string; target: PortRef }>;
  /** Externally observable events, each bound to one internal event port. */
  events: Array<{ name: string; description?: string; source: PortRef }>;
  /** Externally readable values, each bound to one internal output port. */
  outputs: Array<{ name: string; description?: string; source: PortRef }>;
  /** Externally writable values, each bound to one internal input port. */
  inputs: Array<{ name: string; description?: string; target: PortRef }>;
  /** Embeddable interface subtrees, each rooted at one internal object. */
  views: Array<{ name: string; description?: string; root: string }>;
}

export interface GraphOrigin {
  /** Application this graph was forked or imported from. */
  appId: string;
  packageId?: string;
  version: number;
  name?: string;
}

export interface GraphMetadata {
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  origin?: GraphOrigin;
}

export const GRAPH_FORMAT_VERSION = 1;

export interface ClaspGraph {
  /** Application identity. */
  id: string;
  formatVersion: typeof GRAPH_FORMAT_VERSION;
  /** Revision counter; incremented by every committed transaction. */
  version: number;
  objects: Record<string, ClaspObject>;
  connections: Record<string, ClaspConnection>;
  interface: GraphInterface;
  metadata: GraphMetadata;
}

export function emptyInterface(): GraphInterface {
  return { actions: [], events: [], outputs: [], inputs: [], views: [] };
}

/** Whether a value produced as `from` may be delivered to a port expecting `to`. */
export function isAssignable(from: ValueType | undefined, to: ValueType | undefined): boolean {
  if (!from || !to || from === "any" || to === "any" || from === to) return true;
  if (from === "records" && to === "list") return true;
  if (from === "record" && to === "object") return true;
  return false;
}

export type { JsonObject, JsonValue };
