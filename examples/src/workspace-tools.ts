import { GraphBuilder, applyOperations, createGraph, type ClaspGraph, type TypeCatalog } from "@clasp/core";
import { compileFeatures, type FeaturePlan } from "@clasp/features";
import { DESKTOP_SERVICE_ID, FILE_STORE_ID, documentFeature } from "@clasp/files";
import type { ComponentRegistry } from "@clasp/runtime";
import { createSchemaRegistry, type SchemaDefinition } from "@clasp/schemas";

/**
 * Everyday workspace tools and small games, each an ordinary application:
 * a graph of registered components that you can open in Build mode and change.
 */

export type TemplateCategory = "Productivity" | "Tools" | "Creative" | "Games" | "Examples";

export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Builds a fresh graph (new identities every time). */
  build(catalog?: TypeCatalog): ClaspGraph;
  /** Kinds of record the application defines; registered before it is installed. */
  schemas?(catalog?: TypeCatalog): SchemaDefinition[];
}

function compile(name: string, description: string, plan: FeaturePlan, registry: ComponentRegistry): { graph: ClaspGraph; schemas: SchemaDefinition[] } {
  const graph = createGraph({ name, description });
  const compiled = compileFeatures(plan, { graph, registry, schemas: createSchemaRegistry() }, [documentFeature]);
  if (compiled.issues.length > 0) throw new Error(`${name}: ${compiled.issues.join(" ")}`);
  return { graph: applyOperations(graph, compiled.operations, { catalog: registry }).graph, schemas: compiled.schemas };
}

/** A template described only by its features — compiled by the same compiler the AI uses. */
export function featureTemplate(entry: { id: string; name: string; description: string; category: TemplateCategory; plan: FeaturePlan }): AppTemplate {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    build: (catalog) => compile(entry.name, entry.description, entry.plan, catalog as ComponentRegistry).graph,
    schemas: (catalog) => compile(entry.name, entry.description, entry.plan, catalog as ComponentRegistry).schemas,
  };
}

/** One component in a window — tools that are a single, complete instrument. */
function single(name: string, description: string, type: string, window: { subtitle: string; width: "narrow" | "regular" | "wide" }, properties: Record<string, unknown> = {}) {
  return (catalog?: TypeCatalog): ClaspGraph => {
    const b = new GraphBuilder(name, { description });
    const win = b.add("ui.window", { name: "Window", properties: { title: name, subtitle: window.subtitle, width: window.width } });
    b.add(type, { name, parent: win, properties: properties as never });
    return b.build(catalog);
  };
}

// ── File Browser ─────────────────────────────────────────────────────────

/**
 * Lists the workspace's files and opens them in the right application. It
 * needs two permissions, both asked for when first used: to read the list of
 * files, and to ask the desktop to open one.
 */
