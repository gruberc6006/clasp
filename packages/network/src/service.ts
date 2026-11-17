import { ClaspError, Emitter, createId, isJsonObject, nowIso, toClaspError, type JsonObject, type JsonValue } from "@clasp/core";
import { SYSTEM_PRINCIPAL, type ClaspKernel } from "@clasp/universal-api";
import { NETWORK_RESOURCE_PREFIX, networkResource, parseSocketAddress, type SocketAddress } from "./address";

/** Resource id of the workspace network service. */
export const NETWORK_SERVICE_ID = "clasp.network";

/** What a host's socket implementation reports back. */
export interface SocketHandlers {
  opened(): void;
  received(text: string): void;
  /** A binary frame arrived; Clasp sockets carry text only, so it is counted and dropped. */
  binary(): void;
  closed(code: number, reason: string): void;
}

export interface SocketConnection {
  send(text: string): void;
  close(): void;
}

/**
 * Opens a real connection. Supplied by the host (the Studio passes the
 * browser's WebSocket); applications never see it.
 */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketConnection;

export interface NetworkLimits {
  /** Open connections one application may hold. */
  maxSocketsPerApp: number;
  /** Largest message, in characters, that may be sent or received. */
  maxMessageLength: number;
  /** Received messages kept while the application has not collected them. */
  maxQueued: number;
  connectTimeoutMs: number;
  /** How long one `receive` waits for a message before returning empty. */
  receiveWaitMs: number;
}

export const DEFAULT_LIMITS: NetworkLimits = {
  maxSocketsPerApp: 4,
  maxMessageLength: 64 * 1024,
  maxQueued: 500,
  connectTimeoutMs: 10_000,
  receiveWaitMs: 20_000,
};

export type ConnectionState = "connecting" | "open" | "closed";

/** One connection, as the host shows it to the user. */
export interface ConnectionInfo {
  id: string;
  appId: string;
  appName: string;
  url: string;
  origin: string;
  host: string;
  state: ConnectionState;
  openedAt: string;
  sent: number;
  received: number;
  dropped: number;
}

interface QueuedMessage {
  text: string;
  at: string;
}

interface Connection extends ConnectionInfo {
  socket: SocketConnection | undefined;
  queue: QueuedMessage[];
  waiters: Array<() => void>;
  closeReason: string | undefined;
}

function messageText(input: JsonObject): string {
  const value = input.text ?? input.message;
  if (typeof value !== "string") throw new ClaspError("VALIDATION_FAILED", "Send needs { socketId, text } with text as a string.");
  return value;
}

/**
 * The network service.
 *
 * Applications reach the network only through these actions:
 *
 *   connect {url, reason?}   → asks the user the first time an app wants a host; returns {socketId, url, host}
 *   send    {socketId, text} → sends a text message on the app's own connection
 *   receive {socketId}       → waits for messages: {messages: [{text, at}], state, reason?}
 *   close   {socketId}
 *
 * Permission is per application and per origin (scheme, host and port): a
 * grant of `network.request` on the resource `network:<origin>`. The service
 * checks the grant itself on every call and on every delivery, never by
 * ownership, so no application can grant itself a host. Revoking the grant
 * closes that application's connections to the host immediately.
 */
export class NetworkService {
  private factory: SocketFactory | undefined;
  private readonly limits: NetworkLimits;
  private readonly connectionsById = new Map<string, Connection>();
  private readonly changes = new Emitter<void>();

  constructor(
    private readonly kernel: ClaspKernel,
    factory?: SocketFactory,
    limits: Partial<NetworkLimits> = {},
  ) {
    this.factory = factory;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    kernel.addResources(SYSTEM_PRINCIPAL, [
      {
        id: NETWORK_SERVICE_ID,
        kind: "service",
        name: "Network",
        description: "Live connections (WebSockets) to servers. The user allows each application each host.",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        actions: [
          { name: "connect", description: "Connects to a ws:// or wss:// server, asking the user the first time. Arguments: { url, reason? }. Returns { socketId, url, host }." },
          { name: "send", description: "Sends text on a connection. Arguments: { socketId, text }." },
          { name: "receive", description: "Waits for messages. Arguments: { socketId }. Returns { messages: [{ text, at }], state, reason? }." },
          { name: "close", description: "Closes a connection. Arguments: { socketId }." },
        ],
        // The service checks its own per-host grants (and asks the user) for each call.
        mediatedActions: ["connect", "send", "receive", "close"],
      },
    ]);
    kernel.bindProvider(NETWORK_SERVICE_ID, { invoke: (action, args, caller) => this.handle(action, args, caller) });
    kernel.permissions.onChange((event) => {
      if (event.kind !== "revoked" || !event.grant.resource.startsWith(NETWORK_RESOURCE_PREFIX)) return;
      for (const connection of [...this.connectionsById.values()]) {
        if (connection.appId === event.grant.subject && networkResource(connection.origin) === event.grant.resource && !this.allowed(connection.appId, connection.origin)) {
          this.shut(connection, "Permission revoked");
        }
      }
    });
  }

