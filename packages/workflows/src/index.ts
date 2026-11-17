import type { ComponentRegistry } from "@clasp/runtime";
import { workflowComponents } from "./components";

export * from "./notifications";
export * from "./system";
export { workflowComponents };

/** Registers the workflow components into a registry. */
export function registerWorkflows(registry: ComponentRegistry): ComponentRegistry {
  return registry.registerAll(workflowComponents);
}
