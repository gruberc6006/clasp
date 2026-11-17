import { isJsonObject, toClaspError, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentContext, ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asText } from "./helpers";
import { calculate } from "./tools";

/**
 * A command line for the workspace. It is an ordinary application component:
 * every command goes through the Universal API as this application, so it can
 * see and do exactly what the user has allowed it — nothing more. It runs no
 * programs and evaluates no code.
 */

export type TerminalLineKind = "input" | "output" | "error" | "info";

const FILES = "clasp.files";
const NOTIFICATIONS = "clasp.notifications";
const NETWORK = "clasp.network";
const MAX_LINES = 500;

export const TERMINAL_COMMANDS: ReadonlyArray<[string, string]> = [
  ["help", "List commands"],
  ["clear", "Clear the screen"],
  ["echo <text>", "Print text"],
  ["date", "The date and time"],
  ["whoami", "Which application this terminal is"],
  ["history", "Commands you ran"],
  ["calc <expression>", "Calculate, e.g. calc (2+3)*4"],
  ["apps", "Applications this terminal can see"],
  ["discover [schema]", "Resources this terminal can find, optionally by record schema"],
  ["query <resource> [count]", "Read records (needs your permission)"],
  ["request <resource>", "Ask you for access to a resource"],
  ["notify <message>", "Send a notification (needs your permission)"],
  ["open", "Pick a file to print"],
  ["connect <ws://…>", "Open a socket (asks you the first time)"],
  ["send <text>", "Send on the open socket"],
  ["disconnect", "Close the socket"],
];

/** Splits a command line into the command and the rest. */
export function parseCommand(line: string): { command: string; rest: string; args: string[] } {
  const trimmed = line.trim();
  const space = trimmed.search(/\s/);
  const command = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { command, rest, args: rest === "" ? [] : rest.split(/\s+/) };
}

function summarize(fields: JsonObject): string {
  const parts = Object.entries(fields)
    .filter(([key, value]) => key !== "id" && value !== null && value !== "" && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value) : String(value)}`);
  return parts.join("  ");
}

function preview(content: JsonValue): string[] {
  if (typeof content === "string") {
    const lines = content.split("\n");
    return lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more lines`] : lines;
  }
  const text = JSON.stringify(content, null, 2) ?? "null";
  const lines = text.split("\n");
  return lines.length > 40 ? [...lines.slice(0, 40), "…"] : lines;
}

