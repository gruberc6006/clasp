import type { ActionSpec, ClaspError, ClaspObject, EventSpec, JsonObject, JsonValue, PortSpec } from "@clasp/core";
import type { Capability } from "@clasp/permissions";
import type { ClaspAPI, Exposure, ResourceDescriptor } from "@clasp/universal-api";

export type ComponentCategory = "interface" | "data" | "logic" | "workflow" | "composition" | "network" | "game";

export const COMPONENT_CATEGORIES: readonly ComponentCategory[] = ["interface", "data", "logic", "workflow", "network", "game", "composition"];

export type PropertyType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "list"
  | "object"
  | "json"
  /** A schema id from the schema registry. */
  | "schema"
  /** A field name of some schema. */
  | "field"
  /** The id of a workspace resource (collection, application, service). */
  | "resource";

/** One configurable property. Together these are a component's configuration schema. */
export interface PropertySpec {
  name: string;
  type: PropertyType;
  title?: string;
  description?: string;
  default?: JsonValue;
  required?: boolean;
  /** Allowed values, for `enum`. */
  options?: string[];
}

export interface PortSet {
  inputs: PortSpec[];
  outputs: PortSpec[];
  events: EventSpec[];
  actions: ActionSpec[];
}

/** A resource an object contributes to the workspace, derived purely from its definition. */
export interface ResourceDeclaration {
  id: string;
  kind: "collection";
  name: string;
  description?: string;
  exposure: Exposure;
  schema: { id: string; version?: number };
}

/** A capability one specific object needs on one specific resource. */
export interface CapabilityRequirement {
  objectId: string;
  capability: Capability;
  resource: string;
  actions?: string[];
  reason: string;
}

/** What components may ask about the world outside their graph when describing themselves. */
export interface ComponentEnvironment {
  resolveResource(id: string): ResourceDescriptor | undefined;
}

/**
 * The machine-readable definition of a component type plus its deterministic
 * implementation. Only registered definitions ever execute; graphs can
 * configure and connect them but can never supply code.
 */
export interface ComponentDefinition extends PortSet {
  /** Unique type id, e.g. `ui.button`. */
  type: string;
  version: number;
  category: ComponentCategory;
  title: string;
  description: string;
  properties: PropertySpec[];
  /** Whether objects of this type may contain children. */
  container?: boolean;
  /** Capabilities objects of this type may need, described for people and for the AI. */
  capabilities?: Array<{ capability: Capability; description: string }>;
  /** Names of properties holding ids of resources outside the object (kept as-is when a package is imported). */
  references?: string[];
  /** Ports that depend on configuration or environment; replaces the static lists when present. */
  ports?(object: Pick<ClaspObject, "properties">, environment: ComponentEnvironment): PortSet & { unresolved?: boolean };
  /** Resources this object declares. */
  resources?(object: ClaspObject): ResourceDeclaration[];
  /** Resource-scoped capabilities this object needs at run time. */
  requirements?(object: ClaspObject): Array<Omit<CapabilityRequirement, "objectId">>;
  /** Creates the running instance. Must be deterministic and side-effect free outside `ctx`. */
  create(ctx: ComponentContext): ComponentInstance | void;
}

/** JSON-serializable description of a component (everything except the implementation). */
export type ComponentDescription = Omit<ComponentDefinition, "create" | "ports" | "resources" | "requirements"> & {
  container: boolean;
  dynamicPorts: boolean;
};

export type ActionHandler = (payload: JsonValue | undefined) => void;

export interface ComponentInstance {
  /** Called once after every object in the graph exists and initial inputs were delivered. */
  start?(): void;
  /** Called when the effective value of an input changes. */
  onInput?(port: string, value: JsonValue | undefined): void;
  /** Handlers for the declared actions. */
  actions?: Record<string, ActionHandler>;
  /** Handlers for user gestures, called by the renderer only (never connectable). */
  interactions?: Record<string, ActionHandler>;
  dispose?(): void;
}

/** Everything a running component may touch. There is no other way out. */
export interface ComponentContext {
  /** The object's current definition. */
  readonly object: ClaspObject;
  /** Properties with the component's defaults applied. */
  readonly props: JsonObject;
  /** The Universal API, bound to the application this object belongs to. */
  readonly clasp: ClaspAPI;
  /** False once the object has been disposed; async work should stop. */
  readonly alive: boolean;
  /** Effective input: the connected value, else the same-named property, else undefined. */
  input(port: string): JsonValue | undefined;
  /** True when a connection feeds this input. */
  isConnected(port: string): boolean;
  /** This object's own current output. */
  output(port: string): JsonValue | undefined;
  setOutput(port: string, value: JsonValue | undefined): void;
  emit(event: string, payload?: JsonValue): void;
  /** Per-object runtime state. Survives reconfiguration; never persisted. */
  getState<T extends JsonValue>(key: string): T | undefined;
  setState(key: string, value: JsonValue | undefined): void;
  /** Objects nested inside this one, depth first. */
  descendants(): ClaspObject[];
  /** Reads an output of a descendant (containers aggregating their children). */
  peek(objectId: string, port: string): JsonValue | undefined;
  /** Triggers an action of a descendant, if it has one. */
  call(objectId: string, action: string, payload?: JsonValue): void;
  /** Changes this object's own properties through an ordinary graph transaction. */
  configure(patch: JsonObject): void;
  /**
   * Runs async work; failures are reported as diagnostics (or to `onError`).
   * Mark work that waits on a person (e.g. an access request) as `background`
   * so the application still counts as idle while it waits.
   */
  run(task: () => Promise<void>, onError?: (error: ClaspError) => void, options?: { background?: boolean }): void;
  /** Reports a failure without throwing. */
  fail(error: unknown): void;
  setInterval(callback: () => void, ms: number): () => void;
}
