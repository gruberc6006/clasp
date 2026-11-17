import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import { ChevronLeft, ChevronRight, Eraser, Pause, Play, Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { ComponentRenderer } from "./context";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function marks(view: { object: { id: string; type: string; metadata: { name?: string } } }): Record<string, string> {
  return { "data-clasp-id": view.object.id, "data-clasp-type": view.object.type, "data-clasp-name": view.object.metadata.name ?? "" };
}

const TOOL =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

// ── spreadsheet ──────────────────────────────────────────────────────────

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function formatValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

const Spreadsheet: ComponentRenderer = ({ view, app }) => {
  const document = isJsonObject(view.output("value")) ? (view.output("value") as JsonObject) : {};
  const values = isJsonObject(view.output("values")) ? (view.output("values") as JsonObject) : {};
  const cells = isJsonObject(document.cells) ? (document.cells as Record<string, string>) : {};
  const rows = typeof document.rows === "number" ? document.rows : 30;
  const columns = typeof document.columns === "number" ? document.columns : 10;
  const [selected, setSelected] = useState({ column: 0, row: 0 });
  const [draft, setDraft] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLInputElement>(null);
  // Escape must win over the blur that follows it.
  const cancelled = useRef(false);
  const cancel = (): void => {
    setDraft(null);
    cancelled.current = true;
    grid.current?.focus();
    cancelled.current = false;
  };
  const blurCommit = (value: string | null): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (value !== null) commit(value);
  };
  const ref = `${columnName(selected.column)}${selected.row + 1}`;
  const raw = cells[ref] ?? "";

  // Focus the cell editor before the next keystroke arrives, so fast typing loses nothing.
  useLayoutEffect(() => {
    if (draft !== null) editor.current?.focus();
  }, [draft !== null, ref]);

  const commit = (value: string, move?: { column: number; row: number }): void => {
    if (value !== raw) app.runtime.interact(view.object.id, "edit", { cell: ref, raw: value });
    setDraft(null);
    if (move) setSelected({ column: Math.min(columns - 1, Math.max(0, selected.column + move.column)), row: Math.min(rows - 1, Math.max(0, selected.row + move.row)) });
    // Return the keyboard to the grid now; the editor's blur that this causes must not commit again.
    cancelled.current = true;
    grid.current?.focus();
    cancelled.current = false;
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (draft !== null) return;
    const move = (column: number, row: number): void => {
      event.preventDefault();
      setSelected({ column: Math.min(columns - 1, Math.max(0, selected.column + column)), row: Math.min(rows - 1, Math.max(0, selected.row + row)) });
    };
    switch (event.key) {
      case "ArrowUp":
        return move(0, -1);
      case "ArrowDown":
        return move(0, 1);
      case "ArrowLeft":
        return move(-1, 0);
      case "ArrowRight":
      case "Tab":
        return move(1, 0);
      case "Enter":
      case "F2":
        event.preventDefault();
        setDraft(raw);
        return;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        if (raw) app.runtime.interact(view.object.id, "edit", { cell: ref, raw: "" });
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          setDraft(event.key);
        }
    }
  };

  return (
    <div {...marks(view)} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-subtle/50 px-2 py-1.5">
        <span className="w-12 shrink-0 rounded-md bg-surface px-2 py-1 text-center font-mono text-xs font-medium text-ink" data-testid="sheet-address">
          {ref}
        </span>
        <span className="font-mono text-xs italic text-ink-faint">fx</span>
        <input
          aria-label="Formula"
          data-testid="sheet-formula"
          className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-surface px-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          value={draft ?? raw}
          onFocus={() => {
            cancelled.current = false;
            if (draft === null) setDraft(raw);
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft ?? raw, { column: 0, row: 1 });
            if (event.key === "Escape") cancel();
          }}
          onBlur={() => blurCommit(draft)}
        />
      </div>
      <div
        ref={grid}
        tabIndex={0}
        role="grid"
        aria-label={view.object.metadata.name ?? "Spreadsheet"}
        onKeyDown={onGridKey}
        className="max-h-[58vh] overflow-auto focus:outline-none"
      >
        <table className="border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 w-10 border-b border-r border-line bg-subtle" />
              {Array.from({ length: columns }, (_unused, column) => (
                <th
                  key={column}
                  className={cx(
                    "sticky top-0 z-10 h-7 min-w-24 border-b border-r border-line bg-subtle px-2 text-center text-[11px] font-medium text-ink-faint",
                    column === selected.column && "bg-accent-soft text-accent-ink",
                  )}
                >
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_unused, row) => (
              <tr key={row}>
                <th
                  className={cx(
                    "sticky left-0 z-10 h-7 w-10 border-b border-r border-line bg-subtle px-1 text-center text-[11px] font-medium text-ink-faint",
                    row === selected.row && "bg-accent-soft text-accent-ink",
                  )}
                >
                  {row + 1}
                </th>
                {Array.from({ length: columns }, (_unused2, column) => {
                  const address = `${columnName(column)}${row + 1}`;
                  const isSelected = column === selected.column && row === selected.row;
                  const value = values[address];
                  const shown = formatValue(value);
                  const numeric = typeof value === "number";
                  const error = typeof value === "string" && value.startsWith("#") && value.endsWith("!");
                  return (
                    <td
                      key={column}
                      role="gridcell"
                      data-cell={address}
                      aria-selected={isSelected}
                      onMouseDown={(event) => {
                        if (draft !== null && !isSelected) commit(draft);
                        setSelected({ column, row });
                        if (!isSelected) event.preventDefault();
                        grid.current?.focus();
                      }}
                      onDoubleClick={() => setDraft(cells[address] ?? "")}
                      className={cx(
                        "relative h-7 max-w-48 truncate border-b border-r border-line px-2",
                        numeric && "text-right tabular-nums",
                        error ? "text-danger" : "text-ink",
                        isSelected && "outline-2 -outline-offset-2 outline-accent",
                      )}
                    >
                      {isSelected && draft !== null ? (
                        <input
                          ref={editor}
                          aria-label={`Edit ${address}`}
                          className="absolute inset-0 w-full bg-surface px-2 font-mono text-xs outline-2 -outline-offset-2 outline-accent"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commit(draft, { column: 0, row: 1 });
                            } else if (event.key === "Tab") {
                              event.preventDefault();
                              commit(draft, { column: 1, row: 0 });
                            } else if (event.key === "Escape") {
                              cancel();
                            }
                          }}
                          onBlur={() => blurCommit(draft)}
                        />
                      ) : (
                        shown
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1 border-t border-line px-2 py-1">
        <button type="button" className={TOOL} onClick={() => app.runtime.interact(view.object.id, "grow", { rows: true })}>
          <Plus className="size-3.5" /> 10 rows
        </button>
        <button type="button" className={TOOL} onClick={() => app.runtime.interact(view.object.id, "grow", { columns: true })} disabled={columns >= 52}>
          <Plus className="size-3.5" /> Column
        </button>
        <span className="ml-auto pr-1 text-[11px] text-ink-faint">Type to edit · Enter to confirm · =SUM(A1:A5), =B2*C2, =IF(A1&gt;0,"yes","no")</span>
      </div>
    </div>
  );
};

// ── drawing ──────────────────────────────────────────────────────────────

const PALETTE = ["#1c1b19", "#6c47ff", "#0b79d0", "#12805c", "#e8a317", "#e5542b", "#d92d20", "#ec4899"];
const SIZES = [2, 6, 14];

interface Stroke {
  color: string;
  size: number;
  points: number[];
}

function paint(context: CanvasRenderingContext2D, stroke: Stroke): void {
  const points = stroke.points;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.size;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (points.length <= 2 || (points.length === 4 && points[0] === points[2] && points[1] === points[3])) {
    context.beginPath();
    context.arc(points[0] ?? 0, points[1] ?? 0, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(points[0] ?? 0, points[1] ?? 0);
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index] ?? 0, points[index + 1] ?? 0);
  context.stroke();
}

const Canvas: ComponentRenderer = ({ view, app }) => {
  const document = isJsonObject(view.output("value")) ? (view.output("value") as JsonObject) : {};
  const width = typeof document.width === "number" ? document.width : 960;
  const height = typeof document.height === "number" ? document.height : 600;
  const background = typeof document.background === "string" ? document.background : "#ffffff";
  const strokes = (Array.isArray(document.strokes) ? document.strokes : []) as unknown as Stroke[];
  const [color, setColor] = useState(PALETTE[0] as string);
  const [size, setSize] = useState(SIZES[1] as number);
  const [erasing, setErasing] = useState(false);
  const surface = useRef<HTMLCanvasElement>(null);
  const current = useRef<Stroke | null>(null);

  useLayoutEffect(() => {
    const context = surface.current?.getContext("2d");
    if (!context) return;
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    for (const stroke of strokes) paint(context, stroke);
  }, [strokes, width, height, background]);

  const point = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * width, ((event.clientY - rect.top) / rect.height) * height];
  };

  return (
    <div {...marks(view)} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-subtle/50 px-2 py-1.5" role="toolbar" aria-label="Drawing tools">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
          {PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={!erasing && color === swatch}
              aria-label={`Colour ${swatch}`}
              onClick={() => {
                setColor(swatch);
                setErasing(false);
              }}
              className={cx("size-6 rounded-full border-2 transition-transform", !erasing && color === swatch ? "scale-110 border-ink" : "border-surface hover:scale-110")}
              style={{ backgroundColor: swatch }}
            />
          ))}
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Size">
          {SIZES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={size === option}
              aria-label={`Size ${option}`}
              onClick={() => setSize(option)}
              className={cx("grid size-8 place-items-center rounded-lg", size === option ? "bg-surface shadow-sm" : "hover:bg-subtle")}
            >
              <span className="rounded-full bg-ink" style={{ width: Math.max(3, option), height: Math.max(3, option) }} />
            </button>
          ))}
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" aria-pressed={erasing} className={cx(TOOL, erasing && "bg-surface text-ink shadow-sm")} onClick={() => setErasing((value) => !value)}>
          <Eraser className="size-4" /> Eraser
        </button>
        <button type="button" className={TOOL} disabled={strokes.length === 0} onClick={() => app.runtime.interact(view.object.id, "undo")}>
          <Undo2 className="size-4" /> Undo
        </button>
        <button type="button" className={TOOL} disabled={strokes.length === 0} onClick={() => app.runtime.interact(view.object.id, "clear")}>
          <Trash2 className="size-4" /> Clear
        </button>
      </div>
      <div className="bg-canvas p-3">
        <canvas
          ref={surface}
          width={width}
          height={height}
          data-testid="drawing-surface"
          aria-label="Drawing surface"
          className="block w-full touch-none rounded-lg bg-white shadow-sm"
          style={{ aspectRatio: `${width} / ${height}`, cursor: "crosshair" }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const [x, y] = point(event);
            current.current = { color: erasing ? background : color, size: erasing ? size * 3 : size, points: [x, y] };
            const context = event.currentTarget.getContext("2d");
            if (context) paint(context, { ...current.current, points: [x, y] });
          }}
          onPointerMove={(event) => {
            const stroke = current.current;
            if (!stroke) return;
            const [x, y] = point(event);
            const context = event.currentTarget.getContext("2d");
            const px = stroke.points[stroke.points.length - 2] ?? x;
            const py = stroke.points[stroke.points.length - 1] ?? y;
            stroke.points.push(x, y);
            if (context) paint(context, { ...stroke, points: [px, py, x, y] });
          }}
          onPointerUp={() => {
            const stroke = current.current;
            current.current = null;
            if (!stroke) return;
            const points = stroke.points.length === 2 ? [...stroke.points, ...stroke.points] : stroke.points;
            app.runtime.interact(view.object.id, "stroke", { ...stroke, points });
          }}
          onPointerCancel={() => {
            current.current = null;
          }}
        />
      </div>
    </div>
  );
};

