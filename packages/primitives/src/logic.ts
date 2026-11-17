import { isJsonObject, type JsonValue } from "@clasp/core";
import type { ComponentDefinition } from "@clasp/runtime";
import { OPERATORS, asNumber, asText, isTruthy, pure, test } from "./helpers";

const compare: ComponentDefinition = {
  type: "logic.compare",
  version: 1,
  category: "logic",
  title: "Comparison",
  description:
    'Compares a with b and outputs true or false. Typical use: connect a status to "a", set "b" to the expected text, and connect "result" to an element\'s "visible" input.',
  properties: [
    { name: "operator", type: "enum", options: [...OPERATORS], default: "eq", title: "Operator" },
    { name: "a", type: "json", title: "A" },
    { name: "b", type: "json", title: "B" },
  ],
  inputs: [
    { name: "a", type: "any" },
    { name: "b", type: "any" },
  ],
  outputs: [{ name: "result", type: "boolean" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    ctx.setOutput("result", test(asText(ctx.props.operator, "eq"), ctx.input("a"), ctx.input("b")));
  }),
};

const boolean: ComponentDefinition = {
  type: "logic.boolean",
  version: 1,
  category: "logic",
  title: "Boolean operation",
  description: 'Combines true/false values: and, or, xor — or negates "a" with not.',
  properties: [
    { name: "operation", type: "enum", options: ["and", "or", "xor", "not"], default: "and", title: "Operation" },
    { name: "a", type: "boolean", title: "A" },
    { name: "b", type: "boolean", title: "B" },
  ],
  inputs: [
    { name: "a", type: "any" },
    { name: "b", type: "any" },
  ],
  outputs: [{ name: "result", type: "boolean" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const a = isTruthy(ctx.input("a"));
    const b = isTruthy(ctx.input("b"));
    const operation = asText(ctx.props.operation, "and");
    ctx.setOutput("result", operation === "or" ? a || b : operation === "xor" ? a !== b : operation === "not" ? !a : a && b);
  }),
};

const math: ComponentDefinition = {
  type: "logic.math",
  version: 1,
  category: "logic",
  title: "Math",
  description: "Arithmetic on two numbers. The result is empty when an operand is missing or the operation is undefined (e.g. division by zero).",
  properties: [
    { name: "operation", type: "enum", options: ["add", "subtract", "multiply", "divide", "modulo", "min", "max"], default: "add", title: "Operation" },
    { name: "a", type: "number", title: "A" },
    { name: "b", type: "number", title: "B" },
  ],
  inputs: [
    { name: "a", type: "number" },
    { name: "b", type: "number" },
  ],
  outputs: [{ name: "result", type: "number" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const a = asNumber(ctx.input("a"));
    const b = asNumber(ctx.input("b"));
    let result: number | undefined;
    if (a !== undefined && b !== undefined) {
      switch (asText(ctx.props.operation, "add")) {
        case "add":
          result = a + b;
          break;
        case "subtract":
          result = a - b;
          break;
        case "multiply":
          result = a * b;
          break;
        case "divide":
          result = b === 0 ? undefined : a / b;
          break;
        case "modulo":
          result = b === 0 ? undefined : a % b;
          break;
        case "min":
          result = Math.min(a, b);
          break;
        case "max":
          result = Math.max(a, b);
          break;
      }
    }
    ctx.setOutput("result", result !== undefined && Number.isFinite(result) ? result : undefined);
  }),
};

const condition: ComponentDefinition = {
  type: "logic.condition",
  version: 1,
  category: "logic",
  title: "Condition",
  description: 'Outputs "whenTrue" while the condition holds, otherwise "whenFalse".',
  properties: [
    { name: "whenTrue", type: "json", title: "When true" },
    { name: "whenFalse", type: "json", title: "When false" },
  ],
  inputs: [
    { name: "condition", type: "any" },
    { name: "whenTrue", type: "any" },
    { name: "whenFalse", type: "any" },
  ],
  outputs: [{ name: "value", type: "any" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    ctx.setOutput("value", isTruthy(ctx.input("condition")) ? ctx.input("whenTrue") : ctx.input("whenFalse"));
  }),
};

const state: ComponentDefinition = {
  type: "logic.state",
  version: 1,
  category: "logic",
  title: "State",
  description: 'Remembers a value while the application runs. Events can "set" it (to their payload), "toggle" it or "reset" it.',
  properties: [{ name: "initial", type: "json", title: "Initial value" }],
  inputs: [],
  outputs: [{ name: "value", type: "any" }],
  events: [{ name: "changed", payload: "any" }],
  actions: [
    { name: "set", payload: "any", description: "Stores the event payload." },
    { name: "toggle", description: "Flips a true/false value." },
    { name: "reset", description: "Returns to the initial value." },
  ],
  create: (ctx) => {
    const initial = (): JsonValue => ctx.props.initial ?? null;
    const write = (value: JsonValue, announce: boolean): void => {
      const before = ctx.output("value");
      ctx.setState("value", value);
      ctx.setOutput("value", value);
      if (announce && JSON.stringify(before) !== JSON.stringify(value)) ctx.emit("changed", value);
    };
    write(ctx.getState("value") ?? initial(), false);
    return {
      actions: {
        set: (payload) => write(payload ?? null, true),
        toggle: () => write(!isTruthy(ctx.output("value")), true),
        reset: () => write(initial(), true),
      },
    };
  },
};

