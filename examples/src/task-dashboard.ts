import { GraphBuilder, type ClaspGraph, type TypeCatalog } from "@clasp/core";

/**
 * Task Dashboard — a live, read-only view of tasks owned by another application.
 *
 * It contains no collection of its own and no knowledge of the Task Manager.
 * It holds a `data.reference` asking for "a collection readable as
 * clasp.task": the user picks one from what the workspace lets it discover,
 * grants read access, and records start flowing through the Universal API.
 */
export function buildTaskDashboard(catalog?: TypeCatalog): ClaspGraph {
  const b = new GraphBuilder("Task Dashboard", { description: "A live overview of tasks shared by another application." });

  const source = b.add("data.reference", {
    name: "Task source",
    properties: { schema: "clasp.task", reason: "Show your tasks on the dashboard." },
  });

  const window = b.add("ui.window", {
    name: "Window",
    properties: { title: "Task Dashboard", subtitle: "A live view of tasks from another app.", width: "wide" },
  });

  // ── state derived from the reference ────────────────────────────────────
  const isConnected = b.add("logic.compare", { name: "Is connected", properties: { operator: "eq", b: "connected" } });
  const notConnected = b.add("logic.boolean", { name: "Is not connected", properties: { operation: "not" } });
  const hasSource = b.add("logic.compare", { name: "Has a source", properties: { operator: "truthy" } });
  const noSource = b.add("logic.boolean", { name: "Has no source", properties: { operation: "not" } });
  b.connect(`${source}.status`, `${isConnected}.a`);
  b.connect(`${isConnected}.result`, `${notConnected}.a`);
  b.connect(`${source}.source`, `${hasSource}.a`);
  b.connect(`${hasSource}.result`, `${noSource}.a`);

  // ── connect panel: shown until records are flowing ──────────────────────
  const connect = b.add("ui.container", { name: "Connect panel", parent: window, properties: { surface: "card", gap: "medium" } });
  b.connect(`${notConnected}.result`, `${connect}.visible`);
  b.add("ui.text", { name: "Connect heading", parent: connect, properties: { text: "Connect a task collection", variant: "heading" } });

  const pick = b.add("ui.container", { name: "Source picker", parent: connect, properties: { gap: "small" } });
  b.connect(`${noSource}.result`, `${pick}.visible`);
  b.add("ui.text", {
    name: "Picker hint",
    parent: pick,
    properties: { text: "Choose which collection of tasks this dashboard should show.", variant: "muted" },
  });
  const candidates = b.add("ui.list", {
    name: "Available sources",
    parent: pick,
    properties: {
      titleField: "name",
      subtitleField: "ownerName",
      selectable: true,
      emptyText: "No task collections are shared in this workspace yet.",
    },
  });
  const rescan = b.add("ui.button", { name: "Look again button", parent: pick, properties: { label: "Look again", variant: "ghost" } });
  b.connect(`${source}.candidates`, `${candidates}.items`);
  b.connect(`${candidates}.select`, `${source}.bind`);
  b.connect(`${rescan}.click`, `${source}.refresh`);

  const access = b.add("ui.container", { name: "Access request", parent: connect, properties: { gap: "small" } });
  b.connect(`${hasSource}.result`, `${access}.visible`);
  const accessText = b.add("ui.text", {
    name: "Access explanation",
    parent: access,
    properties: { text: "This dashboard needs permission to read “{name}” from {ownerName}.", variant: "body" },
  });
  b.connect(`${source}.source`, `${accessText}.value`);
  const accessRow = b.add("ui.container", { name: "Access buttons", parent: access, properties: { direction: "row", gap: "small" } });
  const request = b.add("ui.button", { name: "Request access button", parent: accessRow, properties: { label: "Request read access", variant: "primary" } });
  const change = b.add("ui.button", { name: "Choose another button", parent: accessRow, properties: { label: "Choose another", variant: "ghost" } });
  b.connect(`${request}.click`, `${source}.requestAccess`);
  b.connect(`${change}.click`, `${source}.unbind`);

  // ── dashboard: shown while connected ────────────────────────────────────
  const board = b.add("ui.container", { name: "Dashboard", parent: window, properties: { gap: "large" } });
  b.connect(`${isConnected}.result`, `${board}.visible`);

  const stats = b.add("ui.container", { name: "Stats", parent: board, properties: { direction: "row", gap: "medium" } });
  const stat = (name: string, caption: string, where?: boolean): void => {
    const count = b.add("data.aggregate", {
      name: `${name} count`,
      properties: where === undefined ? { operation: "count" } : { operation: "count", whereField: "completed", whereOperator: "eq", whereValue: where },
    });
    const card = b.add("ui.container", { name: `${name} card`, parent: stats, properties: { surface: "card", gap: "none" } });
    const label = b.add("ui.text", { name: `${name} stat`, parent: card, properties: { text: "{value}", variant: "stat", caption } });
    b.connect(`${source}.records`, `${count}.records`);
    b.connect(`${count}.value`, `${label}.value`);
  };
  stat("Total", "Total");
  stat("Active", "Active", false);
  stat("Completed", "Completed", true);

  const tabs = b.add("ui.tabs", {
    name: "Status tabs",
    parent: board,
    properties: {
      options: [
        { label: "All", value: null },
        { label: "Active", value: false },
        { label: "Completed", value: true },
      ],
    },
  });
  const filter = b.add("data.filter", { name: "Status filter", properties: { field: "completed", operator: "eq" } });
  const table = b.add("ui.table", {
    name: "Task table",
    parent: board,
    properties: {
      columns: [
        { field: "title", label: "Task" },
        { field: "completed", label: "Done" },
      ],
      emptyText: "No tasks match this filter.",
    },
  });
  b.connect(`${source}.records`, `${filter}.records`);
  b.connect(`${tabs}.value`, `${filter}.value`);
  b.connect(`${filter}.records`, `${table}.rows`);

  const origin = b.add("ui.text", { name: "Source label", parent: board, properties: { text: "Live from “{name}” · {ownerName}", variant: "muted" } });
  b.connect(`${source}.source`, `${origin}.value`);

  return b.build(catalog);
}
