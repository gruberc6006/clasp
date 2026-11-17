#!/usr/bin/env node
/**
 * A tiny chat relay for trying Clasp's Socket Chat template.
 *
 * Every text message is passed to everyone connected (the sender included),
 * prefixed with the sender's guest name. It listens on this computer only.
 *
 *   pnpm socket-server          # ws://localhost:4318
 *   pnpm socket-server 9000     # another port
 */
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? process.env.PORT ?? 4318);
const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 64 * 1024 });
let next = 1;

server.on("connection", (socket) => {
  const name = `guest-${next++}`;
  socket.send(`Welcome, ${name}. ${server.clients.size} connected. What you send goes to everyone here.`);
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = `${name}: ${data.toString()}`;
    for (const client of server.clients) if (client.readyState === 1) client.send(text);
  });
});

server.on("listening", () => console.log(`Clasp socket server: ws://localhost:${port} — a chat relay on this computer. Ctrl+C to stop.`));
server.on("error", (error) => {
  console.error(`Could not start the socket server: ${error.message}`);
  process.exit(1);
});
