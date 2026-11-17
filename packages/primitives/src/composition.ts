import { isJsonObject, type JsonValue } from "@clasp/core";
import type { Capability } from "@clasp/permissions";
import type { ComponentDefinition, ComponentInstance } from "@clasp/runtime";
import type { Subscription } from "@clasp/universal-api";
import { VISIBLE, asText } from "./helpers";

const OWN_ACTIONS = new Set(["requestAccess", "refresh"]);

/**
 * Embeds another application as a component.
 *
 * The embedded application keeps running as itself, with its own identity and
 * its own data; the host only ever touches what that application declared in
 * its public interface, and only through the Universal API:
 *
 *   exposed outputs → this object's outputs   (query + subscribe, object.read)
 *   exposed events  → this object's events    (subscribe, object.read)
 *   exposed actions → this object's actions   (invoke, capability.invoke)
 *   exposed inputs  → this object's inputs    (mutate "set", object.write)
 *   exposed views   → rendered in place       (object.read)
 */
const embed: ComponentDefinition = {
  type: "app.embed",
  version: 1,
  category: "composition",
  title: "Embedded application",
  description:
    "Uses another application as a component: shows one of its exposed views and surfaces its exposed outputs, events, actions and inputs as ports. The other application's internals stay private, and the user must grant access.",
  properties: [
    { name: "appId", type: "resource", required: true, title: "Application", description: "Id of the application to embed." },
    { name: "view", type: "string", title: "View", description: "Name of the exposed view to show. Defaults to the first one." },
  ],
  inputs: [VISIBLE],
  outputs: [{ name: "status", type: "string", description: "unbound | unresolved | needs-access | pending | connected" }],
  events: [{ name: "failed", payload: "object" }],
  actions: [
    { name: "requestAccess", description: "Asks the user to grant this application access to the embedded one." },
    { name: "refresh" },
  ],
  references: ["appId"],
  capabilities: [
    { capability: "object.read", description: "Shows the embedded application's views and reads its exposed outputs and events." },
    { capability: "capability.invoke", description: "Runs the embedded application's exposed actions." },
    { capability: "object.write", description: "Sets the embedded application's exposed inputs." },
  ],
  ports: (object, environment) => {
    const base = {
      inputs: [...embed.inputs],
      outputs: [...embed.outputs],
      events: [...embed.events],
      actions: [...embed.actions],
    };
    const appId = object.properties.appId;
    const target = typeof appId === "string" && appId ? environment.resolveResource(appId) : undefined;
    if (!target) return { ...base, unresolved: true };
    const taken = new Set([...base.inputs, ...base.outputs, ...base.events, ...base.actions].map((port) => port.name));
    const fresh = <T extends { name: string }>(entries: T[]): T[] => entries.filter((entry) => !taken.has(entry.name));
    return {
      inputs: [...base.inputs, ...fresh(target.inputs).map((entry) => ({ ...entry, type: "any" as const }))],
      outputs: [...base.outputs, ...fresh(target.outputs).map((entry) => ({ ...entry, type: "any" as const }))],
      events: [...base.events, ...fresh(target.events)],
      actions: [...base.actions, ...fresh(target.actions)],
    };
  },
  requirements: (object) => {
    const appId = object.properties.appId;
    if (typeof appId !== "string" || !appId) return [];
    return [{ capability: "object.read", resource: appId, reason: "Show its views and read its outputs" }];
  },
  create: (ctx) => {
    const target = (): string | undefined => asText(ctx.props.appId) || undefined;
    const subscriptions: Subscription[] = [];
    let accessWatch: Subscription | undefined;
    let declaredInputs: string[] = [];

    const drop = (): void => {
      for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
    };

    const denied = (code: string): void => {
      drop();
      if (code === "NOT_FOUND") ctx.setOutput("status", "unresolved");
      else if (ctx.output("status") !== "pending") ctx.setOutput("status", "needs-access");
    };

    const connect = (): void => {
      const appId = target();
      if (!appId) {
        ctx.setOutput("status", "unbound");
        return;
      }
      if (!accessWatch?.active) {
        try {
          accessWatch = ctx.clasp.subscribe({ source: appId, event: "access", handler: () => ctx.alive && connect() });
        } catch {
          accessWatch = undefined;
        }
      }
      ctx.run(
        async () => {
          const [descriptor] = (await ctx.clasp.discover({ kind: "application" })).filter((resource) => resource.id === appId);
          const snapshot = await ctx.clasp.query({ source: appId });
          if (!ctx.alive) return;
          drop();
          declaredInputs = descriptor?.inputs.map((input) => input.name) ?? [];
          for (const [name, value] of Object.entries(snapshot.values ?? {})) ctx.setOutput(name, value);
          const onError = (): void => denied("PERMISSION_DENIED");
          subscriptions.push(
            ctx.clasp.subscribe({
              source: appId,
              event: "changed",
              onError,
              handler: (event) => {
                const payload = event.payload;
                if (ctx.alive && isJsonObject(payload) && typeof payload.name === "string") {
                  ctx.setOutput(payload.name, payload.value ?? undefined);
                }
              },
            }),
          );
          for (const declared of descriptor?.events ?? []) {
            subscriptions.push(
              ctx.clasp.subscribe({
                source: appId,
                event: declared.name,
                onError,
                handler: (event) => ctx.alive && ctx.emit(declared.name, event.payload),
              }),
            );
          }
          ctx.setOutput("status", "connected");
          for (const name of declaredInputs) push(name, ctx.input(name));
        },
        (error) => denied(error.code),
      );
    };

    const push = (name: string, value: JsonValue | undefined): void => {
      const appId = target();
      if (!appId || !declaredInputs.includes(name) || !ctx.isConnected(name)) return;
      ctx.run(
        async () => {
          await ctx.clasp.mutate({ source: appId, operation: "set", data: { [name]: value ?? null } });
        },
        (error) => {
          ctx.emit("failed", { code: error.code, message: error.message });
          ctx.fail(error);
        },
      );
    };

    const remote = (name: string, payload: JsonValue | undefined): void => {
      const appId = target();
      if (!appId) return;
      ctx.run(
        async () => {
          await ctx.clasp.invoke({ target: appId, action: name, ...(payload !== undefined ? { arguments: payload } : {}) });
        },
        (error) => {
          ctx.emit("failed", { code: error.code, message: error.message });
          ctx.fail(error);
        },
      );
    };

    const own: NonNullable<ComponentInstance["actions"]> = {
      refresh: connect,
      requestAccess: () => {
        const appId = target();
        if (!appId) return;
        ctx.setOutput("status", "pending");
        ctx.run(
          async () => {
            const [descriptor] = (await ctx.clasp.discover({ kind: "application" })).filter((resource) => resource.id === appId);
            const capabilities: Capability[] = ["object.read"];
            if ((descriptor?.actions.length ?? 0) > 0) capabilities.push("capability.invoke");
            if ((descriptor?.inputs.length ?? 0) > 0) capabilities.push("object.write");
            const decision = await ctx.clasp.requestAccess({ resource: appId, capabilities, reason: "Embed this application" });
            if (!ctx.alive) return;
            if (decision.granted) connect();
            else ctx.setOutput("status", "needs-access");
          },
          (error) => denied(error.code),
          { background: true },
        );
      },
    };

    ctx.setOutput("status", target() ? "needs-access" : "unbound");
    return {
      start: connect,
      onInput: (port, value) => {
        if (port !== "visible") push(port, value);
      },
      // Any action that is not this component's own is forwarded to the
      // embedded application; the kernel rejects names it did not expose.
      actions: new Proxy(own, {
        get: (actions, name) => {
          if (typeof name !== "string") return undefined;
          return OWN_ACTIONS.has(name) ? actions[name] : (payload: JsonValue | undefined) => remote(name, payload);
        },
      }),
      dispose: () => {
        drop();
        accessWatch?.unsubscribe();
      },
    };
  },
};

export const compositionPrimitives: ComponentDefinition[] = [embed];
