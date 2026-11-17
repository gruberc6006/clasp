import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentContext, ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asNumber, asText } from "./helpers";
import { CellError, address, display, evaluateSheet, parseAddress } from "./formula";

/**
 * Document editors. Each keeps its document as plain JSON, exposes it as
 * "value", reports edits with "changed", and accepts a whole document through
 * "set" — which is all a data.document needs to open and save it as a file.
 * Rendering and sound are the renderer's job; these hold state and rules only.
 */

function documentEditor(ctx: ComponentContext, normalize: (value: JsonValue | undefined) => JsonObject) {
  const current = (): JsonObject => normalize(ctx.getState("document"));
  const write = (next: JsonObject, announce: boolean): void => {
    const document = normalize(next);
    ctx.setState("document", document);
    ctx.setOutput("value", document);
    if (announce) ctx.emit("changed", document);
  };
  write(current(), false);
  return { current, write };
}

const EDITOR_PORTS = {
  inputs: [VISIBLE],
  events: [{ name: "changed", payload: "object" as const, description: "The user edited the document. Payload: the document." }],
};

// ── spreadsheet ──────────────────────────────────────────────────────────

function normalizeSheet(value: JsonValue | undefined, rows: number, columns: number): JsonObject {
  const source = isJsonObject(value) ? value : {};
  const cells: Record<string, string> = {};
  if (isJsonObject(source.cells)) {
    for (const [ref, raw] of Object.entries(source.cells)) {
      if (typeof raw === "string" && raw !== "" && parseAddress(ref)) cells[ref.toUpperCase()] = raw;
    }
  }
  return {
    rows: Math.max(rows, asNumber(source.rows) ?? 0),
    columns: Math.max(columns, asNumber(source.columns) ?? 0),
    cells,
  };
}

const spreadsheet: ComponentDefinition = {
  type: "ui.spreadsheet",
  version: 1,
  category: "interface",
  title: "Spreadsheet",
  description:
    'A grid of cells with formulas (=SUM(A1:A5), =B2*C2, =IF(A1>10,"big","small"), …). "value" is the document { rows, columns, cells }; "values" holds the computed result of every filled cell.',
  properties: [
    { name: "rows", type: "number", default: 30, title: "Rows" },
    { name: "columns", type: "number", default: 10, title: "Columns" },
  ],
  inputs: EDITOR_PORTS.inputs,
  outputs: [
    { name: "value", type: "object", description: "The document: { rows, columns, cells: { A1: raw text } }." },
    { name: "values", type: "object", description: "Computed values by cell, e.g. { A1: 3 }." },
  ],
  events: EDITOR_PORTS.events,
  actions: [
    { name: "set", payload: "any", description: "Replaces the document (null starts an empty sheet)." },
    { name: "clear" },
  ],
  create: (ctx) => {
    const size = (): [number, number] => [Math.min(500, asNumber(ctx.props.rows) ?? 30), Math.min(52, asNumber(ctx.props.columns) ?? 10)];
    const editor = documentEditor(ctx, (value) => normalizeSheet(value, ...size()));
    const compute = (): void => {
      const cells = editor.current().cells as Record<string, string>;
      const values: JsonObject = {};
      for (const [ref, value] of Object.entries(evaluateSheet(cells))) values[ref] = value instanceof CellError ? display(value) : value;
      ctx.setOutput("values", values);
    };
    const write = (document: JsonObject, announce: boolean): void => {
      editor.write(document, announce);
      compute();
    };
    compute();
    return {
      actions: {
        set: (payload) => write(isJsonObject(payload) ? payload : {}, false),
        clear: () => write({}, true),
      },
      interactions: {
        edit: (payload) => {
          if (!isJsonObject(payload) || typeof payload.cell !== "string" || !parseAddress(payload.cell)) return;
          const document = editor.current();
          const cells = { ...(document.cells as Record<string, string>) };
          const raw = asText(payload.raw);
          const ref = payload.cell.toUpperCase();
          if ((cells[ref] ?? "") === raw) return;
          if (raw === "") delete cells[ref];
          else cells[ref] = raw;
          write({ ...document, cells }, true);
        },
        grow: (payload) => {
          const document = editor.current();
          const rows = isJsonObject(payload) && payload.rows === true ? (document.rows as number) + 10 : (document.rows as number);
          const columns = isJsonObject(payload) && payload.columns === true ? Math.min(52, (document.columns as number) + 1) : (document.columns as number);
          write({ ...document, rows, columns }, true);
        },
      },
    };
  },
};

