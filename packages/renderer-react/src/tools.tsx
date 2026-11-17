import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import { ArrowLeft, ArrowRight, Bold, Code, Heading1, Heading2, Italic, List, ListOrdered, Quote, RefreshCw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { ComponentRenderer } from "./context";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function marks(view: { object: { id: string; type: string; metadata: { name?: string } } }): Record<string, string> {
  return { "data-clasp-id": view.object.id, "data-clasp-type": view.object.type, "data-clasp-name": view.object.metadata.name ?? "" };
}

function text(value: JsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function rows(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

const TOOL =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const PRIMARY = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:bg-accent-strong";

// ── calculator ───────────────────────────────────────────────────────────

const KEYPAD = ["C", "⌫", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "±", "0", ".", "="];
const KEYBOARD: Record<string, string> = { "*": "×", "/": "÷", "-": "−", Enter: "=", "=": "=", Backspace: "⌫", Escape: "C", Delete: "C" };

const Calculator: ComponentRenderer = ({ view, app }) => {
  const press = (key: string): void => app.runtime.interact(view.object.id, "key", key);
  const history = rows(view.output("history"));
  return (
    <div
      {...marks(view)}
      tabIndex={0}
      className="mx-auto flex w-full max-w-xs flex-col gap-3 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onKeyDown={(event) => {
        const key = KEYBOARD[event.key] ?? event.key;
        if (KEYPAD.includes(key) || key === "(" || key === ")") {
          event.preventDefault();
          press(key);
        }
      }}
    >
      <div className="rounded-xl bg-[#1c1b19] px-4 py-3 text-right text-white">
        <div className="h-4 truncate text-xs text-white/50" data-testid="calc-expression">
          {text(view.output("expression"))}
        </div>
        <div className="truncate text-3xl font-light tabular-nums tracking-tight" data-testid="calc-display">
          {text(view.output("display"), "0")}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {KEYPAD.map((key) => (
          <button
            key={key}
            type="button"
            aria-label={key === "⌫" ? "Backspace" : key === "C" ? "Clear" : key}
            onClick={() => press(key)}
            className={cx(
              "h-11 rounded-xl text-lg font-medium transition-colors active:scale-[0.97]",
              key === "=" ? "bg-accent text-white hover:bg-accent-strong" : ["÷", "×", "−", "+"].includes(key) ? "bg-accent-soft text-accent-ink hover:bg-accent/20" : ["C", "⌫", "%", "±"].includes(key) ? "bg-subtle text-ink-soft hover:bg-line" : "border border-line bg-surface text-ink hover:bg-subtle",
            )}
          >
            {key}
          </button>
        ))}
      </div>
      {history.length > 0 && (
        <ul className="max-h-28 overflow-y-auto border-t border-line pt-2 text-right text-xs text-ink-soft" aria-label="History">
          {history.map((entry) => (
            <li key={text(entry.id)} className="truncate tabular-nums">
              {text(entry.title)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ── code editor ──────────────────────────────────────────────────────────

/** Applies an edit, then restores the caret once the new text has rendered. */
function useCaret(): [RefObject<HTMLTextAreaElement | null>, (position: [number, number]) => void] {
  const ref = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (pending.current && ref.current) {
      ref.current.setSelectionRange(...pending.current);
      pending.current = null;
    }
  });
  return [ref, (position) => (pending.current = position)];
}

const CodeEditor: ComponentRenderer = ({ view, app }) => {
  const value = text(view.output("value"));
  const [ref, caretAt] = useCaret();
  const gutter = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const lines = value.split("\n").length;
  const tab = " ".repeat(view.props.tabSize === "4" ? 4 : 2);
  const write = (next: string): void => app.runtime.interact(view.object.id, "input", next);
  const track = (element: HTMLTextAreaElement): void => {
    const before = element.value.slice(0, element.selectionStart);
    const line = before.split("\n").length;
    setCursor({ line, column: before.length - before.lastIndexOf("\n") });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const element = event.currentTarget;
    const { selectionStart: start, selectionEnd: end } = element;
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const removable = value.slice(lineStart, lineStart + tab.length).match(/^ +/)?.[0].length ?? 0;
      if (removable === 0) return;
      caretAt([Math.max(lineStart, start - removable), Math.max(lineStart, end - removable)]);
      write(value.slice(0, lineStart) + value.slice(lineStart + removable));
      return;
    }
    caretAt([start + tab.length, start + tab.length]);
    write(value.slice(0, start) + tab + value.slice(end));
  };
  return (
    <div {...marks(view)} className="flex min-h-80 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex min-h-0 flex-1">
        <div ref={gutter} aria-hidden className="w-11 shrink-0 select-none overflow-hidden border-r border-line bg-subtle/60 py-2 pr-2 text-right font-mono text-xs leading-5 text-ink-faint">
          {Array.from({ length: lines }, (_, index) => (
            <div key={index} className={cx(index + 1 === cursor.line && "text-ink")}>
              {index + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={ref}
          value={value}
          spellCheck={false}
          aria-label={view.object.metadata.name ?? "Code editor"}
          placeholder={text(view.props.placeholder)}
          wrap={view.props.wrap === true ? "soft" : "off"}
          onChange={(event) => {
            write(event.target.value);
            track(event.target);
          }}
          onKeyDown={onKeyDown}
          onSelect={(event) => track(event.currentTarget)}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          className="min-h-80 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      <div className="flex gap-3 border-t border-line bg-subtle/60 px-3 py-1 text-[11px] tabular-nums text-ink-faint" data-testid="code-status">
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span>{lines} lines</span>
        <span>{value.length} characters</span>
        <span className="ml-auto">Spaces: {tab.length}</span>
      </div>
    </div>
  );
};

// ── word processor ───────────────────────────────────────────────────────

interface SpanValue {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

function Spans({ spans }: { spans: JsonValue | undefined }): ReactNode {
  return rows(spans).map((raw, index) => {
    const span = raw as unknown as SpanValue;
    let node: ReactNode = span.text;
    if (span.code) node = <code className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.9em]">{node}</code>;
    if (span.bold) node = <strong className="font-semibold">{node}</strong>;
    if (span.italic) node = <em>{node}</em>;
    if (span.href)
      node = (
        <a href={span.href} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
          {node}
        </a>
      );
    return <span key={index}>{node}</span>;
  });
}

function Page({ blocks }: { blocks: JsonObject[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const level = block.level === 1 ? "text-2xl font-semibold tracking-tight" : block.level === 2 ? "text-xl font-semibold" : "text-base font-semibold";
        return (
          <div key={index} role="heading" aria-level={Number(block.level)} className={cx(level, "mt-4 text-ink first:mt-0")}>
            <Spans spans={block.spans} />
          </div>
        );
      }
      case "list": {
        const items = Array.isArray(block.items) ? block.items : [];
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={index} className={cx("my-2 pl-6", block.ordered ? "list-decimal" : "list-disc")}>
            {items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Spans spans={item} />
              </li>
            ))}
          </Tag>
        );
      }
      case "quote":
        return (
          <blockquote key={index} className="my-2 border-l-4 border-accent/40 pl-3 italic text-ink-soft">
            <Spans spans={block.spans} />
          </blockquote>
        );
      case "code":
        return (
          <pre key={index} className="my-2 overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-[13px]">
            {text(block.text)}
          </pre>
        );
      case "rule":
        return <hr key={index} className="my-4 border-line" />;
      default:
        return (
          <p key={index} className="my-2">
            <Spans spans={block.spans} />
          </p>
        );
    }
  });
}

const RichText: ComponentRenderer = ({ view, app }) => {
  const value = text(view.output("value"));
  const blocks = rows(view.output("blocks"));
  const [ref, caretAt] = useCaret();
  const write = (next: string): void => app.runtime.interact(view.object.id, "input", next);
  /** Wraps the selection (or inserts a sample) with Markdown marks. */
  const wrap = (before: string, after: string, sample: string): void => {
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || sample;
    caretAt([start + before.length, start + before.length + selected.length]);
    write(value.slice(0, start) + before + selected + after + value.slice(end));
    element?.focus();
  };
  /** Puts a prefix at the start of each selected line. */
  const prefix = (mark: (index: number) => string): void => {
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const block = value.slice(lineStart, end);
    const lines = block.split("\n").map((line, index) => mark(index) + line.replace(/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|>\s?)/, ""));
    const next = lines.join("\n");
    caretAt([lineStart, lineStart + next.length]);
    write(value.slice(0, lineStart) + next + value.slice(end));
    element?.focus();
  };
  const tools: Array<[ReactNode, string, () => void]> = [
    [<Heading1 key="h1" className="size-4" />, "Heading", () => prefix(() => "# ")],
    [<Heading2 key="h2" className="size-4" />, "Subheading", () => prefix(() => "## ")],
    [<Bold key="b" className="size-4" />, "Bold", () => wrap("**", "**", "bold text")],
    [<Italic key="i" className="size-4" />, "Italic", () => wrap("*", "*", "italic text")],
    [<Code key="c" className="size-4" />, "Code", () => wrap("`", "`", "code")],
    [<List key="ul" className="size-4" />, "Bulleted list", () => prefix(() => "- ")],
    [<ListOrdered key="ol" className="size-4" />, "Numbered list", () => prefix((index) => `${index + 1}. `)],
    [<Quote key="q" className="size-4" />, "Quote", () => prefix(() => "> ")],
  ];
  return (
    <div {...marks(view)} className="flex min-h-96 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-subtle/60 px-2 py-1" role="toolbar" aria-label="Formatting">
        {tools.map(([icon, label, action]) => (
          <button key={label} type="button" aria-label={label} title={label} className={cx(TOOL, "w-8 px-0")} onMouseDown={(event) => event.preventDefault()} onClick={action}>
            {icon}
          </button>
        ))}
        <span className="ml-auto px-2 text-[11px] tabular-nums text-ink-faint" data-testid="word-count">
          {Number(view.output("words") ?? 0)} words
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <textarea
          ref={ref}
          value={value}
          aria-label="Text"
          placeholder={text(view.props.placeholder, "Start writing…")}
          onChange={(event) => write(event.target.value)}
          onKeyDown={(event) => {
            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.key === "b") {
              event.preventDefault();
              wrap("**", "**", "bold text");
            } else if (event.key === "i") {
              event.preventDefault();
              wrap("*", "*", "italic text");
            }
          }}
          className="min-h-96 resize-none border-b border-line bg-transparent p-4 font-mono text-[13px] leading-6 text-ink outline-none placeholder:text-ink-faint md:border-b-0 md:border-r"
        />
        <article className="min-h-96 overflow-y-auto bg-canvas/50 p-6 text-[15px] leading-7 text-ink" aria-label="Page" data-testid="page">
          {blocks.length === 0 ? <p className="text-ink-faint">Your formatted page appears here.</p> : <Page blocks={blocks} />}
        </article>
      </div>
    </div>
  );
};

// ── terminal ─────────────────────────────────────────────────────────────

const LINE_STYLE: Record<string, string> = {
  input: "text-white",
  output: "text-white/80",
  error: "text-[#ff8a80]",
  info: "text-[#9ec5ff]",
};

const Terminal: ComponentRenderer = ({ view, app }) => {
  const lines = rows(view.output("lines"));
  const history = Array.isArray(view.output("history")) ? (view.output("history") as JsonValue[]).map((entry) => text(entry)) : [];
  const [draft, setDraft] = useState("");
  const [back, setBack] = useState(-1);
  const screen = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [lines.length]);
  const run = (): void => {
    app.runtime.interact(view.object.id, "run", draft);
    setDraft("");
    setBack(-1);
  };
  return (
    <div
      {...marks(view)}
      className="flex h-96 flex-col overflow-hidden rounded-xl bg-[#17161a] font-mono text-[13px] leading-5 shadow-inner"
      onClick={() => {
        if (!window.getSelection()?.toString()) input.current?.focus();
      }}
    >
      <div ref={screen} className="min-h-0 flex-1 overflow-y-auto px-3 pt-2" data-testid="terminal-screen" role="log" aria-live="polite">
        {lines.map((line) => (
          <div key={text(line.id)} className={cx("whitespace-pre-wrap break-words", LINE_STYLE[text(line.kind)] ?? LINE_STYLE.output)}>
            {text(line.text) || " "}
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 px-3 py-2 text-white">
        <span className="shrink-0 text-[#b69cff]">{text(view.output("prompt"), "clasp>")}</span>
        <input
          ref={input}
          value={draft}
          aria-label="Command"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") run();
            else if (event.key === "ArrowUp" && history.length > 0) {
              event.preventDefault();
              const index = back === -1 ? history.length - 1 : Math.max(0, back - 1);
              setBack(index);
              setDraft(history[index] ?? "");
            } else if (event.key === "ArrowDown" && back !== -1) {
              event.preventDefault();
              const index = back + 1;
              setBack(index >= history.length ? -1 : index);
              setDraft(index >= history.length ? "" : (history[index] ?? ""));
            } else if (event.key === "l" && event.ctrlKey) {
              event.preventDefault();
              app.runtime.interact(view.object.id, "run", "clear");
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-white caret-[#b69cff] outline-none"
        />
        {view.output("busy") === true && <span className="size-2 shrink-0 animate-pulse rounded-full bg-[#b69cff]" aria-label="Working" />}
      </label>
    </div>
  );
};

// ── clock ────────────────────────────────────────────────────────────────

const Clock: ComponentRenderer = ({ view, app }) => {
  const mode = text(view.output("mode"), "clock");
  const running = view.output("running") === true;
  const laps = rows(view.output("laps"));
  const act = (name: string, payload?: JsonValue): void => app.runtime.interact(view.object.id, name, payload);
  const [minutes, setMinutes] = useState(String(view.props.minutes ?? 5));
  return (
    <div {...marks(view)} className="flex flex-col items-center gap-4">
      <div className="inline-flex rounded-lg bg-subtle p-0.5" role="tablist" aria-label="Clock mode">
        {(["clock", "stopwatch", "timer"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={mode === option}
            onClick={() => act("mode", option)}
            className={cx("rounded-md px-3 py-1 text-sm font-medium capitalize", mode === option ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink")}
          >
            {option}
          </button>
        ))}
      </div>
      <div className={cx("font-mono text-5xl font-light tabular-nums tracking-tight", mode === "timer" && view.output("elapsed") === 0 ? "text-accent" : "text-ink")} data-testid="clock-display">
        {text(view.output("display"))}
      </div>
      {mode !== "clock" && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button type="button" className={PRIMARY} onClick={() => act(running ? "stop" : "start")}>
            {running ? "Stop" : "Start"}
          </button>
          {mode === "stopwatch" && (
            <button type="button" className={TOOL} onClick={() => act("lap")} disabled={!running}>
              Lap
            </button>
          )}
          <button type="button" className={TOOL} onClick={() => act("reset")}>
            Reset
          </button>
        </div>
      )}
      {mode === "timer" && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-ink-soft">
          {[1, 5, 10, 25].map((value) => (
            <button key={value} type="button" className={cx(TOOL, "h-7 border border-line")} onClick={() => act("minutes", value)}>
              {value} min
            </button>
          ))}
          <input
            type="number"
            min={1}
            aria-label="Minutes"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") act("minutes", Number(minutes));
            }}
            className="h-7 w-16 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
          />
        </div>
      )}
      {mode === "stopwatch" && laps.length > 0 && (
        <ol className="w-full max-w-xs divide-y divide-line rounded-xl border border-line text-sm" aria-label="Laps">
          {laps.map((lap) => (
            <li key={text(lap.id)} className="flex justify-between px-3 py-1.5 tabular-nums">
              <span className="text-ink-soft">{text(lap.title)}</span>
              <span className="font-mono text-ink">{text(lap.subtitle)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

// ── board ────────────────────────────────────────────────────────────────

const Board: ComponentRenderer = ({ view, app }) => {
  const items = rows(view.input("items"));
  const columns = Array.isArray(view.props.columns) && view.props.columns.length > 0 ? view.props.columns.map((column) => text(column)) : ["To do", "Doing", "Done"];
  const field = text(view.props.groupField, "status");
  const titleField = text(view.props.titleField, "title");
  const subtitleField = text(view.props.subtitleField);
  const [over, setOver] = useState<string | undefined>(undefined);
  const move = (id: string, column: string): void => app.runtime.interact(view.object.id, "move", { id, column });
  const columnOf = (row: JsonObject): string => (columns.includes(text(row[field])) ? text(row[field]) : (columns[0] as string));
  return (
    <div {...marks(view)} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(10rem, 1fr))` }}>
      {columns.map((column, index) => {
        const cards = items.filter((row) => columnOf(row) === column);
        return (
          <section
            key={column}
            data-column={column}
            aria-label={column}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(column);
            }}
            onDragLeave={() => setOver(undefined)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(undefined);
              const id = event.dataTransfer.getData("text/clasp-card");
              if (id) move(id, column);
            }}
            className={cx("flex min-h-40 flex-col gap-2 rounded-xl bg-subtle/70 p-2 transition-colors", over === column && "bg-accent-soft ring-2 ring-accent/40")}
          >
            <h3 className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
              {column}
              <span className="rounded-full bg-surface px-1.5 text-[11px] tabular-nums text-ink-faint">{cards.length}</span>
            </h3>
            {cards.map((card) => {
              const id = text(card.id);
              return (
                <article
                  key={id}
                  draggable
                  data-card={text(card[titleField])}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/clasp-card", id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  className="group cursor-grab rounded-lg border border-line bg-surface p-2.5 shadow-sm active:cursor-grabbing"
                >
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm font-medium text-ink">{text(card[titleField], "Untitled")}</div>
                      {subtitleField && text(card[subtitleField]) && <div className="mt-0.5 text-xs text-ink-soft">{text(card[subtitleField])}</div>}
                    </div>
                    {view.props.removable !== false && (
                      <button type="button" aria-label={`Remove ${text(card[titleField])}`} onClick={() => app.runtime.interact(view.object.id, "remove", { id })} className="grid size-6 place-items-center rounded text-ink-faint opacity-0 hover:bg-subtle hover:text-danger group-hover:opacity-100 focus:opacity-100">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1.5 flex justify-end gap-0.5">
                    <button type="button" aria-label={`Move ${text(card[titleField])} left`} disabled={index === 0} onClick={() => move(id, columns[index - 1] as string)} className="grid size-6 place-items-center rounded text-ink-faint hover:bg-subtle hover:text-ink disabled:invisible">
                      <ArrowLeft className="size-3.5" />
                    </button>
                    <button type="button" aria-label={`Move ${text(card[titleField])} right`} disabled={index === columns.length - 1} onClick={() => move(id, columns[index + 1] as string)} className="grid size-6 place-items-center rounded text-ink-faint hover:bg-subtle hover:text-ink disabled:invisible">
                      <ArrowRight className="size-3.5" />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
};

// ── system monitor ───────────────────────────────────────────────────────

const GAUGES: Array<{ key: string; label: string; unit: string; max?: number; hint: string }> = [
  { key: "busy", label: "Main thread busy", unit: "%", max: 100, hint: "Share of the last second this tab spent on long tasks" },
  { key: "lagMs", label: "Timer lag", unit: "ms", hint: "How late timers ran — high when the tab is overloaded" },
  { key: "fps", label: "Frames", unit: "fps", max: 120, hint: "Frames drawn per second" },
  { key: "heapUsedMb", label: "JS memory", unit: "MB", hint: "JavaScript memory in use (Chrome only)" },
  { key: "stepsPerSecond", label: "Runtime activity", unit: "steps/s", hint: "Component steps executed, all applications" },
  { key: "storageUsedMb", label: "Storage", unit: "MB", hint: "Storage this site uses" },
];

function Sparkline({ values, max }: { values: number[]; max: number | undefined }): ReactNode {
  if (values.length < 2) return <div className="h-10" />;
  const top = Math.max(max ?? 0, ...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${40 - (value / top) * 36}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      <polyline points={`0,40 ${points} 100,40`} className="fill-accent/10 stroke-none" />
      <polyline points={points} className="fill-none stroke-accent" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function figure(value: JsonValue | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

const SystemMonitor: ComponentRenderer = ({ view, app }) => {
  const status = text(view.output("status"), "asking");
  const metrics = isJsonObject(view.output("metrics")) ? (view.output("metrics") as JsonObject) : {};
  const history = rows(view.output("history"));
  if (status !== "live") {
    return (
      <div {...marks(view)} className="flex flex-col items-start gap-3 rounded-xl border border-line bg-subtle/50 p-4 text-sm text-ink-soft" data-testid="monitor-status" data-status={status}>
        {status === "asking"
          ? "Waiting for your permission to read the System service…"
          : status === "denied"
            ? "This monitor may not read the System service. Grant it under Permissions, or press Try again."
            : "The System service is not available in this workspace."}
        {status !== "asking" && (
          <button type="button" className={TOOL} onClick={() => app.runtime.interact(view.object.id, "refresh")}>
            <RefreshCw className="size-3.5" /> Try again
          </button>
        )}
      </div>
    );
  }
  const facts: Array<[string, string]> = [
    ["Applications", figure(metrics.apps)],
    ["Records", figure(metrics.records)],
    ["Connections", figure(metrics.connections)],
    ["Processors", figure(metrics.cores)],
  ];
  return (
    <div {...marks(view)} className="flex flex-col gap-3" data-testid="monitor-status" data-status={status}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {GAUGES.map((gauge) => {
          const values = history.map((sample) => (typeof sample[gauge.key] === "number" ? (sample[gauge.key] as number) : 0));
          const available = typeof metrics[gauge.key] === "number";
          return (
            <div key={gauge.key} className="rounded-xl border border-line bg-surface p-3" title={gauge.hint} data-metric={gauge.key}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{gauge.label}</div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">
                {available ? figure(metrics[gauge.key]) : "—"} <span className="text-xs font-normal text-ink-faint">{available ? gauge.unit : "not available"}</span>
              </div>
              {available && <Sparkline values={values} max={gauge.max} />}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-soft">
        {facts.map(([label, value]) => (
          <span key={label}>
            {label}: <span className="font-medium tabular-nums text-ink">{value}</span>
          </span>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-ink-faint">
        Browsers do not tell web pages how busy the computer's processor is. “Main thread busy” measures this tab: how much of each second it spent on tasks long enough to
        make the page stutter.
      </p>
    </div>
  );
};

export const toolRenderers: Record<string, ComponentRenderer> = {
  "ui.calculator": Calculator,
  "ui.codeEditor": CodeEditor,
  "ui.richText": RichText,
  "ui.terminal": Terminal,
  "ui.clock": Clock,
  "ui.board": Board,
  "ui.systemMonitor": SystemMonitor,
};