export function buildFileBrowser(catalog?: TypeCatalog): ClaspGraph {
  const b = new GraphBuilder("File Browser", { description: "Every file in the workspace: search, filter by kind, and open each in its application." });
  const files = b.add("data.reference", {
    name: "Workspace files",
    properties: { collectionId: FILE_STORE_ID, reason: "List your files so you can find and open them." },
  });
  const window = b.add("ui.window", { name: "Window", properties: { title: "File Browser", subtitle: "Every file in this workspace.", width: "wide" } });

  // Until the user allows it, explain and offer to ask.
  const isConnected = b.add("logic.compare", { name: "Has access", properties: { operator: "eq", b: "connected" } });
  const notConnected = b.add("logic.boolean", { name: "Has no access", properties: { operation: "not" } });
  b.connect(`${files}.status`, `${isConnected}.a`);
  b.connect(`${isConnected}.result`, `${notConnected}.a`);
  const ask = b.add("ui.container", { name: "Access panel", parent: window, properties: { surface: "card", gap: "small" } });
  b.connect(`${notConnected}.result`, `${ask}.visible`);
  b.add("ui.text", {
    name: "Access explanation",
    parent: ask,
    properties: { text: "The File Browser needs your permission to list the files in this workspace.", variant: "body" },
  });
  const allow = b.add("ui.button", { name: "Allow button", parent: ask, properties: { label: "Show my files", variant: "primary" } });
  b.connect(`${allow}.click`, `${files}.requestAccess`);

  const browser = b.add("ui.container", { name: "Browser", parent: window, properties: { gap: "small" } });
  b.connect(`${isConnected}.result`, `${browser}.visible`);
  const bar = b.add("ui.container", { name: "Search bar", parent: browser, properties: { direction: "row", gap: "small", align: "center" } });
  const search = b.add("ui.textInput", { name: "Search", parent: bar, properties: { placeholder: "Search files" } });
  const tabs = b.add("ui.tabs", {
    name: "Kind tabs",
    parent: bar,
    properties: {
      options: [
        { label: "All", value: null },
        { label: "Text", value: "text" },
        { label: "Documents", value: "richtext" },
        { label: "Sheets", value: "spreadsheet" },
        { label: "Drawings", value: "drawing" },
        { label: "Beats", value: "sequencer" },
      ],
    },
  });
  const byName = b.add("data.filter", { name: "Name search", properties: { field: "name", operator: "contains", value: "" } });
  const byKind = b.add("data.filter", { name: "Kind filter", properties: { field: "kind", operator: "eq" } });
  const sorted = b.add("data.sort", { name: "By name", properties: { field: "name", direction: "asc" } });
  const table = b.add("ui.table", {
    name: "File table",
    parent: browser,
    properties: {
      columns: [
        { field: "name", label: "Name" },
        { field: "kind", label: "Kind" },
        { field: "size", label: "Size (bytes)" },
      ],
      actionLabel: "Open",
      emptyText: "No files match.",
    },
  });
  const count = b.add("ui.text", { name: "File count", parent: browser, properties: { text: "{value} files", variant: "muted" } });
  const open = b.add("workflow.invoke", {
    name: "Open in application",
    properties: { target: DESKTOP_SERVICE_ID, action: "open", reason: "Open the files you choose in their applications." },
  });

  b.connect(`${files}.records`, `${byName}.records`);
  b.connect(`${search}.value`, `${byName}.value`);
  b.connect(`${byName}.records`, `${byKind}.records`);
  b.connect(`${tabs}.value`, `${byKind}.value`);
  b.connect(`${byKind}.records`, `${sorted}.records`);
  b.connect(`${sorted}.records`, `${table}.rows`);
  b.connect(`${table}.count`, `${count}.value`);
  b.connect(`${table}.rowAction`, `${open}.run`);
  return b.build(catalog);
}

// ── games ────────────────────────────────────────────────────────────────

/** A game in a window with its own high-score list (a clasp.score collection). */
function game(name: string, description: string, type: string, subtitle: string, properties: Record<string, unknown> = {}) {
  return (catalog?: TypeCatalog): ClaspGraph => {
    const b = new GraphBuilder(name, { description });
    const scores = b.add("data.collection", { name: "Scores", properties: { schema: "clasp.score" } });
    const window = b.add("ui.window", { name: "Window", properties: { title: name, subtitle, width: "regular" } });
    const play = b.add(type, { name: "Game", parent: window, properties: properties as never });
    const best = b.add("data.sort", { name: "Best first", properties: { field: "score", direction: "desc" } });
    b.add("ui.text", { name: "Scores heading", parent: window, properties: { text: "High scores", variant: "heading" } });
    const list = b.add("ui.list", {
      name: "High scores",
      parent: window,
      properties: { titleField: "summary", subtitleField: "playedOn", removable: true, emptyText: "Finish a game to get on the board." },
    });
    b.connect(`${play}.finished`, `${scores}.create`);
    b.connect(`${scores}.records`, `${best}.records`);
    b.connect(`${best}.records`, `${list}.items`);
    b.connect(`${list}.remove`, `${scores}.delete`);
    b.exposeEvent("finished", `${play}.finished`, "A game ended: { game, score, won, summary, playedOn }");
    return b.build(catalog);
  };
}