  setFactory(factory: SocketFactory | undefined): void {
    this.factory = factory;
  }

  // ── for the host ─────────────────────────────────────────────────────

  /** Connections that are open or opening. */
  connections(appId?: string): ConnectionInfo[] {
    return [...this.connectionsById.values()]
      .filter((connection) => connection.state !== "closed" && (appId === undefined || connection.appId === appId))
      .map(({ socket: _socket, queue: _queue, waiters: _waiters, closeReason: _reason, ...info }) => ({ ...info }));
  }

  /** Closes one connection on the user's behalf. */
  disconnect(connectionId: string): void {
    const connection = this.connectionsById.get(connectionId);
    if (connection) this.shut(connection, "Closed by you");
  }

  /** Closes everything an application has open (e.g. when it is stopped). */
  disconnectApp(appId: string, reason = "The application stopped"): void {
    for (const connection of [...this.connectionsById.values()]) if (connection.appId === appId) this.shut(connection, reason);
  }

  /** Closes every connection (e.g. when the workspace closes). */
  disconnectAll(reason = "The workspace closed"): void {
    for (const connection of [...this.connectionsById.values()]) this.shut(connection, reason);
  }

  subscribe(listener: () => void): () => void {
    return this.changes.subscribe(listener);
  }

  /** True when the user allowed `appId` to connect to `origin`. Only an explicit grant counts. */
  allowed(appId: string, origin: string): boolean {
    const resource = networkResource(origin);
    return this.kernel.permissions.list({ subject: appId, resource }).some((grant) => grant.capability === "network.request");
  }

  // ── for applications, through the Universal API ──────────────────────

  private async handle(action: string, args: JsonValue | undefined, caller: string): Promise<JsonValue> {
    const input: JsonObject = isJsonObject(args) ? args : {};
    switch (action) {
      case "connect":
        return this.connect(input, caller);
      case "send": {
        const connection = this.own(input.socketId, caller);
        const text = messageText(input);
        if (text.length > this.limits.maxMessageLength) {
          throw new ClaspError("VALIDATION_FAILED", `Messages may be at most ${this.limits.maxMessageLength} characters.`);
        }
        this.authorize(connection);
        if (connection.state !== "open" || !connection.socket) throw new ClaspError("UNAVAILABLE", `The connection to ${connection.host} is ${connection.state === "closed" ? "closed" : "not open yet"}.`);
        connection.socket.send(text);
        connection.sent++;
        this.changes.emit();
        return { sent: true };
      }
      case "receive":
        return this.receive(this.own(input.socketId, caller));
      case "close": {
        const connection = this.connectionsById.get(typeof input.socketId === "string" ? input.socketId : "");
        if (connection && connection.appId === caller) {
          this.shut(connection, "Closed by the application");
          this.connectionsById.delete(connection.id);
        }
        return { closed: true };
      }
      default:
        throw new ClaspError("NOT_FOUND", `Network has no action "${action}".`);
    }
  }

