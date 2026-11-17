import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentContext, ComponentDefinition } from "@clasp/runtime";
import { CellError, display, evaluateSheet } from "./formula";
import { VISIBLE, asNumber, asRows, asText } from "./helpers";
import { countWords, parseMarkdown } from "./markdown";

/**
 * Everyday tools: a calculator, a code editor, a word processor, a clock and
 * a board. Like every component they hold state and rules; drawing is the
 * renderer's job.
 */

// ── calculator ───────────────────────────────────────────────────────────

const CALCULATOR_KEYS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "−", "×", "÷", "%", "(", ")", "=", "C", "⌫", "±"]);
const OPERATORS = new Set(["+", "−", "×", "÷"]);

/** Evaluates calculator notation with the spreadsheet formula engine — never `eval`. */
export function calculate(expression: string): number | string {
  const formula = expression.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/(\d+(?:\.\d+)?)%/g, "($1/100)");
  if (formula.trim() === "") return 0;
  const result = evaluateSheet({ A1: `=${formula}` }).A1;
  if (result instanceof CellError) return result.code === "#DIV/0!" ? "Cannot divide by zero" : "Error";
  if (typeof result === "number") return Number.isFinite(result) ? Number(result.toPrecision(12)) : "Error";
  return "Error";
}

function formatResult(value: number | string): string {
  return typeof value === "number" ? display(value) : value;
}

const calculator: ComponentDefinition = {
  type: "ui.calculator",
  version: 1,
  category: "interface",
  title: "Calculator",
  description: 'A calculator with a keypad (+ − × ÷ %, brackets). "value" is the latest result; "history" lists past calculations.',
  properties: [{ name: "keepHistory", type: "number", default: 20, title: "Calculations to keep" }],
  inputs: [VISIBLE],
  outputs: [
    { name: "display", type: "string", description: "What the screen shows." },
    { name: "expression", type: "string" },
    { name: "value", type: "number", description: "The latest result." },
    { name: "history", type: "records", description: "Past calculations: { expression, result }, newest first." },
  ],
  events: [{ name: "calculated", payload: "object", description: "{ expression, result }" }],
  actions: [
    { name: "clear" },
    { name: "set", payload: "number", description: "Puts a number on the screen." },
  ],
  create: (ctx) => {
    const publish = (): void => {
      const expression = ctx.getState<string>("expression") ?? "";
      const shown = ctx.getState<string>("shown");
      ctx.setOutput("expression", expression);
      ctx.setOutput("display", shown ?? (expression || "0"));
      ctx.setOutput("value", ctx.getState<number>("value") ?? 0);
      ctx.setOutput("history", ctx.getState<JsonObject[]>("history") ?? []);
    };
    const set = (expression: string, shown?: string): void => {
      ctx.setState("expression", expression.slice(0, 200));
      ctx.setState("shown", shown);
    };
    const press = (key: string): void => {
      if (!CALCULATOR_KEYS.has(key)) return;
      const expression = ctx.getState<string>("expression") ?? "";
      const fresh = ctx.getState<boolean>("fresh") === true; // the screen shows a result
      ctx.setState("fresh", false);
      if (key === "C") set("");
      else if (key === "⌫") set(fresh ? "" : expression.slice(0, -1));
      else if (key === "±") set(expression ? `−(${expression})` : "");
      else if (key === "=") {
        if (!expression) return;
        const result = calculate(expression);
        const text = formatResult(result);
        if (typeof result === "number") {
          ctx.setState("value", result);
          const seq = (ctx.getState<number>("seq") ?? 0) + 1;
          ctx.setState("seq", seq);
          const keep = Math.max(1, Math.min(200, asNumber(ctx.props.keepHistory) ?? 20));
          ctx.setState("history", [{ id: `calc-${seq}`, expression, result, title: `${expression} = ${text}` }, ...(ctx.getState<JsonObject[]>("history") ?? [])].slice(0, keep));
          set(text, text);
          ctx.setState("fresh", true);
          publish();
          ctx.emit("calculated", { expression, result });
          return;
        }
        set("", text);
      } else if (fresh && !OPERATORS.has(key) && key !== "%") {
        set(key); // a digit after a result starts over
      } else {
        const last = expression.slice(-1);
        set(OPERATORS.has(key) && OPERATORS.has(last) ? expression.slice(0, -1) + key : expression + key);
      }
      publish();
    };
    publish();
    return {
      actions: {
        clear: () => {
          set("");
          publish();
        },
        set: (payload) => {
          const value = asNumber(payload);
          if (value === undefined) return;
          set(display(value));
          ctx.setState("fresh", true);
          publish();
        },
      },
      interactions: {
        key: (payload) => press(asText(payload)),
        keys: (payload) => {
          for (const key of asText(payload)) press(key);
        },
      },
    };
  },
};