const trigger: ComponentDefinition = {
  type: "logic.trigger",
  version: 1,
  category: "logic",
  title: "Event trigger",
  description: 'Emits "fired" when its "fire" action runs — and, if "onStart" is set, once when the application starts. Can replace the payload with a fixed one.',
  properties: [
    { name: "onStart", type: "boolean", default: false, title: "Fire when the app starts" },
    { name: "payload", type: "json", title: "Fixed payload", description: "When set, replaces the incoming payload." },
  ],
  inputs: [],
  outputs: [],
  events: [{ name: "fired", payload: "any" }],
  actions: [{ name: "fire", payload: "any" }],
  create: (ctx) => {
    const fire = (payload: JsonValue | undefined): void => {
      const fixed = ctx.props.payload;
      ctx.emit("fired", fixed !== undefined ? fixed : payload);
    };
    return {
      start: () => {
        if (ctx.props.onStart === true) fire(undefined);
      },
      actions: { fire },
    };
  },
};

const action: ComponentDefinition = {
  type: "logic.action",
  version: 1,
  category: "logic",
  title: "Action",
  description:
    "Runs an action exposed by another application or a system service through the Universal API. Needs the user to grant this application permission to invoke it.",
  properties: [
    { name: "target", type: "resource", required: true, title: "Target", description: "Id of the application or service." },
    { name: "action", type: "string", required: true, title: "Action name" },
    { name: "arguments", type: "object", title: "Arguments", description: "Merged with the triggering event's payload (payload wins)." },
  ],
  inputs: [],
  outputs: [
    { name: "result", type: "any" },
    { name: "error", type: "string" },
  ],
  events: [
    { name: "done", payload: "any" },
    { name: "failed", payload: "object" },
  ],
  actions: [{ name: "run", payload: "any" }],
  references: ["target"],
  capabilities: [{ capability: "capability.invoke", description: "Invokes the configured action on the target resource." }],
  requirements: (object) => {
    const target = object.properties.target;
    const name = object.properties.action;
    if (typeof target !== "string" || !target || typeof name !== "string" || !name) return [];
    return [{ capability: "capability.invoke", resource: target, actions: [name], reason: `Run "${name}"` }];
  },
  create: (ctx) => ({
    actions: {
      run: (payload) => {
        const target = asText(ctx.props.target);
        const name = asText(ctx.props.action);
        if (!target || !name) {
          ctx.fail(new Error("Action has no target or action name configured."));
          return;
        }
        const base = isJsonObject(ctx.props.arguments) ? ctx.props.arguments : {};
        const args: JsonValue = isJsonObject(payload) ? { ...base, ...payload } : payload !== undefined && payload !== null ? payload : base;
        ctx.run(
          async () => {
            const result = await ctx.clasp.invoke({ target, action: name, arguments: args });
            if (!ctx.alive) return;
            ctx.setOutput("error", undefined);
            ctx.setOutput("result", result);
            ctx.emit("done", result);
          },
          (error) => {
            ctx.setOutput("error", error.message);
            ctx.emit("failed", { code: error.code, message: error.message });
            ctx.fail(error);
          },
        );
      },
    },
  }),
};

const timer: ComponentDefinition = {
  type: "logic.timer",
  version: 1,
  category: "logic",
  title: "Timer",
  description: 'Emits "tick" at a fixed interval while running.',
  properties: [
    { name: "interval", type: "number", default: 1000, title: "Interval (ms)" },
    { name: "autoStart", type: "boolean", default: false, title: "Start automatically" },
  ],
  inputs: [],
  outputs: [
    { name: "running", type: "boolean" },
    { name: "count", type: "number", description: "Ticks since the last reset." },
  ],
  events: [{ name: "tick", payload: "number" }],
  actions: [{ name: "start" }, { name: "stop" }, { name: "reset" }],
  create: (ctx) => {
    let cancel: (() => void) | undefined;
    const stop = (): void => {
      cancel?.();
      cancel = undefined;
      ctx.setOutput("running", false);
    };
    const start = (): void => {
      if (cancel) return;
      const interval = Math.max(50, asNumber(ctx.props.interval) ?? 1000);
      cancel = ctx.setInterval(() => {
        const count = ((ctx.output("count") as number | undefined) ?? 0) + 1;
        ctx.setOutput("count", count);
        ctx.emit("tick", count);
      }, interval);
      ctx.setOutput("running", true);
    };
    ctx.setOutput("running", false);
    ctx.setOutput("count", 0);
    return {
      start: () => {
        if (ctx.props.autoStart === true) start();
      },
      actions: { start, stop, reset: () => ctx.setOutput("count", 0) },
      dispose: () => cancel?.(),
    };
  },
};

export const logicPrimitives: ComponentDefinition[] = [compare, boolean, math, condition, state, trigger, action, timer];