// ── music ────────────────────────────────────────────────────────────────

interface Track {
  name: string;
  sound: string;
  steps: boolean[];
}

const CHIME_NOTES = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
const BASS_NOTES = [55.0, 55.0, 65.41, 73.42];

/** Small synthesizer for the sequencer's voices. Everything is generated; no samples are loaded. */
class Synth {
  readonly context: AudioContext;
  private readonly noise: AudioBuffer;
  private readonly output: GainNode;

  constructor() {
    this.context = new AudioContext();
    this.output = this.context.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(this.context.destination);
    const length = this.context.sampleRate;
    this.noise = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
  }

  private envelope(time: number, peak: number, decay: number): GainNode {
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    gain.connect(this.output);
    return gain;
  }

  private noiseBurst(time: number, filter: BiquadFilterType, frequency: number, peak: number, decay: number): void {
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const shape = this.context.createBiquadFilter();
    shape.type = filter;
    shape.frequency.value = frequency;
    source.connect(shape).connect(this.envelope(time, peak, decay));
    source.start(time);
    source.stop(time + decay + 0.02);
  }

  private tone(time: number, type: OscillatorType, frequency: number, peak: number, decay: number, endFrequency?: number): void {
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + decay * 0.5);
    oscillator.connect(this.envelope(time, peak, decay));
    oscillator.start(time);
    oscillator.stop(time + decay + 0.02);
  }

  play(sound: string, time: number, step: number): void {
    switch (sound) {
      case "kick":
        this.tone(time, "sine", 150, 1, 0.35, 42);
        break;
      case "snare":
        this.noiseBurst(time, "highpass", 1200, 0.55, 0.18);
        this.tone(time, "triangle", 190, 0.3, 0.1);
        break;
      case "hat":
        this.noiseBurst(time, "highpass", 7500, 0.25, 0.05);
        break;
      case "clap":
        for (const offset of [0, 0.012, 0.024]) this.noiseBurst(time + offset, "bandpass", 1500, 0.45, 0.09);
        break;
      case "bass": {
        const oscillator = this.context.createOscillator();
        oscillator.type = "sawtooth";
        oscillator.frequency.value = BASS_NOTES[Math.floor(step / 4) % BASS_NOTES.length] as number;
        const filter = this.context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 420;
        oscillator.connect(filter).connect(this.envelope(time, 0.45, 0.28));
        oscillator.start(time);
        oscillator.stop(time + 0.3);
        break;
      }
      default:
        this.tone(time, "sine", CHIME_NOTES[step % CHIME_NOTES.length] as number, 0.22, 0.6);
    }
  }
}

