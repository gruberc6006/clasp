import {
  ClaspError,
  deepClone,
  isJsonObject,
  issue,
  type ClaspIssue,
  type ClaspObject,
  type JsonObject,
  type JsonValue,
  type ObjectTypeInfo,
  type TypeCatalog,
} from "@clasp/core";
import type {
  ComponentCategory,
  ComponentDefinition,
  ComponentDescription,
  ComponentEnvironment,
  PortSet,
  PropertySpec,
} from "./component";

const TYPE_ID = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;

function checkProperty(spec: PropertySpec, value: JsonValue): string | undefined {
  switch (spec.type) {
    case "string":
    case "text":
    case "schema":
    case "field":
    case "resource":
      return typeof value === "string" ? undefined : "must be text";
    case "number":
      return typeof value === "number" ? undefined : "must be a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "enum":
      return typeof value === "string" && (spec.options ?? []).includes(value)
        ? undefined
        : `must be one of: ${(spec.options ?? []).join(", ")}`;
    case "list":
      return Array.isArray(value) ? undefined : "must be a list";
    case "object":
      return isJsonObject(value) ? undefined : "must be an object";
    case "json":
      return undefined;
  }
}

/**
 * The discoverable catalog of deterministic components.
 *
 * It is the single source of truth for what can exist in a graph: the graph
 * engine validates against it (it implements `TypeCatalog`), the runtime
 * instantiates from it, the Studio's component library lists it, and the AI
 * is shown it.
 */
export class ComponentRegistry implements TypeCatalog {
  private readonly definitions = new Map<string, ComponentDefinition>();
  private environment: ComponentEnvironment = { resolveResource: () => undefined };

  register(definition: ComponentDefinition): this {
    if (!TYPE_ID.test(definition.type)) {
      throw new ClaspError("VALIDATION_FAILED", `Component type "${definition.type}" must look like "namespace.name".`);
    }
    if (this.definitions.has(definition.type)) {
      throw new ClaspError("ALREADY_EXISTS", `Component "${definition.type}" is already registered.`);
    }
    const names = new Set<string>();
    for (const port of [...definition.inputs, ...definition.actions]) {
      if (names.has(port.name)) throw new ClaspError("VALIDATION_FAILED", `${definition.type}: input/action "${port.name}" is declared twice.`);
      names.add(port.name);
    }
    names.clear();
    for (const port of [...definition.outputs, ...definition.events]) {
      if (names.has(port.name)) throw new ClaspError("VALIDATION_FAILED", `${definition.type}: output/event "${port.name}" is declared twice.`);
      names.add(port.name);
    }
    this.definitions.set(definition.type, definition);
    return this;
  }

  registerAll(definitions: readonly ComponentDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  /** Lets components resolve resources outside their graph when describing dynamic ports. */
  setEnvironment(environment: ComponentEnvironment): void {
    this.environment = environment;
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  get(type: string): ComponentDefinition | undefined {
    return this.definitions.get(type);
  }

  list(category?: ComponentCategory): ComponentDefinition[] {
    return [...this.definitions.values()].filter((definition) => category === undefined || definition.category === category);
  }

  /** Ports of one concrete object (static, or computed for dynamic components). */
  portsOf(object: Pick<ClaspObject, "type" | "properties">): (PortSet & { unresolved?: boolean }) | undefined {
    const definition = this.definitions.get(object.type);
    if (!definition) return undefined;
    if (definition.ports) return definition.ports(object, this.environment);
    return { inputs: definition.inputs, outputs: definition.outputs, events: definition.events, actions: definition.actions };
  }

  /** Default property values of a type. */
  defaults(type: string): JsonObject {
    const result: JsonObject = {};
    for (const spec of this.definitions.get(type)?.properties ?? []) {
      if (spec.default !== undefined) result[spec.name] = deepClone(spec.default);
    }
    return result;
  }

  describe(object: Pick<ClaspObject, "type" | "typeVersion" | "properties">): ObjectTypeInfo | undefined {
    const definition = this.definitions.get(object.type);
    const ports = this.portsOf(object);
    if (!definition || !ports) return undefined;
    return {
      type: definition.type,
      version: definition.version,
      inputs: ports.inputs,
      outputs: ports.outputs,
      events: ports.events,
      actions: ports.actions,
      container: definition.container === true,
      ...(ports.unresolved ? { unresolved: true } : {}),
      validateProperties: (properties) => this.validateProperties(definition, properties),
    };
  }

  /** Machine-readable descriptions of every component — what the AI and the library see. */
  catalog(): ComponentDescription[] {
    return this.list().map((definition) => {
      const { create: _create, ports, resources: _resources, requirements: _requirements, ...description } = definition;
      return deepClone({ ...description, container: definition.container === true, dynamicPorts: ports !== undefined });
    });
  }

  private validateProperties(definition: ComponentDefinition, properties: JsonObject): ClaspIssue[] {
    const issues: ClaspIssue[] = [];
    const specs = new Map(definition.properties.map((spec) => [spec.name, spec]));
    for (const [name, value] of Object.entries(properties)) {
      const spec = specs.get(name);
      if (!spec) {
        const allowed = [...specs.keys()].join(", ") || "none";
        issues.push(issue("UNKNOWN_PROPERTY", `${definition.type} has no property "${name}". Properties: ${allowed}.`, { path: name }));
        continue;
      }
      if (value === null) continue;
      const problem = checkProperty(spec, value);
      if (problem) issues.push(issue("INVALID_PROPERTY", `${definition.type}.${name} ${problem}.`, { path: name }));
    }
    for (const spec of definition.properties) {
      const value = properties[spec.name];
      if (spec.required && (value === undefined || value === null || value === "")) {
        issues.push(
          issue("MISSING_PROPERTY", `${definition.title} needs its "${spec.title ?? spec.name}" property to be set.`, {
            path: spec.name,
            severity: "warning",
          }),
        );
      }
    }
    return issues;
  }
}