// ── drawing ──────────────────────────────────────────────────────────────

function normalizeDrawing(value: JsonValue | undefined, width: number, height: number, background: string): JsonObject {
  const source = isJsonObject(value) ? value : {};
  const strokes = Array.isArray(source.strokes)
    ? source.strokes.filter(
        (stroke): stroke is JsonObject =>
          isJsonObject(stroke) && typeof stroke.color === "string" && typeof stroke.size === "number" && Array.isArray(stroke.points) && stroke.points.every((n) => typeof n === "number"),
      )
    : [];
  return {
    width: asNumber(source.width) ?? width,
    height: asNumber(source.height) ?? height,
    background: typeof source.background === "string" ? source.background : background,
    strokes,
  };
}

const canvas: ComponentDefinition = {
  type: "ui.canvas",
  version: 1,
  category: "interface",
  title: "Drawing canvas",
  description: 'A canvas to draw on with a pen, colours, sizes and an eraser. "value" is the drawing { width, height, background, strokes }.',
  properties: [
    { name: "width", type: "number", default: 960, title: "Width (px)" },
    { name: "height", type: "number", default: 600, title: "Height (px)" },
    { name: "background", type: "string", default: "#ffffff", title: "Background colour" },
  ],
  inputs: EDITOR_PORTS.inputs,
  outputs: [
    { name: "value", type: "object", description: "The drawing." },
    { name: "strokes", type: "number", description: "Number of strokes." },
  ],
  events: EDITOR_PORTS.events,
  actions: [
    { name: "set", payload: "any", description: "Replaces the drawing (null starts a blank one)." },
    { name: "clear" },
    { name: "undo", description: "Removes the last stroke." },
  ],
  create: (ctx) => {
    const editor = documentEditor(ctx, (value) =>
      normalizeDrawing(value, asNumber(ctx.props.width) ?? 960, asNumber(ctx.props.height) ?? 600, typeof ctx.props.background === "string" ? ctx.props.background : "#ffffff"),
    );
    const write = (document: JsonObject, announce: boolean): void => {
      editor.write(document, announce);
      ctx.setOutput("strokes", (editor.current().strokes as JsonValue[]).length);
    };
    ctx.setOutput("strokes", (editor.current().strokes as JsonValue[]).length);
    const undo = (announce: boolean): void => {
      const document = editor.current();
      const strokes = document.strokes as JsonValue[];
      if (strokes.length > 0) write({ ...document, strokes: strokes.slice(0, -1) }, announce);
    };
    const clear = (announce: boolean): void => write({ ...editor.current(), strokes: [] }, announce);
    return {
      actions: {
        set: (payload) => write(isJsonObject(payload) ? payload : {}, false),
        clear: () => clear(true),
        undo: () => undo(true),
      },
      interactions: {
        stroke: (payload) => {
          if (!isJsonObject(payload) || !Array.isArray(payload.points) || payload.points.length < 2) return;
          const points = payload.points.filter((n): n is number => typeof n === "number").map((n) => Math.round(n * 10) / 10);
          const stroke = { color: asText(payload.color, "#1c1b19"), size: asNumber(payload.size) ?? 4, points };
          const document = editor.current();
          write({ ...document, strokes: [...(document.strokes as JsonValue[]), stroke] }, true);
        },
        undo: () => undo(true),
        clear: () => clear(true),
      },
    };
  },
};

// ── music ────────────────────────────────────────────────────────────────

/** Voices the renderer knows how to synthesize. */
export const SEQUENCER_SOUNDS = ["kick", "snare", "hat", "clap", "bass", "chime"] as const;

function defaultTracks(steps: number): JsonObject[] {
  const pattern = (hits: number[]): boolean[] => Array.from({ length: steps }, (_unused, index) => hits.includes(index % 16));
  return [
    { name: "Kick", sound: "kick", steps: pattern([0, 8]) },
    { name: "Snare", sound: "snare", steps: pattern([4, 12]) },
    { name: "Hi-hat", sound: "hat", steps: pattern([2, 6, 10, 14]) },
    { name: "Clap", sound: "clap", steps: pattern([]) },
    { name: "Bass", sound: "bass", steps: pattern([0, 3, 8, 11]) },
    { name: "Chime", sound: "chime", steps: pattern([]) },
  ];
}