export const TOOL_TEMPLATES: AppTemplate[] = [
  featureTemplate({
    id: "word-processor",
    name: "Word Processor",
    description: "Write with headings, bold, italic, lists and quotes, seen as a page as you type. Opens and saves documents.",
    category: "Productivity",
    plan: { title: "Word Processor", features: [{ kind: "document", editor: "richtext", files: true, title: "Untitled document" }] },
  }),
  featureTemplate({
    id: "text-editor",
    name: "Text Editor",
    description: "A plain-text and code editor with line numbers. Opens and saves text files.",
    category: "Productivity",
    plan: { title: "Text Editor", features: [{ kind: "document", editor: "code", files: true, title: "untitled.txt" }] },
  }),
  featureTemplate({
    id: "kanban",
    name: "Kanban Board",
    description: "Cards in To do, Doing and Done. Drag them between columns as work moves along.",
    category: "Productivity",
    plan: {
      title: "Kanban Board",
      subtitle: "Drag cards between columns.",
      entities: [
        {
          name: "Card",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "status", type: "choice", options: ["To do", "Doing", "Done"] },
          ],
        },
      ],
      features: [
        { kind: "add", entity: "Card", fields: ["title", "status"], button: "Add card" },
        { kind: "board", entity: "Card", field: "status" },
      ],
    },
  }),
  featureTemplate({
    id: "contacts",
    name: "Contacts",
    description: "People and organizations with email and phone, searchable. Other apps can ask to use them.",
    category: "Productivity",
    plan: {
      title: "Contacts",
      features: [
        { kind: "add", entity: "Contact", fields: ["name", "email", "phone", "organization"], button: "Add contact" },
        { kind: "search", entity: "Contact", field: "name" },
        { kind: "sort", entity: "Contact", field: "name" },
        { kind: "list", entity: "Contact", display: "table", fields: ["name", "email", "phone", "organization"] },
        { kind: "count", entity: "Contact", label: "contacts" },
        { kind: "share", entity: "Contact" },
      ],
    },
  }),
  featureTemplate({
    id: "journal",
    name: "Journal",
    description: "A dated journal with a mood for each day, on a calendar and in a searchable list.",
    category: "Productivity",
    plan: {
      title: "Journal",
      entities: [
        {
          name: "Entry",
          plural: "Entries",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "date", type: "date" },
            { name: "mood", type: "choice", options: ["great", "good", "okay", "low"] },
            { name: "text", type: "longtext" },
          ],
        },
      ],
      features: [
        { kind: "add", entity: "Entry", fields: ["title", "date", "mood", "text"], button: "Add entry" },
        { kind: "calendar", entity: "Entry", field: "date" },
        { kind: "search", entity: "Entry", field: "title" },
        { kind: "sort", entity: "Entry", field: "date", direction: "desc" },
        { kind: "list", entity: "Entry", fields: ["title", "date"], name: "Entries" },
      ],
    },
  }),
  {
    id: "terminal",
    name: "Terminal",
    description: "A command line for the workspace: discover, query, request access, notify, open files and talk over sockets. Type help.",
    category: "Tools",
    build: single("Terminal", "A command line for the workspace.", "ui.terminal", { subtitle: "Commands run with exactly the permissions you give this app.", width: "wide" }),
  },
  {
    id: "calculator",
    name: "Calculator",
    description: "A calculator with a keypad and history. Type with the keyboard too.",
    category: "Tools",
    build: single("Calculator", "A calculator with a keypad and history.", "ui.calculator", { subtitle: "", width: "narrow" }),
  },
  {
    id: "file-browser",
    name: "File Browser",
    description: "Every file in the workspace: search, filter by kind, open each in its application. Asks for permission first.",
    category: "Tools",
    build: buildFileBrowser,
  },
  {
    id: "system-monitor",
    name: "System Monitor",
    description: "Live graphs of this tab's main-thread load, memory, frame rate, storage and the workspace's activity.",
    category: "Tools",
    build: single("System Monitor", "How the workspace and this browser tab are doing.", "ui.systemMonitor", { subtitle: "Live, once a second.", width: "wide" }),
  },
  {
    id: "clock",
    name: "Clock",
    description: "A clock, a stopwatch with laps, and a countdown timer.",
    category: "Tools",
    build: single("Clock", "A clock, stopwatch and timer.", "ui.clock", { subtitle: "", width: "narrow" }),
  },
];

export const GAME_TEMPLATES: AppTemplate[] = [
  {
    id: "tic-tac-toe",
    name: "Tic-tac-toe",
    description: "Three in a row against the computer, at three levels. Keeps your record.",
    category: "Games",
    build: game("Tic-tac-toe", "Three in a row against the computer.", "game.ticTacToe", "You are X. Take turns starting."),
  },
  {
    id: "pairs",
    name: "Pairs",
    description: "Turn over cards two at a time and find every pair in as few moves as you can.",
    category: "Games",
    build: game("Pairs", "A memory game.", "game.pairs", "Find every matching pair."),
  },
  {
    id: "word-guess",
    name: "Word Guess",
    description: "Guess the hidden word a letter at a time before your six lives run out.",
    category: "Games",
    build: game("Word Guess", "Guess the hidden word.", "game.wordGuess", "Type letters or click them."),
  },
  {
    id: "glowworm",
    name: "Glowworm",
    description: "Steer a glowworm to eat sparks and grow longer — without hitting the walls or yourself.",
    category: "Games",
    build: game("Glowworm", "An arcade game.", "game.glowworm", "Arrow keys or WASD steer; Space pauses."),
  },
];
