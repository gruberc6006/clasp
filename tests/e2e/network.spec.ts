import type { WebSocketRoute } from "@playwright/test";
import { expect, fromTemplate, openApp, part, test, win } from "./helpers";

/**
 * Socket Chat in the browser. The page's WebSocket is real; Playwright plays
 * the server at ws://localhost:4318 (the address `pnpm socket-server` uses),
 * so the test needs no server process.
 */
test("Socket Chat: asks before connecting, talks to the server, and revoking cuts it off", async ({ page }) => {
  const servers: WebSocketRoute[] = [];
  await page.routeWebSocket(/^ws:\/\/localhost:4318\/?$/, (server) => {
    servers.push(server);
    server.send("Welcome, guest-1.");
    server.onMessage((message) => server.send(`guest-1: ${String(message)}`));
  });

  await page.goto("/");
  await fromTemplate(page, "Socket Chat");
  await page.getByRole("tab", { name: "Use", exact: true }).click();
  const chat = win(page, "Socket Chat");
  await expect(part(chat, "Status")).toHaveText("Not connected");

  // 1. Connecting asks first — and saying no connects to nothing.
  await chat.getByRole("button", { name: "Connect", exact: true }).click();
  const prompt = page.getByTestId("permission-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "network");
  await expect(prompt).toContainText("Allow “Socket Chat” to connect to localhost:4318?");
  await expect(prompt).toContainText("This is a server on your own computer.");
  await expect(prompt).toContainText("Not encrypted (ws://)");
  await page.getByTestId("permission-deny").click();
  await expect(part(chat, "Status")).toContainText("not allowed to connect to localhost:4318");
  expect(servers).toHaveLength(0);

  // 2. Asking again and allowing connects.
  await chat.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByTestId("permission-allow").click();
  await expect(part(chat, "Status")).toHaveText("Connected to localhost:4318");
  await expect(part(chat, "Messages")).toContainText("Welcome, guest-1.");

  // 3. Messages go both ways.
  await chat.getByPlaceholder("Type a message").fill("hello there");
  await chat.getByPlaceholder("Type a message").press("Enter");
  await expect(part(chat, "Messages")).toContainText("guest-1: hello there");
  await expect(chat.getByPlaceholder("Type a message")).toHaveValue("");
  servers[0]?.send("someone else joined");
  await expect(part(chat, "Messages")).toContainText("someone else joined");

  // 4. The Permissions view shows the host and the live connection; revoking closes it.
  await page.getByTestId("nav-permissions").click();
  const card = page.locator('[data-testid="permission-card"][data-app="Socket Chat"]');
  const grant = card.locator('[data-testid="grant-row"][data-resource="localhost:4318"]');
  await expect(grant).toContainText("Connect to localhost:4318");
  await expect(grant).toContainText("1 open connection");
  await grant.getByTestId("revoke-grant").click();
  await expect(card.getByTestId("no-grants")).toBeVisible();

  await openApp(page, "Socket Chat");
  await expect(part(chat, "Status")).toHaveText("Disconnected: Permission revoked");
  await chat.getByPlaceholder("Type a message").fill("anyone?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(part(chat, "Messages")).not.toContainText("guest-1: anyone?");
});