// ── text editors ─────────────────────────────────────────────────────────

/** A text document editor: "value" is the text, "changed" reports edits, "set" loads a document. */
function textEditor(ctx: ComponentContext, extra: (text: string) => void): Record<string, (payload: JsonValue | undefined) => void> {
  const write = (text: string, announce: boolean): void => {
    ctx.setState("text", text);
    ctx.setOutput("value", text);
    ctx.setOutput("characters", text.length);
    ctx.setOutput("words", countWords(text));
    ctx.setOutput("lines", text === "" ? 1 : text.split("\n").length);
    extra(text);
    if (announce) ctx.emit("changed", text);
  };
  write(ctx.getState<string>("text") ?? asText(ctx.props.value), false);
  return {
    set: (payload) => write(asText(payload), false),
    clear: () => write("", false),
    input: (payload) => write(asText(payload), true),
  };
}

const TEXT_OUTPUTS = [
  { name: "value", type: "string" as const, description: "The text." },
  { name: "characters", type: "number" as const },
  { name: "words", type: "number" as const },
  { name: "lines", type: "number" as const },
];

const codeEditor: ComponentDefinition = {
  type: "ui.codeEditor",
  version: 1,
  category: "interface",
  title: "Code editor",
  description: 'A plain-text editor for code and notes: monospaced, line numbers, Tab indents. "value" is the text; connect it to a document\'s "content" to open and save files.',
  properties: [
    { name: "value", type: "text", title: "Initial text" },
    { name: "tabSize", type: "enum", options: ["2", "4"], default: "2", title: "Tab width" },
    { name: "wrap", type: "boolean", default: false, title: "Wrap long lines" },
    { name: "placeholder", type: "string", title: "Placeholder" },
  ],
  inputs: [VISIBLE],
  outputs: TEXT_OUTPUTS,
  events: [{ name: "changed", payload: "string", description: "The user edited the text." }],
  actions: [
    { name: "set", payload: "string", description: "Replaces the text." },
    { name: "clear" },
  ],
  create: (ctx) => {
    const handlers = textEditor(ctx, () => undefined);
    return { actions: { set: handlers.set!, clear: handlers.clear! }, interactions: { input: handlers.input! } };
  },
};

const richText: ComponentDefinition = {
  type: "ui.richText",
  version: 1,
  category: "interface",
  title: "Word processor",
  description:
    'Writing with formatting — headings, bold, italic, lists, quotes, links — shown as a page as you type. The text is stored as Markdown in "value"; connect it to a document\'s "content" to open and save files.',
  properties: [
    { name: "value", type: "text", title: "Initial text" },
    { name: "placeholder", type: "string", default: "Start writing…", title: "Placeholder" },
  ],
  inputs: [VISIBLE],
  outputs: [...TEXT_OUTPUTS, { name: "blocks", type: "list", description: "The document as headings, paragraphs and lists, for display." }],
  events: [{ name: "changed", payload: "string", description: "The user edited the text." }],
  actions: [
    { name: "set", payload: "string", description: "Replaces the text (Markdown)." },
    { name: "clear" },
  ],
  create: (ctx) => {
    const handlers = textEditor(ctx, (text) => ctx.setOutput("blocks", parseMarkdown(text) as unknown as JsonValue));
    return { actions: { set: handlers.set!, clear: handlers.clear! }, interactions: { input: handlers.input! } };
  },
};

