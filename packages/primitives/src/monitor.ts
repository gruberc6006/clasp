import { isJsonObject, type JsonObject } from "@clasp/core";
import type { ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asNumber } from "./helpers";

const METRICS = "clasp.metrics";

/**
 * Shows the workspace's system metrics, sampled once a second. Reading them
 * needs the user's permission (`object.read` on `clasp.metrics`); the monitor
 * asks once when it starts and stops if the permission is revoked.
 */
const systemMonitor: ComponentDefinition = {
  type: "ui.systemMonitor",
  version: 1,
  category: "interface",
  title: "System monitor",
  description:
    "Live graphs of how this browser tab and workspace are doing: main-thread load, memory, frame rate, storage, applications and activity. Browsers do not report the computer's CPU usage, so it shows what a web page can measure. Needs permission to read the System service.",
  properties: [
    { name: "interval", type: "number", default: 1000, title: "Sample every (ms)" },
    { name: "keep", type: "number", default: 60, title: "Samples to keep" },
  ],
  inputs: [VISIBLE],
  outputs: [
    { name: "metrics", type: "object", description: "The latest sample." },
    { name: "history", type: "list", description: "Recent samples, oldest first." },
    { name: "status", type: "string", description: "asking, live, denied or unavailable." },
  ],
  events: [],
  actions: [{ name: "refresh" }],
  capabilities: [{ capability: "object.read", description: "Reads the System service's measurements." }],
  requirements: () => [{ capability: "object.read", resource: METRICS, reason: "Shows how the workspace and this browser tab are doing." }],
  create: (ctx) => {
    let stop: (() => void) | undefined;
    const publish = (): void => {
      ctx.setOutput("status", ctx.getState<string>("status") ?? "asking");
      ctx.setOutput("metrics", ctx.getState<JsonObject>("metrics") ?? {});
      ctx.setOutput("history", ctx.getState<JsonObject[]>("history") ?? []);
    };
    const sample = async (): Promise<void> => {
      const result = await ctx.clasp.query({ source: METRICS });
      if (!ctx.alive) return;
      const metrics: JsonObject = { ...(isJsonObject(result.values) ? result.values : {}), at: Date.now() };
      const keep = Math.max(2, Math.min(600, asNumber(ctx.props.keep) ?? 60));
      ctx.setState("metrics", metrics);
      ctx.setState("history", [...(ctx.getState<JsonObject[]>("history") ?? []), metrics].slice(-keep));
      ctx.setState("status", "live");
      publish();
    };
    const denied = (code: string): void => {
      stop?.();
      stop = undefined;
      ctx.setState("status", code === "PERMISSION_DENIED" ? "denied" : "unavailable");
      publish();
    };
    const poll = (): void => {
      stop?.();
      stop = ctx.setInterval(() => ctx.run(sample, (error) => denied(error.code)), Math.max(250, asNumber(ctx.props.interval) ?? 1000));
    };
    const begin = (): void => {
      ctx.run(
        async () => {
          try {
            await sample();
          } catch (error) {
            if ((error as { code?: unknown } | undefined)?.code !== "PERMISSION_DENIED") throw error;
            ctx.setState("status", "asking");
            publish();
            const decision = await ctx.clasp.requestAccess({
              resource: METRICS,
              capabilities: ["object.read"],
              reason: "Shows how the workspace and this browser tab are doing.",
            });
            if (!decision.granted) {
              denied("PERMISSION_DENIED");
              return;
            }
            await sample();
          }
          if (ctx.alive) poll();
        },
        (error) => denied(error.code),
        // Waiting for the user's answer is not work in progress.
        { background: true },
      );
    };
    publish();
    return {
      start: begin,
      actions: { refresh: begin },
      interactions: { refresh: begin },
      dispose: () => stop?.(),
    };
  },
};

export const monitorPrimitives: ComponentDefinition[] = [systemMonitor];
