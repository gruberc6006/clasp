import { isJsonObject, nowIso, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentContext, ComponentDefinition, ComponentInstance } from "@clasp/runtime";
import { NETWORK_SERVICE_ID } from "./service";

export type SocketStatus = "disconnected" | "connecting" | "connected" | "denied" | "failed";

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

/** The text to send for an action payload: a string, a form's field, or JSON for anything else. */
export function messageFrom(payload: JsonValue | undefined): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (isJsonObject(payload)) {
    for (const key of ["text", "message", "value", "title", "content"]) {
      const value = payload[key];
      if (typeof value === "string") return value;
    }
  }
  return JSON.stringify(payload);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * A live connection to a server, through the network service.
 *
 * The component never holds a socket: it asks the `clasp.network` service to
 * connect (which asks the user the first time this app wants that host),
 * sends through it, and collects incoming messages from it.
 */
export const socketComponent: ComponentDefinition = {
  type: "net.socket",
  version: 1,
  category: "network",
  title: "Socket",
  description:
    'A live two-way connection to a server (a WebSocket: ws:// or wss://). Nothing connects until the user allows this app that host. "connect" opens it, "send" sends text, "messages" lists what was sent and received (newest first), and "message" fires for each message received.',
  properties: [
    { name: "url", type: "string", default: "", title: "Server address", description: "A ws:// or wss:// address." },
    { name: "autoConnect", type: "boolean", default: false, title: "Connect on start" },
    { name: "keep", type: "number", default: 200, title: "Messages to keep" },
  ],
  inputs: [{ name: "url", type: "string", description: "Server address; the property is used when nothing is connected here." }],
  outputs: [
    { name: "status", type: "string", description: "disconnected, connecting, connected, denied or failed." },
    { name: "statusText", type: "string", description: "The status in words, e.g. “Connected to chat.example.org”." },
    { name: "connected", type: "boolean" },
    { name: "host", type: "string" },
    { name: "messages", type: "records", description: "Messages, newest first: { text, direction: in|out|note, at, label }." },
    { name: "lastMessage", type: "string", description: "The latest message received." },
  ],
  events: [
    { name: "message", payload: "object", description: "A message arrived: { text, at }." },
    { name: "opened", payload: "object", description: "The connection opened: { url, host }." },
    { name: "closed", payload: "object", description: "The connection ended: { reason }." },
    { name: "failed", payload: "object", description: "Connecting failed or was not allowed: { code, message }." },
  ],
  actions: [
    { name: "connect", payload: "any", description: "Connects. Payload: an address (optional; otherwise the url input)." },
    { name: "send", payload: "any", description: "Sends text. Payload: a string, or an object with a text or message field (other objects are sent as JSON)." },
    { name: "disconnect", description: "Closes the connection." },
    { name: "clear", description: "Clears the message list." },
  ],
  capabilities: [{ capability: "network.request", description: "Connects only to servers the user allows this application, one host at a time." }],
  create: (ctx: ComponentContext): ComponentInstance => {
    const keep = (): number => {
      const value = typeof ctx.props.keep === "number" ? ctx.props.keep : 200;
      return Math.min(2000, Math.max(1, Math.floor(value)));
    };

    const publish = (): void => {
      const status = ctx.getState<SocketStatus>("status") ?? "disconnected";
      ctx.setOutput("status", status);
      ctx.setOutput("connected", status === "connected");
      ctx.setOutput("statusText", ctx.getState<string>("statusText") ?? "Not connected");
      ctx.setOutput("host", ctx.getState<string>("host") ?? "");
      ctx.setOutput("messages", ctx.getState<JsonObject[]>("messages") ?? []);
      ctx.setOutput("lastMessage", ctx.getState<string>("lastMessage"));
    };

    const setStatus = (status: SocketStatus, text: string, host?: string): void => {
      ctx.setState("status", status);
      ctx.setState("statusText", text);
      if (host !== undefined) ctx.setState("host", host);
    };

    const log = (direction: "in" | "out" | "note", text: string): void => {
      const at = nowIso();
      const seq = (ctx.getState<number>("seq") ?? 0) + 1;
      ctx.setState("seq", seq);
      const label = direction === "in" ? `Received · ${clock(at)}` : direction === "out" ? `Sent · ${clock(at)}` : clock(at);
      const entry: JsonObject = { id: `message-${seq}`, text, direction, at, label };
      ctx.setState("messages", [entry, ...(ctx.getState<JsonObject[]>("messages") ?? [])].slice(0, keep()));
      if (direction === "in") ctx.setState("lastMessage", text);
    };

    const closeSocket = (socketId: string | undefined): void => {
      if (!socketId) return;
      void ctx.clasp.invoke({ target: NETWORK_SERVICE_ID, action: "close", arguments: { socketId } }).catch(() => undefined);
    };

    /** Collects incoming messages until the connection ends. */
    const pump = (socketId: string): void => {
      ctx.run(
        async () => {
          while (ctx.alive && ctx.getState<string>("socketId") === socketId) {
            const result = await ctx.clasp.invoke({ target: NETWORK_SERVICE_ID, action: "receive", arguments: { socketId } });
            if (!ctx.alive || ctx.getState<string>("socketId") !== socketId) return;
            const batch = isJsonObject(result) ? result : {};
            const messages = Array.isArray(batch.messages) ? batch.messages : [];
            for (const message of messages) {
              if (!isJsonObject(message) || typeof message.text !== "string") continue;
              log("in", message.text);
              publish();
              ctx.emit("message", { text: message.text, at: typeof message.at === "string" ? message.at : nowIso() });
            }
            if (batch.state === "closed") {
              const reason = typeof batch.reason === "string" ? batch.reason : "Disconnected";
              ctx.setState("socketId", undefined);
              setStatus("disconnected", `Disconnected: ${reason}`);
              log("note", `Disconnected: ${reason}`);
              publish();
              ctx.emit("closed", { reason });
              return;
            }
          }
        },
        (error) => {
          if (ctx.getState<string>("socketId") !== socketId) return;
          ctx.setState("socketId", undefined);
          setStatus(error.code === "PERMISSION_DENIED" ? "denied" : "disconnected", error.message);
          log("note", error.message);
          publish();
          ctx.emit("closed", { reason: error.message });
        },
        // Waiting for a server is not work in progress: the app stays idle.
        { background: true },
      );
    };

    const connect = (payload: JsonValue | undefined): void => {
      const given = typeof payload === "string" ? payload : isJsonObject(payload) && typeof payload.url === "string" ? payload.url : undefined;
      const url = (given ?? (typeof ctx.input("url") === "string" ? (ctx.input("url") as string) : "")).trim();
      if (ctx.getState<SocketStatus>("status") === "connecting") return;
      if (!url) {
        setStatus("failed", "Enter a server address, like wss://example.org/chat.");
        publish();
        return;
      }
      // Connecting again replaces the current connection.
      closeSocket(ctx.getState<string>("socketId"));
      ctx.setState("socketId", undefined);
      const attempt = (ctx.getState<number>("attempt") ?? 0) + 1;
      ctx.setState("attempt", attempt);
      setStatus("connecting", `Connecting to ${hostOf(url)}…`, hostOf(url));
      publish();
      ctx.run(
        async () => {
          const result = await ctx.clasp.invoke({ target: NETWORK_SERVICE_ID, action: "connect", arguments: { url } });
          const opened = isJsonObject(result) && typeof result.socketId === "string" ? result : undefined;
          if (!opened) throw new Error("The network service gave no connection.");
          const socketId = opened.socketId as string;
          if (!ctx.alive || ctx.getState<number>("attempt") !== attempt) {
            closeSocket(socketId);
            return;
          }
          const host = typeof opened.host === "string" ? opened.host : hostOf(url);
          ctx.setState("socketId", socketId);
          setStatus("connected", `Connected to ${host}`, host);
          log("note", `Connected to ${host}`);
          publish();
          ctx.emit("opened", { url: typeof opened.url === "string" ? opened.url : url, host });
          pump(socketId);
        },
        (error) => {
          if (ctx.getState<number>("attempt") !== attempt) return;
          setStatus(error.code === "PERMISSION_DENIED" ? "denied" : "failed", error.message);
          log("note", error.message);
          publish();
          ctx.emit("failed", { code: error.code, message: error.message });
        },
        // Connecting may wait for the user to answer a permission prompt.
        { background: true },
      );
    };

    const send = (payload: JsonValue | undefined): void => {
      const text = messageFrom(payload);
      if (text === undefined || text === "") return;
      const socketId = ctx.getState<string>("socketId");
      if (!socketId || ctx.getState<SocketStatus>("status") !== "connected") {
        setStatus(ctx.getState<SocketStatus>("status") ?? "disconnected", "Not connected — connect first.");
        publish();
        return;
      }
      ctx.run(
        async () => {
          await ctx.clasp.invoke({ target: NETWORK_SERVICE_ID, action: "send", arguments: { socketId, text } });
          if (!ctx.alive) return;
          log("out", text);
          publish();
        },
        (error) => {
          log("note", `Not sent: ${error.message}`);
          publish();
        },
      );
    };

    return {
      start: () => {
        // A previous instance (before a reconfiguration) closed its connection.
        ctx.setState("socketId", undefined);
        if (ctx.getState<SocketStatus>("status") === "connected" || ctx.getState<SocketStatus>("status") === "connecting") {
          setStatus("disconnected", "Not connected");
        }
        publish();
        if (ctx.props.autoConnect === true) connect(undefined);
      },
      actions: {
        connect,
        send,
        disconnect: () => {
          const socketId = ctx.getState<string>("socketId");
          ctx.setState("attempt", (ctx.getState<number>("attempt") ?? 0) + 1);
          ctx.setState("socketId", undefined);
          closeSocket(socketId);
          if (socketId) log("note", "Disconnected");
          setStatus("disconnected", "Not connected");
          publish();
          if (socketId) ctx.emit("closed", { reason: "Disconnected" });
        },
        clear: () => {
          ctx.setState("messages", []);
          publish();
        },
      },
      dispose: () => closeSocket(ctx.getState<string>("socketId")),
    };
  },
};