// ── clock ────────────────────────────────────────────────────────────────

function pad(value: number, width = 2): string {
  return String(Math.floor(value)).padStart(width, "0");
}

/** 3725000 → "1:02:05", 65000 → "01:05"; with tenths for a stopwatch. */
export function formatDuration(ms: number, tenths = false): string {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  return tenths ? `${base}.${Math.floor((total % 1000) / 100)}` : base;
}

const clock: ComponentDefinition = {
  type: "ui.clock",
  version: 1,
  category: "interface",
  title: "Clock",
  description: 'A clock, stopwatch (with laps) or countdown timer. The timer emits "finished" when it reaches zero.',
  properties: [
    { name: "mode", type: "enum", options: ["clock", "stopwatch", "timer"], default: "clock", title: "Mode" },
    { name: "minutes", type: "number", default: 5, title: "Timer length (minutes)" },
  ],
  inputs: [VISIBLE],
  outputs: [
    { name: "display", type: "string", description: "What the face shows." },
    { name: "running", type: "boolean" },
    { name: "elapsed", type: "number", description: "Milliseconds counted (stopwatch) or left (timer)." },
    { name: "laps", type: "records", description: "Stopwatch laps, newest first." },
    { name: "mode", type: "string" },
  ],
  events: [
    { name: "finished", description: "The timer reached zero." },
    { name: "lap", payload: "object" },
  ],
  actions: [
    { name: "start" },
    { name: "stop" },
    { name: "reset" },
    { name: "lap" },
    { name: "mode", payload: "string", description: "Switches to clock, stopwatch or timer." },
    { name: "minutes", payload: "number", description: "Sets the timer length." },
  ],
  create: (ctx) => {
    const mode = (): string => ctx.getState<string>("mode") ?? asText(ctx.props.mode, "clock");
    const length = (): number => Math.max(1000, Math.round((ctx.getState<number>("minutes") ?? asNumber(ctx.props.minutes) ?? 5) * 60_000));
    /** Milliseconds counted so far, including the current run. */
    const counted = (): number => {
      const base = ctx.getState<number>("counted") ?? 0;
      const since = ctx.getState<number>("since");
      return since === undefined ? base : base + (Date.now() - since);
    };
    let stopTicking: (() => void) | undefined;
    const publish = (): void => {
      const current = mode();
      const running = ctx.getState<number>("since") !== undefined;
      ctx.setOutput("mode", current);
      ctx.setOutput("running", current !== "clock" && running);
      ctx.setOutput("laps", ctx.getState<JsonObject[]>("laps") ?? []);
      if (current === "clock") {
        const now = new Date();
        ctx.setOutput("display", `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
        ctx.setOutput("elapsed", 0);
      } else if (current === "stopwatch") {
        ctx.setOutput("display", formatDuration(counted(), true));
        ctx.setOutput("elapsed", counted());
      } else {
        const left = Math.max(0, length() - counted());
        ctx.setOutput("display", formatDuration(Math.ceil(left / 1000) * 1000));
        ctx.setOutput("elapsed", left);
        if (running && left === 0) {
          stop();
          ctx.setState("counted", length());
          ctx.emit("finished");
        }
      }
    };
    const tick = (): void => {
      stopTicking?.();
      const running = ctx.getState<number>("since") !== undefined;
      stopTicking = mode() === "clock" ? ctx.setInterval(publish, 1000) : running ? ctx.setInterval(publish, 100) : undefined;
    };
    const stop = (): void => {
      if (ctx.getState<number>("since") === undefined) return;
      ctx.setState("counted", counted());
      ctx.setState("since", undefined);
      tick();
    };
    const start = (): void => {
      if (mode() === "clock" || ctx.getState<number>("since") !== undefined) return;
      if (mode() === "timer" && counted() >= length()) ctx.setState("counted", 0);
      ctx.setState("since", Date.now());
      tick();
      publish();
    };
    const reset = (): void => {
      ctx.setState("since", undefined);
      ctx.setState("counted", 0);
      ctx.setState("laps", []);
      tick();
      publish();
    };
    const actions = {
      start,
      stop: () => {
        stop();
        publish();
      },
      reset,
      lap: () => {
        if (mode() !== "stopwatch" || ctx.getState<number>("since") === undefined) return;
        const laps = ctx.getState<JsonObject[]>("laps") ?? [];
        const at = counted();
        const previous = laps.length > 0 ? Number(laps[0]?.at ?? 0) : 0;
        const lap = { id: `lap-${laps.length + 1}`, title: `Lap ${laps.length + 1}`, subtitle: formatDuration(at - previous, true), at };
        ctx.setState("laps", [lap, ...laps]);
        publish();
        ctx.emit("lap", lap);
      },
      mode: (payload: JsonValue | undefined) => {
        const next = asText(payload);
        if (!["clock", "stopwatch", "timer"].includes(next) || next === mode()) return;
        ctx.setState("mode", next);
        reset();
      },
      minutes: (payload: JsonValue | undefined) => {
        const value = asNumber(payload);
        if (value === undefined || value <= 0) return;
        ctx.setState("minutes", Math.min(24 * 60, value));
        reset();
      },
    };
    return {
      start: () => {
        tick();
        publish();
      },
      actions,
      interactions: actions,
      dispose: () => stopTicking?.(),
    };
  },
};

// ── board ────────────────────────────────────────────────────────────────

function columnsOf(value: JsonValue | undefined): string[] {
  const list = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
  return list.length > 0 ? list : ["To do", "Doing", "Done"];
}

const board: ComponentDefinition = {
  type: "ui.board",
  version: 1,
  category: "interface",
  title: "Board",
  description:
    'Cards in columns by a field (a kanban board). Moving a card emits "change" with { id, <field>: column } — connect it to a collection\'s "update"; removing emits "remove".',
  properties: [
    { name: "groupField", type: "field", default: "status", title: "Column field" },
    { name: "columns", type: "list", default: ["To do", "Doing", "Done"], title: "Columns" },
    { name: "titleField", type: "field", default: "title", title: "Title field" },
    { name: "subtitleField", type: "field", title: "Subtitle field" },
    { name: "removable", type: "boolean", default: true, title: "Allow removing" },
  ],
  inputs: [{ name: "items", type: "records", description: "The cards." }, VISIBLE],
  outputs: [
    { name: "counts", type: "object", description: "Cards per column." },
    { name: "count", type: "number" },
  ],
  events: [
    { name: "change", payload: "record", description: "A card moved: { id, <field>: column }." },
    { name: "remove", payload: "record" },
  ],
  actions: [],
  create: (ctx) => {
    const field = (): string => asText(ctx.props.groupField, "status");
    const sync = (): void => {
      const columns = columnsOf(ctx.props.columns);
      const counts: JsonObject = Object.fromEntries(columns.map((column) => [column, 0]));
      const rows = asRows(ctx.input("items"));
      for (const row of rows) {
        const column = columns.includes(asText(row[field()])) ? asText(row[field()]) : (columns[0] as string);
        counts[column] = (counts[column] as number) + 1;
      }
      ctx.setOutput("counts", counts);
      ctx.setOutput("count", rows.length);
    };
    sync();
    return {
      onInput: sync,
      interactions: {
        move: (payload) => {
          if (!isJsonObject(payload) || typeof payload.id !== "string") return;
          const column = asText(payload.column);
          if (!columnsOf(ctx.props.columns).includes(column)) return;
          const row = asRows(ctx.input("items")).find((candidate) => candidate.id === payload.id);
          if (!row || row[field()] === column) return;
          ctx.emit("change", { id: payload.id, [field()]: column });
        },
        remove: (payload) => {
          if (ctx.props.removable === false || !isJsonObject(payload) || typeof payload.id !== "string") return;
          const row = asRows(ctx.input("items")).find((candidate) => candidate.id === payload.id);
          if (row) ctx.emit("remove", row);
        },
      },
    };
  },
};

export const toolPrimitives: ComponentDefinition[] = [calculator, codeEditor, richText, clock, board];
