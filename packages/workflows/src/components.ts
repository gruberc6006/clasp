import { getPath, isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentDefinition } from "@clasp/runtime";
import { flattenRecord, matchesCondition, type FilterOperators, type Subscription } from "@clasp/universal-api";
import { NOTIFICATION_SERVICE_ID } from "./notifications";

const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "truthy", "falsy"];

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function holds(operator: string, actual: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  const right = expected === undefined ? null : expected;
  switch (operator) {
    case "neq":
      return !matchesCondition(actual, right);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return matchesCondition(actual, { [`$${operator}`]: right } as FilterOperators);
    case "contains":
      return matchesCondition(actual, { $contains: typeof right === "string" ? right : String(right) });
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    default:
      return matchesCondition(actual, right);
  }
}

/** Replaces `{path}` placeholders with values from the payload. Plain substitution, nothing is evaluated. */
function fill(template: string, scope: JsonValue | undefined): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, key: string) => {
    const found = isJsonObject(scope) ? getPath(scope, key) : key === "value" ? scope : undefined;
    if (found === undefined || found === null) return "";
    return typeof found === "object" ? JSON.stringify(found) : String(found);
  });
}

function fillDeep(template: JsonValue, scope: JsonValue | undefined): JsonValue {
  if (typeof template === "string") {
    // A template that is exactly one placeholder keeps the value's type.
    const whole = /^\{([a-zA-Z0-9_.]+)\}$/.exec(template);
    if (whole && isJsonObject(scope)) return getPath(scope, whole[1] as string) ?? null;
    return fill(template, scope);
  }
  if (Array.isArray(template)) return template.map((entry) => fillDeep(entry, scope));
  if (isJsonObject(template)) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(template)) result[key] = fillDeep(value, scope);
    return result;
  }
  return template;
}

const listener: ComponentDefinition = {
  type: "workflow.listener",
  version: 1,
  category: "workflow",
  title: "Event listener",
  description:
    'Starts a workflow when records of a collection change. Emits "triggered" once per changed record with payload { type, record, previous }. Works for this application\'s own collections and — with the user\'s permission — for other applications\' collections.',
  properties: [
    { name: "collectionId", type: "resource", title: "Collection", description: "Id of the collection to watch." },
    {
      name: "schema",
      type: "schema",
      title: "Schema",
      description: "With no collection set: binds to the only discoverable collection of this schema, if there is exactly one.",
    },
    { name: "event", type: "enum", options: ["changed", "created", "updated", "deleted"], default: "changed", title: "When records are" },
    { name: "reason", type: "string", title: "Reason", description: "Shown to the user when asking for access." },
  ],
  inputs: [],
  outputs: [{ name: "status", type: "string", description: "unbound | unresolved | needs-access | pending | listening" }],
  events: [{ name: "triggered", payload: "object", description: "Payload: { type, record, previous }." }],
  actions: [
    { name: "requestAccess", description: "Asks the user for permission to watch the collection." },
    { name: "refresh" },
  ],
  references: ["collectionId"],
  capabilities: [{ capability: "collection.query", description: "Observes changes to the watched collection." }],
  requirements: (object) => {
    const id = object.properties.collectionId;
    return typeof id === "string" && id ? [{ capability: "collection.query", resource: id, reason: "Watch for changes" }] : [];
  },
  create: (ctx) => {
    let subscription: Subscription | undefined;
    let accessWatch: Subscription | undefined;
    const source = (): string | undefined => text(ctx.props.collectionId) || undefined;

    const listen = (): void => {
      const id = source();
      if (!id) {
        ctx.setOutput("status", "unbound");
        const schema = text(ctx.props.schema);
        if (!schema) return;
        // Choosing a target is not access: the user still has to grant it.
        ctx.run(async () => {
          const found = (await ctx.clasp.discover({ kind: "collection", schema })).filter((resource) => !resource.owned);
          if (ctx.alive && found.length === 1 && !source()) ctx.configure({ collectionId: (found[0] as { id: string }).id });
        });
        return;
      }
      if (subscription?.active) return;
      try {
        if (!accessWatch?.active) {
          accessWatch = ctx.clasp.subscribe({ source: id, event: "access", handler: () => ctx.alive && listen() });
        }
      } catch {
        accessWatch = undefined;
      }
      try {
        subscription = ctx.clasp.subscribe({
          source: id,
          event: text(ctx.props.event) || "changed",
          handler: (event) => {
            if (!ctx.alive) return;
            for (const change of event.changes ?? []) {
              ctx.emit("triggered", {
                type: change.type,
                record: flattenRecord(change.record),
                previous: change.previous ? flattenRecord(change.previous) : null,
              });
            }
          },
          onError: (error) => {
            subscription = undefined;
            if (ctx.alive) ctx.setOutput("status", error.code === "NOT_FOUND" ? "unresolved" : "needs-access");
          },
        });
        ctx.setOutput("status", "listening");
      } catch (error) {
        subscription = undefined;
        const code = (error as { code?: string }).code;
        if (code === "NOT_FOUND") ctx.setOutput("status", "unresolved");
        else if (ctx.output("status") !== "pending") ctx.setOutput("status", "needs-access");
      }
    };

    ctx.setOutput("status", source() ? "needs-access" : "unbound");
    return {
      start: listen,
      actions: {
        refresh: listen,
        requestAccess: () => {
          const id = source();
          if (!id) return;
          ctx.setOutput("status", "pending");
          const reason = text(ctx.props.reason);
          ctx.run(
            async () => {
              const decision = await ctx.clasp.requestAccess({
                resource: id,
                capabilities: ["collection.query"],
                ...(reason ? { reason } : {}),
              });
              if (!ctx.alive) return;
              if (decision.granted) listen();
              else ctx.setOutput("status", "needs-access");
            },
            (error) => {
              ctx.setOutput("status", error.code === "NOT_FOUND" ? "unresolved" : "needs-access");
              ctx.fail(error);
            },
            { background: true },
          );
        },
      },
      dispose: () => {
        subscription?.unsubscribe();
        accessWatch?.unsubscribe();
      },
    };
  },
};