  private async connect(input: JsonObject, caller: string): Promise<JsonValue> {
    const address = parseSocketAddress(input.url);
    const open = [...this.connectionsById.values()].filter((connection) => connection.appId === caller && connection.state !== "closed").length;
    if (open >= this.limits.maxSocketsPerApp) {
      throw new ClaspError("EXECUTION_LIMIT_EXCEEDED", `An application may have at most ${this.limits.maxSocketsPerApp} connections open.`);
    }
    if (!this.allowed(caller, address.origin)) {
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 200) : "";
      await this.kernel.permissions.request({
        subject: caller,
        resource: networkResource(address.origin),
        capabilities: ["network.request"],
        ...(reason ? { reason } : {}),
      });
      // Only the grant itself counts — not the request's answer.
      if (!this.allowed(caller, address.origin)) {
        throw new ClaspError("PERMISSION_DENIED", `“${this.kernel.principalName(caller)}” is not allowed to connect to ${address.host}.`, {
          details: { subject: caller, resource: networkResource(address.origin) },
        });
      }
    }
    const factory = this.factory;
    if (!factory) throw new ClaspError("UNAVAILABLE", "This host cannot open network connections.");
    return this.open(address, caller, factory);
  }

  private open(address: SocketAddress, caller: string, factory: SocketFactory): Promise<JsonValue> {
    const connection: Connection = {
      id: createId("socket"),
      appId: caller,
      appName: this.kernel.principalName(caller),
      url: address.url,
      origin: address.origin,
      host: address.host,
      state: "connecting",
      openedAt: nowIso(),
      sent: 0,
      received: 0,
      dropped: 0,
      socket: undefined,
      queue: [],
      waiters: [],
      closeReason: undefined,
    };
    this.connectionsById.set(connection.id, connection);
    this.changes.emit();

    return new Promise<JsonValue>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.shut(connection, message);
        this.connectionsById.delete(connection.id);
        reject(new ClaspError("UNAVAILABLE", message));
      };
      const timer = setTimeout(() => fail(`Could not connect to ${address.host}: it did not answer.`), this.limits.connectTimeoutMs);
      try {
        connection.socket = factory(address.url, {
          opened: () => {
            if (settled || connection.state === "closed") return;
            settled = true;
            clearTimeout(timer);
            connection.state = "open";
            this.changes.emit();
            resolve({ socketId: connection.id, url: address.url, host: address.host });
          },
          received: (text) => this.deliver(connection, text),
          binary: () => {
            connection.dropped++;
            this.changes.emit();
          },
          closed: (code, reason) => {
            if (!settled) {
              fail(`Could not connect to ${address.host}${reason ? `: ${reason}` : ""}.`);
              return;
            }
            this.shut(connection, reason || (code === 1000 ? "The server closed the connection" : `The connection was lost (code ${code})`));
          },
        });
      } catch (error) {
        fail(`Could not connect to ${address.host}: ${toClaspError(error).message}`);
      }
    });
  }

  private deliver(connection: Connection, text: string): void {
    if (connection.state !== "open") return;
    // Checked at every delivery, like subscriptions: revocation is immediate.
    if (!this.allowed(connection.appId, connection.origin)) {
      this.shut(connection, "Permission revoked");
      return;
    }
    if (text.length > this.limits.maxMessageLength) {
      connection.dropped++;
    } else {
      connection.queue.push({ text, at: nowIso() });
      connection.received++;
      if (connection.queue.length > this.limits.maxQueued) {
        connection.queue.shift();
        connection.dropped++;
      }
    }
    this.wake(connection);
    this.changes.emit();
  }

  private async receive(connection: Connection): Promise<JsonValue> {
    if (connection.queue.length === 0 && connection.state !== "closed") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.limits.receiveWaitMs);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        connection.waiters.push(done);
      });
    }
    if (connection.state !== "closed") this.authorize(connection);
    const messages = connection.queue.splice(0, connection.queue.length);
    const result: JsonObject = { messages: messages.map((message) => ({ text: message.text, at: message.at })), state: connection.state };
    if (connection.state === "closed") {
      result.reason = connection.closeReason ?? "Closed";
      // The application has now seen the end of this connection.
      if (connection.queue.length === 0) this.connectionsById.delete(connection.id);
    }
    return result;
  }

  /** The caller's own connection, or NOT_FOUND (another app's id is indistinguishable from a wrong one). */
  private own(socketId: JsonValue | undefined, caller: string): Connection {
    const connection = typeof socketId === "string" ? this.connectionsById.get(socketId) : undefined;
    if (!connection || connection.appId !== caller) throw new ClaspError("NOT_FOUND", "No such connection.");
    return connection;
  }

  private authorize(connection: Connection): void {
    if (this.allowed(connection.appId, connection.origin)) return;
    this.shut(connection, "Permission revoked");
    throw new ClaspError("PERMISSION_DENIED", `“${connection.appName}” is no longer allowed to connect to ${connection.host}.`);
  }

  private shut(connection: Connection, reason: string): void {
    if (connection.state === "closed") return;
    connection.state = "closed";
    connection.closeReason = reason;
    try {
      connection.socket?.close();
    } catch {
      // Already closed.
    }
    this.wake(connection);
    this.prune(connection.appId);
    this.changes.emit();
  }

  private wake(connection: Connection): void {
    const waiters = connection.waiters.splice(0, connection.waiters.length);
    for (const waiter of waiters) waiter();
  }

  /** Closed connections wait for their app to collect the reason; keep only a few. */
  private prune(appId: string): void {
    const closed = [...this.connectionsById.values()].filter((connection) => connection.appId === appId && connection.state === "closed");
    for (const connection of closed.slice(0, Math.max(0, closed.length - 8))) this.connectionsById.delete(connection.id);
  }
}