const terminal: ComponentDefinition = {
  type: "ui.terminal",
  version: 1,
  category: "interface",
  title: "Terminal",
  description:
    'A command line for the workspace: discover resources, query records, request access, send notifications, open files and talk over sockets. Every command runs through the Universal API as this application, with exactly the permissions you gave it. Type "help".',
  properties: [
    { name: "greeting", type: "string", default: 'Clasp terminal. Type "help" for commands.', title: "Greeting" },
    { name: "prompt", type: "string", default: "clasp>", title: "Prompt" },
  ],
  inputs: [VISIBLE],
  outputs: [
    { name: "lines", type: "records", description: "The screen: { text, kind: input|output|error|info }." },
    { name: "history", type: "list", description: "Commands run, oldest first." },
    { name: "prompt", type: "string" },
    { name: "busy", type: "boolean", description: "A command is still running." },
  ],
  events: [{ name: "ran", payload: "string", description: "A command was entered." }],
  actions: [
    { name: "run", payload: "string", description: "Runs a command line." },
    { name: "clear" },
  ],
  create: (ctx: ComponentContext) => {
    const publish = (): void => {
      ctx.setOutput("lines", ctx.getState<JsonObject[]>("lines") ?? []);
      ctx.setOutput("history", ctx.getState<string[]>("history") ?? []);
      ctx.setOutput("prompt", asText(ctx.props.prompt, "clasp>"));
      ctx.setOutput("busy", (ctx.getState<number>("busy") ?? 0) > 0);
    };
    const print = (text: string, kind: TerminalLineKind = "output"): void => {
      const seq = (ctx.getState<number>("seq") ?? 0) + 1;
      ctx.setState("seq", seq);
      const lines = ctx.getState<JsonObject[]>("lines") ?? [];
      const next = [...lines, ...text.split("\n").map((part, index) => ({ id: `line-${seq}-${index}`, text: part, kind }))];
      ctx.setState("lines", next.slice(-MAX_LINES));
    };
    /** Runs async work for a command; failures print as errors. */
    const work = (task: () => Promise<void>, options: { background?: boolean } = {}): void => {
      ctx.setState("busy", (ctx.getState<number>("busy") ?? 0) + 1);
      publish();
      const done = (): void => {
        ctx.setState("busy", Math.max(0, (ctx.getState<number>("busy") ?? 1) - 1));
        publish();
      };
      ctx.run(
        async () => {
          try {
            await task();
          } finally {
            if (ctx.alive) done();
          }
        },
        (error) => {
          print(`${error.code === "PERMISSION_DENIED" ? "Not allowed" : "Error"}: ${error.message}`, "error");
          if (error.code === "PERMISSION_DENIED") print(`Use "request <resource>" to ask for access.`, "info");
          publish();
        },
        options,
      );
    };

    const pump = (socketId: string): void => {
      ctx.run(
        async () => {
          while (ctx.alive && ctx.getState<string>("socket") === socketId) {
            const batch = await ctx.clasp.invoke({ target: NETWORK, action: "receive", arguments: { socketId } });
            if (!ctx.alive || ctx.getState<string>("socket") !== socketId) return;
            const result = isJsonObject(batch) ? batch : {};
            for (const message of Array.isArray(result.messages) ? result.messages : []) {
              if (isJsonObject(message) && typeof message.text === "string") print(`← ${message.text}`);
            }
            if (result.state === "closed") {
              ctx.setState("socket", undefined);
              print(`Disconnected: ${asText(result.reason, "closed")}`, "info");
            }
            publish();
          }
        },
        (error) => {
          ctx.setState("socket", undefined);
          print(`Disconnected: ${error.message}`, "error");
          publish();
        },
        { background: true },
      );
    };

    const kindOf = async (resourceId: string): Promise<string | undefined> => {
      const found = await ctx.clasp.discover();
      return found.find((resource) => resource.id === resourceId)?.kind;
    };

    const execute = (line: string): void => {
      const { command, rest, args } = parseCommand(line);
      switch (command) {
        case "":
          return;
        case "help":
          for (const [usage, text] of TERMINAL_COMMANDS) print(`  ${usage.padEnd(26)}${text}`);
          return;
        case "clear":
          ctx.setState("lines", []);
          return;
        case "echo":
          print(rest);
          return;
        case "date":
          print(new Date().toString());
          return;
        case "whoami":
          print(`${ctx.clasp.principal} — this terminal's application. It can use what it owns and what you granted it.`);
          return;
        case "history":
          (ctx.getState<string[]>("history") ?? []).forEach((entry, index) => print(`  ${String(index + 1).padStart(3)}  ${entry}`));
          return;
        case "calc": {
          if (!rest) {
            print("Usage: calc <expression>, e.g. calc (2+3)*4", "error");
            return;
          }
          const normalized = rest.replace(/\*/g, "×").replace(/\//g, "÷").replace(/-/g, "−");
          if (/[^0-9.+−×÷%()\s]/.test(normalized)) {
            print("calc understands numbers, + - * / %, and brackets.", "error");
            return;
          }
          const result = calculate(normalized.replace(/\s+/g, ""));
          print(typeof result === "number" ? String(result) : result, typeof result === "number" ? "output" : "error");
          return;
        }
        case "apps":
          work(async () => {
            const apps = (await ctx.clasp.discover({ kind: "application" })).filter((resource) => !resource.owned);
            if (apps.length === 0) print("No other applications have made themselves discoverable.", "info");
            for (const app of apps) print(`  ${app.name.padEnd(24)}${app.id}${app.access.length > 0 ? `  (you granted: ${app.access.join(", ")})` : ""}`);
          });
          return;
        case "discover":
          work(async () => {
            const found = await ctx.clasp.discover(args[0] ? { schema: args[0] } : {});
            const visible = found.filter((resource) => !resource.owned);
            if (visible.length === 0) print("Nothing found.", "info");
            for (const resource of visible) {
              const access = resource.access.length > 0 ? `granted: ${resource.access.join(", ")}` : "no access";
              print(`  ${resource.kind.padEnd(12)}${resource.id.padEnd(30)}${resource.name} · ${resource.ownerName} · ${access}`);
            }
          });
          return;
        case "query": {
          const source = args[0];
          if (!source) {
            print("Usage: query <resource id> [count]", "error");
            return;
          }
          const limit = Math.min(100, Math.max(1, Number(args[1]) || 20));
          work(async () => {
            const result = await ctx.clasp.query({ source, limit });
            if (result.values) {
              for (const [key, value] of Object.entries(result.values)) print(`  ${key} = ${JSON.stringify(value)}`);
              return;
            }
            print(`${result.total} record${result.total === 1 ? "" : "s"}${result.total > result.records.length ? ` (showing ${result.records.length})` : ""}`, "info");
            for (const record of result.records) print(`  ${record.id}  ${summarize(record.fields)}`);
          });
          return;
        }
        case "request": {
          const resource = args[0];
          if (!resource) {
            print("Usage: request <resource id>", "error");
            return;
          }
          work(
            async () => {
              const kind = await kindOf(resource);
              if (!kind) throw toClaspError(new Error(`No resource "${resource}" is visible to this terminal. Try "discover".`), "NOT_FOUND");
              const capabilities = kind === "collection" ? ["collection.query" as const] : kind === "service" ? ["capability.invoke" as const] : ["object.read" as const];
              print(`Asking you for access to ${resource}…`, "info");
              publish();
              const decision = await ctx.clasp.requestAccess({ resource, capabilities, reason: "Requested from the terminal." });
              print(decision.granted ? `Granted: ${decision.capabilities.join(", ")}` : "Not granted.", decision.granted ? "info" : "error");
            },
            { background: true },
          );
          return;
        }
        case "notify":
          if (!rest) {
            print("Usage: notify <message>", "error");
            return;
          }
          work(async () => {
            await ctx.clasp.invoke({ target: NOTIFICATIONS, action: "send", arguments: { message: rest, title: "Terminal" } });
            print("Sent.", "info");
          });
          return;
        case "open":
          work(
            async () => {
              const opened = await ctx.clasp.invoke({ target: FILES, action: "open", arguments: { kind: "any", slot: ctx.object.id } });
              if (!isJsonObject(opened)) {
                print("Cancelled.", "info");
                return;
              }
              print(`── ${asText(opened.name)} (${asText(opened.kind)}) ──`, "info");
              for (const text of preview(opened.content ?? null)) print(text);
            },
            { background: true },
          );
          return;
        case "connect": {
          const url = args[0];
          if (!url) {
            print("Usage: connect ws://host:port/path", "error");
            return;
          }
          const previous = ctx.getState<string>("socket");
          if (previous) {
            ctx.setState("socket", undefined);
            void ctx.clasp.invoke({ target: NETWORK, action: "close", arguments: { socketId: previous } }).catch(() => undefined);
          }
          work(
            async () => {
              print(`Connecting to ${url}…`, "info");
              publish();
              const opened = await ctx.clasp.invoke({ target: NETWORK, action: "connect", arguments: { url } });
              if (!isJsonObject(opened) || typeof opened.socketId !== "string") return;
              ctx.setState("socket", opened.socketId);
              print(`Connected to ${asText(opened.host)}. Use "send <text>"; incoming messages start with ←.`, "info");
              pump(opened.socketId);
            },
            { background: true },
          );
          return;
        }
        case "send": {
          const socketId = ctx.getState<string>("socket");
          if (!socketId) {
            print('Not connected. Use "connect <ws://…>" first.', "error");
            return;
          }
          work(async () => {
            await ctx.clasp.invoke({ target: NETWORK, action: "send", arguments: { socketId, text: rest } });
            print(`→ ${rest}`);
          });
          return;
        }
        case "disconnect": {
          const socketId = ctx.getState<string>("socket");
          ctx.setState("socket", undefined);
          if (!socketId) {
            print("Not connected.", "info");
            return;
          }
          void ctx.clasp.invoke({ target: NETWORK, action: "close", arguments: { socketId } }).catch(() => undefined);
          print("Disconnected.", "info");
          return;
        }
        default:
          print(`Unknown command "${command}". Type "help".`, "error");
      }
    };

    const run = (payload: JsonValue | undefined): void => {
      const line = asText(payload).slice(0, 2000);
      print(`${asText(ctx.props.prompt, "clasp>")} ${line}`, "input");
      if (line.trim()) ctx.setState("history", [...(ctx.getState<string[]>("history") ?? []), line.trim()].slice(-100));
      execute(line);
      publish();
      ctx.emit("ran", line);
    };

    if (!ctx.getState<JsonObject[]>("lines")) print(asText(ctx.props.greeting, 'Clasp terminal. Type "help" for commands.'), "info");
    publish();
    return {
      actions: {
        run,
        clear: () => {
          ctx.setState("lines", []);
          publish();
        },
      },
      interactions: { run },
      dispose: () => {
        const socketId = ctx.getState<string>("socket");
        if (socketId) void ctx.clasp.invoke({ target: NETWORK, action: "close", arguments: { socketId } }).catch(() => undefined);
      },
    };
  },
};

export const terminalPrimitives: ComponentDefinition[] = [terminal];