const sequence: ComponentDefinition = {
  type: "workflow.sequence",
  version: 1,
  category: "workflow",
  title: "Sequential actions",
  description: 'Runs up to four steps in order: "run" emits first, second, third, fourth, then done — each with the same payload.',
  properties: [],
  inputs: [],
  outputs: [],
  events: [
    { name: "first", payload: "any" },
    { name: "second", payload: "any" },
    { name: "third", payload: "any" },
    { name: "fourth", payload: "any" },
    { name: "done", payload: "any" },
  ],
  actions: [{ name: "run", payload: "any" }],
  create: (ctx) => ({
    actions: {
      run: (payload) => {
        for (const step of ["first", "second", "third", "fourth", "done"]) ctx.emit(step, payload);
      },
    },
  }),
};

const branch: ComponentDefinition = {
  type: "workflow.branch",
  version: 1,
  category: "workflow",
  title: "Conditional branch",
  description:
    'Routes an event: "run" tests a field of the payload (dotted paths such as record.completed are allowed) and emits "then" when the test passes, otherwise "else". Without a field it tests the "condition" input.',
  properties: [
    { name: "field", type: "string", title: "Payload field", description: "e.g. record.completed" },
    { name: "operator", type: "enum", options: OPERATORS, default: "eq", title: "Operator" },
    { name: "value", type: "json", title: "Value" },
  ],
  inputs: [{ name: "condition", type: "any", description: "Used when no payload field is configured." }],
  outputs: [],
  events: [
    { name: "then", payload: "any" },
    { name: "else", payload: "any" },
  ],
  actions: [{ name: "run", payload: "any" }],
  create: (ctx) => ({
    actions: {
      run: (payload) => {
        const field = text(ctx.props.field);
        const passed = field
          ? holds(text(ctx.props.operator) || "eq", getPath(payload, field), ctx.props.value)
          : Boolean(ctx.input("condition"));
        ctx.emit(passed ? "then" : "else", payload);
      },
    },
  }),
};

const transform: ComponentDefinition = {
  type: "workflow.transform",
  version: 1,
  category: "workflow",
  title: "Data transformation",
  description:
    'Builds a new payload from the incoming one. The template may contain {path} placeholders, e.g. { "title": "Follow up: {record.title}" }.',
  properties: [{ name: "template", type: "json", required: true, title: "Template" }],
  inputs: [],
  outputs: [],
  events: [{ name: "out", payload: "any" }],
  actions: [{ name: "run", payload: "any" }],
  create: (ctx) => ({
    actions: {
      run: (payload) => ctx.emit("out", fillDeep(ctx.props.template ?? null, payload)),
    },
  }),
};

