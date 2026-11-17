import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { JsonObject } from "@clasp/core";
import { buildSocketChat } from "@clasp/examples";
import { NETWORK_SERVICE_ID, describeNetworkResource, parseSocketAddress, webSocketFactory } from "@clasp/network";
import type { Workspace } from "@clasp/runtime";
import { AppDriver, answerAccessRequest, expectCode, openWorkspace } from "./support";

/** Waits for something the network does in the background (connecting, receiving). */
async function until(workspace: Workspace, check: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await workspace.settle();
}

function texts(chat: AppDriver): string[] {
  return ((chat.output("Socket", "messages") as JsonObject[] | undefined) ?? []).map((message) => String(message.text));
}

async function chatApp(workspace: Workspace): Promise<AppDriver> {
  const chat = new AppDriver(workspace, await workspace.install(buildSocketChat(workspace.registry)));
  await workspace.settle();
  return chat;
}

async function connectAllowing(workspace: Workspace, chat: AppDriver): Promise<void> {
  await chat.press("Connect button");
  await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the permission prompt");
  await answerAccessRequest(workspace, true);
  await until(workspace, () => chat.output("Socket", "status") === "connected", "the connection");
}

describe("network: sockets to servers the user allows", () => {
  it("asks before connecting, and opens nothing when the user says no", async () => {
    const { workspace, servers } = await openWorkspace({ backend: "memory" });
    const chat = await chatApp(workspace);
    expect(chat.output("Socket", "status")).toBe("disconnected");

    await chat.press("Connect button");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the permission prompt");
    const [request] = workspace.kernel.permissions.pendingRequests();
    expect(request).toMatchObject({ subject: chat.app.id, resource: "network:ws://localhost:4318", capabilities: ["network.request"] });
    expect(servers.connections).toHaveLength(0); // nothing is opened while the user decides

    await answerAccessRequest(workspace, false);
    await until(workspace, () => chat.output("Socket", "status") === "denied", "the denial");
    expect(servers.connections).toHaveLength(0);
    expect(chat.output("Socket", "statusText")).toContain("not allowed to connect to localhost:4318");
    expect(workspace.kernel.permissions.list({ subject: chat.app.id })).toEqual([]);
  });

  it("connects once allowed, sends and receives, and remembers the host — only that host", async () => {
    const { workspace, servers, network } = await openWorkspace({ backend: "memory" });
    const chat = await chatApp(workspace);
    await connectAllowing(workspace, chat);
    expect(chat.output("Socket", "statusText")).toBe("Connected to localhost:4318");
    expect(network.connections(chat.app.id)).toMatchObject([{ host: "localhost:4318", state: "open", appName: "Socket Chat" }]);

    await chat.type("Message input", "hello");
    await chat.press("Send button");
    await until(workspace, () => texts(chat).includes("echo: hello"), "the echo");
    expect(servers.connections[0]?.sent).toEqual(["hello"]);
    expect(texts(chat)).toEqual(["echo: hello", "hello", "Connected to localhost:4318"]); // newest first
    expect(chat.output("Socket", "lastMessage")).toBe("echo: hello");
    expect(chat.output("Message input", "value")).toBe(""); // the form cleared itself

    servers.push("news from the server");
    await until(workspace, () => texts(chat)[0] === "news from the server", "a pushed message");

    // Disconnect, then connect again: the host is remembered, so no new prompt.
    await chat.press("Disconnect button");
    expect(chat.output("Socket", "status")).toBe("disconnected");
    await until(workspace, () => servers.open().length === 0, "the close");
    await chat.press("Connect button");
    await until(workspace, () => chat.output("Socket", "status") === "connected", "the reconnection");
    expect(workspace.kernel.permissions.pendingRequests()).toHaveLength(0);

    // Another host is another question.
    await chat.type("Server address", "wss://other.example:8443/room");
    await chat.press("Connect button");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the second prompt");
    expect(workspace.kernel.permissions.pendingRequests()[0]?.resource).toBe("network:wss://other.example:8443");
    await answerAccessRequest(workspace, false);
    await until(workspace, () => chat.output("Socket", "status") === "denied", "the denial");
  });

  it("closes the connection the moment the permission is revoked", async () => {
    const { workspace, servers, network } = await openWorkspace({ backend: "memory" });
    const chat = await chatApp(workspace);
    await connectAllowing(workspace, chat);

    workspace.kernel.permissions.revokeWhere({ subject: chat.app.id, resource: "network:ws://localhost:4318" });
    await until(workspace, () => chat.output("Socket", "status") !== "connected", "the disconnection");
    expect(chat.output("Socket", "statusText")).toBe("Disconnected: Permission revoked");
    expect(network.connections()).toEqual([]);
    await until(workspace, () => servers.open().length === 0, "the socket to close");

    // Nothing can be sent any more, and connecting asks again.
    await chat.type("Message input", "still there?");
    await chat.press("Send button");
    expect(servers.connections[0]?.sent).toEqual([]);
    await chat.press("Connect button");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "a new prompt");
  });

  it("never lets an application use another's connection, inherit its hosts, or claim a host", async () => {
    const { workspace, network } = await openWorkspace({ backend: "memory" });
    const first = await chatApp(workspace);
    await connectAllowing(workspace, first);
    const socketId = network.connections(first.app.id)[0]?.id as string;

    // A second copy of the same app (as if imported) starts with nothing.
    const second = await chatApp(workspace);
    const api = workspace.kernel.connect(second.app.id);
    await expectCode(api.invoke({ target: NETWORK_SERVICE_ID, action: "send", arguments: { socketId, text: "hijack" } }), "NOT_FOUND");
    await expectCode(api.invoke({ target: NETWORK_SERVICE_ID, action: "receive", arguments: { socketId } }), "NOT_FOUND");
    await second.press("Connect button");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the second app's own prompt");
    expect(workspace.kernel.permissions.pendingRequests()[0]?.subject).toBe(second.app.id);
    await answerAccessRequest(workspace, false);

    // Owning a resource named like a host would bypass consent, so no one may declare one.
    const errors: string[] = [];
    workspace.kernel.onError(({ error }) => errors.push(error.message));
    workspace.kernel.addResources(second.app.id, [{ id: "network:ws://localhost:4318", kind: "service", name: "Fake host", ownerId: second.app.id }]);
    expect(workspace.kernel.getResource("network:ws://localhost:4318")).toBeUndefined();
    expect(errors.join()).toContain('may not start with "network:"');
    expect(network.allowed(second.app.id, "ws://localhost:4318")).toBe(false);
    expect(first.output("Socket", "status")).toBe("connected");
  });

  it("accepts only ws:// and wss:// addresses without credentials", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const chat = await chatApp(workspace);
    const api = workspace.kernel.connect(chat.app.id);
    for (const url of ["https://example.org", "file:///etc/passwd", "wss://user:secret@example.org/", "not an address", ""]) {
      await expectCode(api.invoke({ target: NETWORK_SERVICE_ID, action: "connect", arguments: { url } }), "VALIDATION_FAILED");
    }
    expect(workspace.kernel.permissions.pendingRequests()).toHaveLength(0);

    expect(parseSocketAddress("WSS://Chat.Example.ORG:443/room#top")).toEqual({
      url: "wss://chat.example.org/room",
      origin: "wss://chat.example.org",
      host: "chat.example.org",
      local: false,
      secure: true,
    });
    expect(parseSocketAddress("ws://127.0.0.1:9000").local).toBe(true);
    expect(describeNetworkResource("network:ws://localhost:4318")?.host).toBe("localhost:4318");
    expect(describeNetworkResource("clasp.files")).toBeUndefined();
  });

  it("limits connections, and reports unreachable servers and hang-ups", async () => {
    const { workspace, servers } = await openWorkspace({ backend: "memory", networkLimits: { maxSocketsPerApp: 1 } });
    const chat = await chatApp(workspace);
    const allow = (origin: string): void => {
      workspace.kernel.permissions.grant({ subject: chat.app.id, resource: `network:${origin}`, capability: "network.request" });
    };
    allow("wss://a.example");
    allow("wss://down.example");
    servers.refuse.add("down.example");
    const api = workspace.kernel.connect(chat.app.id);
    await expectCode(api.invoke({ target: NETWORK_SERVICE_ID, action: "connect", arguments: { url: "wss://down.example/" } }), "UNAVAILABLE");
    await api.invoke({ target: NETWORK_SERVICE_ID, action: "connect", arguments: { url: "wss://a.example/" } });
    await expectCode(api.invoke({ target: NETWORK_SERVICE_ID, action: "connect", arguments: { url: "wss://a.example/" } }), "EXECUTION_LIMIT_EXCEEDED");
    servers.hangUp();

    // A hang-up reaches the app as a disconnection with the server's reason.
    allow("ws://localhost:4318");
    await chat.press("Connect button");
    await until(workspace, () => chat.output("Socket", "status") === "connected", "the connection");
    servers.hangUp("Server going away");
    await until(workspace, () => chat.output("Socket", "status") === "disconnected", "the hang-up");
    expect(chat.output("Socket", "statusText")).toBe("Disconnected: Server going away");
  });

  it("talks to a real WebSocket server over a real connection", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.on("connection", (socket) => {
      socket.send("hello from a real server");
      socket.on("message", (data) => socket.send(`echo: ${String(data)}`));
    });
    try {
      const { workspace } = await openWorkspace({ backend: "memory", sockets: webSocketFactory(WebSocket) });
      const chat = await chatApp(workspace);
      await chat.type("Server address", `ws://127.0.0.1:${port}`);
      await connectAllowing(workspace, chat);
      await until(workspace, () => texts(chat).includes("hello from a real server"), "the greeting");

      await chat.type("Message input", "ping");
      await chat.press("Send button");
      await until(workspace, () => texts(chat).includes("echo: ping"), "the echo");

      for (const client of server.clients) client.close(1000, "bye");
      await until(workspace, () => chat.output("Socket", "status") === "disconnected", "the server closing");
      expect(chat.output("Socket", "statusText")).toBe("Disconnected: bye");
    } finally {
      server.close();
    }
  });
});
