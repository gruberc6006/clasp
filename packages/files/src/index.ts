import type { ComponentRegistry } from "@clasp/runtime";
import { documentComponent } from "./document";

export * from "./service";
export * from "./desktop";
export { documentComponent, documentFeature } from "./document";

/** Registers the document component into a registry. */
export function registerFiles(registry: ComponentRegistry): ComponentRegistry {
  return registry.register(documentComponent);
}
