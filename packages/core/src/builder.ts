import { createId } from "./ids";
import type { JsonObject } from "./json";
import { applyOperations, createGraph, type GraphOperation } from "./operations";
import { emptyInterface, type ClaspGraph, type GraphInterface, type PortRef, type TypeCatalog } from "./types";

/** `"objectId.port"` or an explicit reference. */
export type PortLike = string | PortRef;

export function toPortRef(value: PortLike): PortRef {
  if (typeof value !== "string") return value;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) throw new Error(`Expected "objectId.port", received "${value}".`);
  return { objectId: value.slice(0, dot), port: value.slice(dot + 1) };
}

/**
 * Convenience for authoring graphs in code (examples, templates, tests).
 * It only accumulates ordinary graph operations; `build` applies them through
 * the same validated transaction path as every other change.
 */
export class GraphBuilder {
  private readonly ops: GraphOperation[] = [];
  private readonly face: GraphInterface = emptyInterface();

  constructor(
    private readonly name: string,
    private readonly options: { id?: string; description?: string } = {},
  ) {}

  /** Adds an object and returns its id. */
  add(type: string, config: { id?: string; name?: string; parent?: string; properties?: JsonObject } = {}): string {
    const id = config.id ?? createId("obj");
    this.ops.push({
      op: "create",
      object: {
        id,
        type,
        ...(config.name !== undefined ? { name: config.name } : {}),
        ...(config.parent !== undefined ? { parentId: config.parent } : {}),
        ...(config.properties !== undefined ? { properties: config.properties } : {}),
      },
    });
    return id;
  }

  connect(source: PortLike, target: PortLike): this {
    this.ops.push({ op: "connect", connection: { source: toPortRef(source), target: toPortRef(target) } });
    return this;
  }

  exposeAction(name: string, target: PortLike, description?: string): this {
    this.face.actions.push({ name, target: toPortRef(target), ...(description ? { description } : {}) });
    return this;
  }

  exposeEvent(name: string, source: PortLike, description?: string): this {
    this.face.events.push({ name, source: toPortRef(source), ...(description ? { description } : {}) });
    return this;
  }

  exposeOutput(name: string, source: PortLike, description?: string): this {
    this.face.outputs.push({ name, source: toPortRef(source), ...(description ? { description } : {}) });
    return this;
  }

  exposeInput(name: string, target: PortLike, description?: string): this {
    this.face.inputs.push({ name, target: toPortRef(target), ...(description ? { description } : {}) });
    return this;
  }

  exposeView(name: string, root: string, description?: string): this {
    this.face.views.push({ name, root, ...(description ? { description } : {}) });
    return this;
  }

  operations(): GraphOperation[] {
    const hasInterface = Object.values(this.face).some((entries) => entries.length > 0);
    return hasInterface ? [...this.ops, { op: "setInterface", interface: this.face }] : [...this.ops];
  }

  /** Builds a validated graph. Throws VALIDATION_FAILED if the definition is invalid. */
  build(catalog?: TypeCatalog): ClaspGraph {
    const base = createGraph({ name: this.name, ...this.options });
    return applyOperations(base, this.operations(), catalog ? { catalog } : {}).graph;
  }
}
