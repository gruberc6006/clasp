import { GraphBuilder, type ClaspGraph, type TypeCatalog } from "@clasp/core";

/** The address of the chat relay started by `pnpm socket-server`. */
export const LOCAL_SOCKET_SERVER = "ws://localhost:4318";

/**
 * Socket Chat — talk to a WebSocket server.
 *
 * The socket component goes through the workspace's network service: the
 * first time this app wants a server, the user is asked, and only that host
 * is allowed. Try it with `pnpm socket-server`, a chat relay on this computer
 * that passes every message to everyone connected.
 */
export function buildSocketChat(catalog?: TypeCatalog): ClaspGraph {
  const b = new GraphBuilder("Socket Chat", {
    description: "Connect to a WebSocket server and send and receive messages. Clasp asks you before it connects to any server.",
  });

  const socket = b.add("net.socket", { name: "Socket", properties: { keep: 200 } });

  const window = b.add("ui.window", {
    name: "Window",
    properties: { title: "Socket Chat", subtitle: "Messages to and from a server, live.", width: "regular" },
  });

  const bar = b.add("ui.container", { name: "Connection bar", parent: window, properties: { direction: "row", gap: "small", align: "end" } });
  const address = b.add("ui.textInput", {
    name: "Server address",
    parent: bar,
    properties: { label: "Server", value: LOCAL_SOCKET_SERVER, placeholder: "wss://example.org/chat", inputType: "url" },
  });
  const connect = b.add("ui.button", { name: "Connect button", parent: bar, properties: { label: "Connect", variant: "primary" } });
  const disconnect = b.add("ui.button", { name: "Disconnect button", parent: bar, properties: { label: "Disconnect", variant: "ghost" } });

  const status = b.add("ui.text", { name: "Status", parent: window, properties: { text: "Not connected", variant: "muted" } });

  const form = b.add("ui.form", { name: "Message form", parent: window, properties: { direction: "row", gap: "small" } });
  const message = b.add("ui.textInput", {
    name: "Message input",
    parent: form,
    properties: { field: "text", placeholder: "Type a message", required: true },
  });
  const send = b.add("ui.button", { name: "Send button", parent: form, properties: { label: "Send", variant: "primary" } });

  const log = b.add("ui.list", {
    name: "Messages",
    parent: window,
    properties: { titleField: "text", subtitleField: "label", emptyText: "No messages yet. Connect to a server, then send something." },
  });
  const clear = b.add("ui.button", { name: "Clear button", parent: window, properties: { label: "Clear messages", variant: "ghost" } });

  // Connecting: the address feeds the socket; Connect or Enter in the address connects.
  b.connect(`${address}.value`, `${socket}.url`);
  b.connect(`${connect}.click`, `${socket}.connect`);
  b.connect(`${address}.submitted`, `${socket}.connect`);
  b.connect(`${disconnect}.click`, `${socket}.disconnect`);
  b.connect(`${socket}.statusText`, `${status}.text`);
  // Sending: Send or Enter → form → socket.
  b.connect(`${send}.click`, `${form}.submit`);
  b.connect(`${message}.submitted`, `${form}.submit`);
  b.connect(`${form}.submitted`, `${socket}.send`);
  // What was sent and received.
  b.connect(`${socket}.messages`, `${log}.items`);
  b.connect(`${clear}.click`, `${socket}.clear`);

  b.exposeAction("send", `${socket}.send`, "Sends a message to the server. Arguments: a string, or { text }.");
  b.exposeEvent("message", `${socket}.message`, "A message arrived from the server: { text, at }.");
  b.exposeOutput("status", `${socket}.status`, "disconnected, connecting, connected, denied or failed");

  return b.build(catalog);
}