const notify: ComponentDefinition = {
  type: "workflow.notify",
  version: 1,
  category: "workflow",
  title: "Notification",
  description:
    'Shows the user a notification through the workspace notification service. The message may contain {path} placeholders filled from the triggering payload, e.g. "Finished: {record.title}".',
  properties: [
    { name: "message", type: "text", required: true, title: "Message" },
    { name: "title", type: "string", title: "Title" },
    { name: "level", type: "enum", options: ["info", "success", "warning", "error"], default: "info", title: "Level" },
  ],
  inputs: [],
  outputs: [{ name: "status", type: "string", description: "ready | needs-access | pending" }],
  events: [
    { name: "sent", payload: "object" },
    { name: "failed", payload: "object" },
  ],
  actions: [{ name: "send", payload: "any" }],
  capabilities: [{ capability: "capability.invoke", description: 'Invokes "send" on the notification service.' }],
  requirements: () => [
    { capability: "capability.invoke", resource: NOTIFICATION_SERVICE_ID, actions: ["send"], reason: "Show notifications" },
  ],
  create: (ctx) => {
    let asked = false;
    const deliver = (payload: JsonValue | undefined, retry: boolean): void => {
      const message = fill(text(ctx.props.message), payload);
      const title = fill(text(ctx.props.title), payload);
      ctx.run(
        async () => {
          await ctx.clasp.invoke({
            target: NOTIFICATION_SERVICE_ID,
            action: "send",
            arguments: { message, ...(title ? { title } : {}), level: text(ctx.props.level) || "info" },
          });
          if (!ctx.alive) return;
          ctx.setOutput("status", "ready");
          ctx.emit("sent", { message });
        },
        (error) => {
          if (error.code === "PERMISSION_DENIED" && retry && !asked) {
            // Ask the user once; send this notification if they agree.
            asked = true;
            ctx.setOutput("status", "pending");
            ctx.run(async () => {
              const decision = await ctx.clasp.requestAccess({
                resource: NOTIFICATION_SERVICE_ID,
                capabilities: ["capability.invoke"],
                actions: ["send"],
                reason: "Show notifications",
              });
              if (!ctx.alive) return;
              if (decision.granted) deliver(payload, false);
              else ctx.setOutput("status", "needs-access");
            }, undefined, { background: true });
            return;
          }
          if (error.code === "PERMISSION_DENIED") ctx.setOutput("status", "needs-access");
          ctx.emit("failed", { code: error.code, message: error.message });
          ctx.fail(error);
        },
      );
    };
    ctx.setOutput("status", "ready");
    return { actions: { send: (payload) => deliver(payload, true) } };
  },
};

/**
 * Runs an action of another resource (a service or an application's public
 * interface) through the Universal API. The first time, it asks the user for
 * permission to run exactly that action; nothing happens without it.
 */
const invoke: ComponentDefinition = {
  type: "workflow.invoke",
  version: 1,
  category: "workflow",
  title: "Run an action",
  description:
    'Runs an action of a service or another application, e.g. the Desktop\'s "open". Its "run" payload becomes the action\'s arguments. Asks the user for permission the first time.',
  properties: [
    { name: "target", type: "resource", required: true, title: "Service or application" },
    { name: "action", type: "string", required: true, title: "Action" },
    { name: "reason", type: "string", title: "Reason", description: "Shown to the user when asking for permission." },
  ],
  references: ["target"],
  inputs: [],
  outputs: [
    { name: "status", type: "string", description: "ready | pending | needs-access" },
    { name: "result", type: "any", description: "What the last run returned." },
  ],
  events: [
    { name: "done", payload: "any", description: "The action finished. Payload: its result." },
    { name: "failed", payload: "object" },
  ],
  actions: [{ name: "run", payload: "any", description: "Runs the action with this payload as its arguments." }],
  capabilities: [{ capability: "capability.invoke", description: "Runs one action of one resource, once the user allows it." }],
  requirements: (object) =>
    typeof object.properties.target === "string" && typeof object.properties.action === "string" && object.properties.target && object.properties.action
      ? [{ capability: "capability.invoke", resource: object.properties.target, actions: [object.properties.action], reason: text(object.properties.reason) || `Run “${object.properties.action}”` }]
      : [],
  create: (ctx) => {
    const target = (): string => text(ctx.props.target);
    const action = (): string => text(ctx.props.action);
    const run = (payload: JsonValue | undefined, retry: boolean): void => {
      if (!target() || !action()) return;
      ctx.run(
        async () => {
          ctx.setOutput("status", "pending");
          const result = await ctx.clasp.invoke({ target: target(), action: action(), ...(payload !== undefined ? { arguments: payload } : {}) });
          if (!ctx.alive) return;
          ctx.setOutput("status", "ready");
          ctx.setOutput("result", result ?? null);
          ctx.emit("done", result ?? null);
        },
        (error) => {
          if (error.code === "PERMISSION_DENIED" && retry) {
            ctx.run(
              async () => {
                const decision = await ctx.clasp.requestAccess({
                  resource: target(),
                  capabilities: ["capability.invoke"],
                  actions: [action()],
                  reason: text(ctx.props.reason) || `Run “${action()}”`,
                });
                if (!ctx.alive) return;
                if (decision.granted) run(payload, false);
                else ctx.setOutput("status", "needs-access");
              },
              undefined,
              { background: true },
            );
            return;
          }
          ctx.setOutput("status", error.code === "PERMISSION_DENIED" ? "needs-access" : "ready");
          ctx.emit("failed", { code: error.code, message: error.message });
          ctx.fail(error);
        },
      );
    };
    ctx.setOutput("status", "ready");
    return { actions: { run: (payload) => run(payload, true) } };
  },
};

export const workflowComponents: ComponentDefinition[] = [listener, sequence, branch, transform, notify, invoke];
