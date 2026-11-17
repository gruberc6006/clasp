import type { ComponentRegistry } from "@clasp/runtime";
import { socketComponent } from "./socket";

export * from "./address";
export * from "./service";
export * from "./socket";
export * from "./websocket";

/** Registers the network components. */
export function registerNetwork(registry: ComponentRegistry): ComponentRegistry {
  registry.register(socketComponent);
  return registry;
}