let sharedSynth: Synth | undefined;

const Sequencer: ComponentRenderer = ({ view, app }) => {
  const document = isJsonObject(view.output("value")) ? (view.output("value") as JsonObject) : {};
  const bpm = typeof document.bpm === "number" ? document.bpm : 110;
  const steps = typeof document.steps === "number" ? document.steps : 16;
  const tracks = (Array.isArray(document.tracks) ? document.tracks : []) as unknown as Track[];
  const playing = view.output("playing") === true;
  const [position, setPosition] = useState(-1);
  const pattern = useRef({ tracks, bpm, steps });
  pattern.current = { tracks, bpm, steps };

  useEffect(() => {
    if (!playing) {
      setPosition(-1);
      return;
    }
    let synth: Synth;
    try {
      sharedSynth ??= new Synth();
      synth = sharedSynth;
      void synth.context.resume();
    } catch {
      return; // no audio available; the grid still works
    }
    const context = synth.context;
    let step = 0;
    let next = context.currentTime + 0.06;
    const queue: Array<{ step: number; time: number }> = [];
    const scheduler = setInterval(() => {
      const { tracks: current, bpm: tempo, steps: length } = pattern.current;
      const sixteenth = 60 / tempo / 4;
      while (next < context.currentTime + 0.12) {
        for (const track of current) if (track.steps[step]) synth.play(track.sound, next, step);
        queue.push({ step, time: next });
        next += sixteenth;
        step = (step + 1) % length;
      }
    }, 25);
    let frame = 0;
    const draw = (): void => {
      while (queue.length > 0 && (queue[0] as { time: number }).time <= context.currentTime) setPosition((queue.shift() as { step: number }).step);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      clearInterval(scheduler);
      cancelAnimationFrame(frame);
    };
  }, [playing]);

  return (
    <div {...marks(view)} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/50 px-2.5 py-2">
        <button
          type="button"
          data-testid="sequencer-play"
          aria-pressed={playing}
          onClick={() => app.runtime.interact(view.object.id, playing ? "stop" : "play")}
          className={cx(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
            playing ? "bg-ink text-canvas" : "bg-accent text-white hover:bg-accent-strong",
          )}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          {playing ? "Stop" : "Play"}
        </button>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          Tempo
          <input
            type="range"
            min={60}
            max={180}
            value={bpm}
            aria-label="Tempo"
            onChange={(event) => app.runtime.interact(view.object.id, "tempo", Number(event.target.value))}
            className="w-32 accent-[var(--color-accent)]"
          />
          <span className="w-16 tabular-nums text-ink" data-testid="sequencer-bpm">
            {bpm} BPM
          </span>
        </label>
        <button type="button" className={cx(TOOL, "ml-auto")} onClick={() => app.runtime.interact(view.object.id, "clear")}>
          <Trash2 className="size-4" /> Clear
        </button>
      </div>
      <div className="overflow-x-auto p-3">
        <div className="flex min-w-max flex-col gap-1.5" role="grid" aria-label="Pattern">
          {tracks.map((track, trackIndex) => (
            <div key={trackIndex} className="flex items-center gap-1.5" role="row">
              <span className="w-16 shrink-0 truncate text-xs font-medium text-ink-soft">{track.name}</span>
              {Array.from({ length: steps }, (_unused, stepIndex) => {
                const on = track.steps[stepIndex] === true;
                const here = stepIndex === position;
                return (
                  <button
                    key={stepIndex}
                    type="button"
                    role="gridcell"
                    aria-pressed={on}
                    aria-label={`${track.name} step ${stepIndex + 1}`}
                    onClick={() => app.runtime.interact(view.object.id, "toggle", { track: trackIndex, step: stepIndex })}
                    className={cx(
                      "size-7 shrink-0 rounded-md border transition-colors",
                      stepIndex % 4 === 0 && stepIndex > 0 && "ml-1.5",
                      on ? "border-accent bg-accent" : stepIndex % 4 === 0 ? "border-line-strong bg-subtle hover:bg-accent-soft" : "border-line bg-surface hover:bg-accent-soft",
                      here && (on ? "ring-2 ring-ink/50" : "border-ink-faint bg-line"),
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── calendar ─────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const Calendar: ComponentRenderer = ({ view, app }) => {
  const rows = (Array.isArray(view.input("items")) ? view.input("items") : []) as JsonObject[];
  const dateField = typeof view.props.dateField === "string" ? view.props.dateField : "start";
  const titleField = typeof view.props.titleField === "string" ? view.props.titleField : "title";
  const mondayFirst = view.props.weekStartsOn !== "sunday";
  const picked = typeof view.output("selectedDate") === "string" ? (view.output("selectedDate") as string) : undefined;
  const today = isoDay(new Date());
  // Which month is shown is presentation state: it starts at the picked day's month, or this month.
  const [month, setMonth] = useState(() => {
    const base = picked ? new Date(`${picked}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  const byDay = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const value = row[dateField];
    const day = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] : undefined;
    if (!day) continue;
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  }

  const first = new Date(month.year, month.month, 1);
  const offset = (first.getDay() + (mondayFirst ? 6 : 0)) % 7;
  const start = new Date(month.year, month.month, 1 - offset);
  const days = Array.from({ length: 42 }, (_unused, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const weekdays = mondayFirst ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const shift = (delta: number): void => setMonth(({ year, month: current }) => {
    const next = new Date(year, current + delta, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return (
    <div {...marks(view)} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-1 border-b border-line bg-subtle/50 px-2.5 py-2">
        <span className="mr-auto pl-1 text-[15px] font-semibold tracking-tight text-ink" data-testid="calendar-month">
          {MONTHS[month.month]} {month.year}
        </span>
        <button type="button" className={TOOL} onClick={() => {
          const now = new Date();
          setMonth({ year: now.getFullYear(), month: now.getMonth() });
        }}>
          Today
        </button>
        <button type="button" aria-label="Previous month" className={cx(TOOL, "px-1.5")} onClick={() => shift(-1)}>
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" aria-label="Next month" className={cx(TOOL, "px-1.5")} onClick={() => shift(1)}>
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 border-b border-line bg-subtle/30">
        {weekdays.map((name) => (
          <div key={name} className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7" role="grid" aria-label={`${MONTHS[month.month]} ${month.year}`}>
        {days.map((date) => {
          const key = isoDay(date);
          const inMonth = date.getMonth() === month.month;
          const entries = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              role="gridcell"
              data-day={key}
              aria-selected={picked === key}
              onClick={() => app.runtime.interact(view.object.id, "pick", key)}
              className={cx(
                "flex min-h-24 cursor-pointer flex-col gap-1 border-b border-r border-line p-1.5 transition-colors hover:bg-accent-soft/30",
                !inMonth && "bg-subtle/40",
                picked === key && "bg-accent-soft/50 outline-2 -outline-offset-2 outline-accent",
              )}
            >
              <span
                className={cx(
                  "grid size-6 place-items-center rounded-full text-xs tabular-nums",
                  key === today ? "bg-accent font-semibold text-white" : inMonth ? "text-ink" : "text-ink-faint",
                )}
              >
                {date.getDate()}
              </span>
              {entries.slice(0, 3).map((row) => (
                <button
                  key={String(row.id)}
                  type="button"
                  data-testid="calendar-entry"
                  onClick={(event) => {
                    event.stopPropagation();
                    app.runtime.interact(view.object.id, "select", { id: String(row.id) });
                  }}
                  className="truncate rounded-md bg-accent px-1.5 py-0.5 text-left text-[11px] font-medium text-white hover:bg-accent-strong"
                  title={String(row[titleField] ?? "")}
                >
                  {String(row[titleField] ?? "Untitled")}
                </button>
              ))}
              {entries.length > 3 && <span className="px-1 text-[11px] text-ink-soft">+{entries.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const editorRenderers: Record<string, ComponentRenderer> = {
  "ui.calendar": Calendar,
  "ui.spreadsheet": Spreadsheet,
  "ui.canvas": Canvas,
  "ui.sequencer": Sequencer,
};