function normalizePattern(value: JsonValue | undefined, steps: number, bpm: number): JsonObject {
  const source = isJsonObject(value) ? value : {};
  const length = Math.min(64, Math.max(4, asNumber(source.steps) ?? steps));
  const tracks = Array.isArray(source.tracks) && source.tracks.length > 0 ? source.tracks.filter(isJsonObject) : defaultTracks(length);
  return {
    bpm: Math.min(240, Math.max(40, asNumber(source.bpm) ?? bpm)),
    steps: length,
    tracks: tracks.map((track) => ({
      name: asText(track.name, "Track"),
      sound: SEQUENCER_SOUNDS.includes(track.sound as (typeof SEQUENCER_SOUNDS)[number]) ? (track.sound as string) : "chime",
      steps: Array.from({ length }, (_unused, index) => Array.isArray(track.steps) && track.steps[index] === true),
    })),
  };
}

const sequencer: ComponentDefinition = {
  type: "ui.sequencer",
  version: 1,
  category: "interface",
  title: "Step sequencer",
  description: 'A drum machine / music sequencer: rows of sounds, columns of steps, played in a loop at a tempo. "value" is the pattern { bpm, steps, tracks }.',
  properties: [
    { name: "steps", type: "number", default: 16, title: "Steps per loop" },
    { name: "bpm", type: "number", default: 110, title: "Tempo (BPM)" },
  ],
  inputs: EDITOR_PORTS.inputs,
  outputs: [
    { name: "value", type: "object", description: "The pattern." },
    { name: "playing", type: "boolean" },
    { name: "bpm", type: "number" },
  ],
  events: [...EDITOR_PORTS.events, { name: "started" }, { name: "stopped" }],
  actions: [
    { name: "set", payload: "any", description: "Replaces the pattern (null starts the default beat)." },
    { name: "clear", description: "Turns every step off." },
    { name: "play" },
    { name: "stop" },
  ],
  create: (ctx) => {
    const editor = documentEditor(ctx, (value) => normalizePattern(value, asNumber(ctx.props.steps) ?? 16, asNumber(ctx.props.bpm) ?? 110));
    const write = (document: JsonObject, announce: boolean): void => {
      editor.write(document, announce);
      ctx.setOutput("bpm", editor.current().bpm as number);
    };
    ctx.setOutput("bpm", editor.current().bpm as number);
    const playing = (on: boolean): void => {
      if (ctx.output("playing") === on) return;
      ctx.setOutput("playing", on);
      ctx.emit(on ? "started" : "stopped");
    };
    ctx.setOutput("playing", false);
    const clear = (): void => {
      const document = editor.current();
      write({ ...document, tracks: (document.tracks as JsonObject[]).map((track) => ({ ...track, steps: (track.steps as boolean[]).map(() => false) })) }, true);
    };
    return {
      actions: {
        set: (payload) => write(isJsonObject(payload) ? payload : {}, false),
        clear,
        play: () => playing(true),
        stop: () => playing(false),
      },
      interactions: {
        toggle: (payload) => {
          if (!isJsonObject(payload)) return;
          const track = asNumber(payload.track);
          const step = asNumber(payload.step);
          const document = editor.current();
          const tracks = document.tracks as JsonObject[];
          if (track === undefined || step === undefined || !tracks[track] || step < 0 || step >= (document.steps as number)) return;
          const next = tracks.map((entry, index) =>
            index === track ? { ...entry, steps: (entry.steps as boolean[]).map((on, position) => (position === step ? !on : on)) } : entry,
          );
          write({ ...document, tracks: next }, true);
        },
        tempo: (payload) => {
          const bpm = asNumber(payload);
          if (bpm !== undefined) write({ ...editor.current(), bpm }, true);
        },
        play: () => playing(true),
        stop: () => playing(false),
        clear,
      },
      dispose: () => undefined,
    };
  },
};

export const editorPrimitives: ComponentDefinition[] = [spreadsheet, canvas, sequencer];

export { address };
