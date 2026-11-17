import type { JsonValue } from "@clasp/core";

/**
 * The feature vocabulary: how a person (or a model) describes an application
 * by what it does. Nothing here mentions components, ports or connections —
 * the compiler decides those.
 */

export type FieldKind = "text" | "longtext" | "number" | "boolean" | "date" | "choice";

export const FIELD_KINDS: readonly FieldKind[] = ["text", "longtext", "number", "boolean", "date", "choice"];

export interface FieldSpec {
  name: string;
  type: FieldKind;
  required?: boolean;
  /** Allowed values, for `choice`. */
  options?: string[];
  label?: string;
}

/** A kind of record the application keeps, e.g. "Recipe". */
export interface EntitySpec {
  name: string;
  plural?: string;
  /** For built-in entities (Task, Note, …) list only the fields to add. */
  fields?: FieldSpec[];
}

interface Named {
  /** Optional name for the main object the feature creates. */
  name?: string;
}

export type FeatureSpec =
  | (Named & { kind: "title"; text: string; subtitle?: string })
  | (Named & { kind: "add"; entity: string; fields?: string[]; button?: string })
  | (Named & { kind: "list"; entity: string; display?: "list" | "table"; fields?: string[]; toggle?: string; editable?: boolean; removable?: boolean })
  | (Named & { kind: "search"; entity: string; field?: string })
  | (Named & { kind: "filter"; entity: string; field: string; value?: JsonValue; options?: Array<{ label: string; value: JsonValue }> })
  | (Named & { kind: "sort"; entity: string; field: string; direction?: "asc" | "desc" })
  | (Named & { kind: "count"; entity: string; label?: string; where?: { field: string; value: JsonValue } })
  | (Named & { kind: "share"; entity: string })
  | (Named & { kind: "calendar"; entity: string; field?: string })
  | (Named & { kind: "board"; entity: string; field?: string; columns?: string[] })
  | (Named & { kind: "tool"; tool: ToolName; scores?: boolean })
  | (Named & { kind: "document"; editor: DocumentEditor; files?: boolean; title?: string });

export type FeatureKind = FeatureSpec["kind"];

/**
 * Ready-made instruments: one component that is the whole thing. People ask
 * for "a calculator" or "a game of pairs"; these are what they mean, not
 * something assembled from records and lists.
 */
export const TOOLS = {
  calculator: { type: "ui.calculator", properties: {}, width: "narrow", noun: "A calculator with a keypad and history" },
  clock: { type: "ui.clock", properties: { mode: "clock" }, width: "narrow", noun: "A clock (it can also be a stopwatch or a timer)" },
  stopwatch: { type: "ui.clock", properties: { mode: "stopwatch" }, width: "narrow", noun: "A stopwatch with laps" },
  timer: { type: "ui.clock", properties: { mode: "timer" }, width: "narrow", noun: "A countdown timer" },
  terminal: { type: "ui.terminal", properties: {}, width: "wide", noun: "A command line for the workspace" },
  "system-monitor": { type: "ui.systemMonitor", properties: {}, width: "wide", noun: "Live graphs of how the workspace and this browser tab are doing" },
  "tic-tac-toe": { type: "game.ticTacToe", properties: {}, width: "regular", noun: "Tic-tac-toe against the computer", game: true },
  pairs: { type: "game.pairs", properties: {}, width: "regular", noun: "A memory game of matching pairs", game: true },
  "word-guess": { type: "game.wordGuess", properties: {}, width: "regular", noun: "A word-guessing game", game: true },
  glowworm: { type: "game.glowworm", properties: {}, width: "regular", noun: "An arcade game: steer a glowworm to eat sparks", game: true },
} as const satisfies Record<string, { type: string; properties: Record<string, string>; width: "narrow" | "regular" | "wide"; noun: string; game?: boolean }>;

export type ToolName = keyof typeof TOOLS;

export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export type DocumentEditor = "text" | "richtext" | "code" | "spreadsheet" | "drawing" | "sequencer";

export const DOCUMENT_EDITORS: readonly DocumentEditor[] = ["text", "richtext", "code", "spreadsheet", "drawing", "sequencer"];

/** A whole description: what to build or what to add. */
export interface FeaturePlan {
  summary?: string;
  /** Title of the application's window, for new applications. */
  title?: string;
  subtitle?: string;
  entities?: EntitySpec[];
  features?: FeatureSpec[];
}

/** Model- and human-readable reference for the vocabulary above. */
export const FEATURE_REFERENCE = `entities — the kinds of records the application keeps:
  {"name": "Recipe", "fields": [{"name": "title", "type": "text", "required": true}, {"name": "servings", "type": "number"}, {"name": "vegetarian", "type": "boolean"}, {"name": "course", "type": "choice", "options": ["starter", "main", "dessert"]}]}
  Field types: text, longtext, number, boolean, date, choice.
  Built-in entities already have fields: Task, Note, Contact, Event, Project, Document (see RECORD SCHEMAS). For those, list only fields you are adding.

features — what the application does:
  {"kind": "title", "text": "Recipe Box", "subtitle": "Everything I like to cook"}  sets the window title
  {"kind": "add", "entity": "Recipe", "fields": ["title", "servings"], "button": "Add recipe"}  a form that creates records ("fields" optional)
  {"kind": "list", "entity": "Recipe", "display": "list" or "table", "toggle": "<a boolean field shown as a checkbox>"}  shows records; people can edit and remove them
  {"kind": "search", "entity": "Recipe", "field": "title"}  a search box over the list
  {"kind": "filter", "entity": "Recipe", "field": "vegetarian"}  tabs that filter the list by a boolean or choice field
  {"kind": "filter", "entity": "Task", "field": "completed", "value": false}  a fixed filter: the list only ever shows matching records
  {"kind": "sort", "entity": "Recipe", "field": "title", "direction": "asc"}
  {"kind": "count", "entity": "Recipe", "label": "vegetarian recipes", "where": {"field": "vegetarian", "value": true}}  shows how many records there are
  {"kind": "share", "entity": "Recipe"}  lets other applications discover the records (they still need the user's permission to read them)
  {"kind": "calendar", "entity": "Event", "field": "start"}  a month calendar showing records on their dates; clicking a day prefills the add form's date
  For calendars, schedules or appointments use the built-in Event entity (title, start, end, location) with "add", "calendar" and "list".
  {"kind": "tool", "tool": "calculator"}  a ready-made instrument, complete in itself. tool is one of: calculator, clock, stopwatch, timer, terminal, system-monitor, and the games tic-tac-toe, pairs (a memory game), word-guess, glowworm (a snake-like arcade game). Games keep a high-score list. Use this whenever the request names one of these; never imitate them with entities, lists or editors.
  {"kind": "board", "entity": "Card", "field": "status"}  a kanban board: cards in columns by a choice field (its options are the columns); people drag cards between columns
  {"kind": "document", "editor": "text" | "richtext" | "code" | "spreadsheet" | "drawing" | "sequencer", "files": true}  a document editor; with "files", New / Open / Save / Save As. richtext is a word processor (headings, bold, lists); code is a monospaced editor with line numbers
Every feature may also carry "name" to name what it creates.`;
