import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Heart } from "lucide-react";
import type { ReactNode } from "react";
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

const BUTTON = "inline-flex h-8 items-center justify-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-subtle";

function Status({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="text-center text-sm font-medium text-ink" role="status" data-testid="game-status">
      {children}
    </div>
  );
}

// ── tic-tac-toe ──────────────────────────────────────────────────────────

const TicTacToe: ComponentRenderer = ({ view, app }) => {
  const board = Array.isArray(view.output("board")) ? (view.output("board") as JsonValue[]).map((cell) => text(cell)) : Array<string>(9).fill("");
  const line = Array.isArray(view.output("line")) ? (view.output("line") as number[]) : [];
  const playing = view.output("outcome") === "playing";
  const tally = isJsonObject(view.output("tally")) ? (view.output("tally") as JsonObject) : {};
  return (
    <div {...marks(view)} className="flex flex-col items-center gap-3">
      <Status>{text(view.output("status"))}</Status>
      <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-line/70 p-1.5" role="grid" aria-label="Board">
        {board.map((cell, index) => (
          <button
            key={index}
            type="button"
            aria-label={`Square ${index + 1}${cell ? `, ${cell}` : ""}`}
            data-cell={index}
            disabled={!playing || cell !== ""}
            onClick={() => app.runtime.interact(view.object.id, "play", index)}
            className={cx(
              "grid size-20 place-items-center rounded-xl bg-surface text-4xl font-semibold transition-colors",
              cell === "" && playing && "hover:bg-accent-soft",
              line.includes(index) && "bg-success-soft",
              cell === "X" ? "text-accent" : "text-ink",
            )}
          >
            {cell}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-4 text-xs tabular-nums text-ink-soft">
        <span>Won {text(tally.won, "0")}</span>
        <span>Lost {text(tally.lost, "0")}</span>
        <span>Drawn {text(tally.drawn, "0")}</span>
      </div>
      <button type="button" className={BUTTON} onClick={() => app.runtime.interact(view.object.id, "newGame")}>
        New game
      </button>
    </div>
  );
};

// ── pairs ────────────────────────────────────────────────────────────────

const Pairs: ComponentRenderer = ({ view, app }) => {
  const cards = rows(view.output("cards"));
  const columns = cards.length <= 16 ? 4 : 6;
  return (
    <div {...marks(view)} className="flex flex-col items-center gap-3">
      <Status>{text(view.output("status"))}</Status>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {cards.map((card) => {
          const faceUp = card.faceUp === true;
          return (
            <button
              key={text(card.id)}
              type="button"
              data-card={text(card.index)}
              data-face-up={faceUp ? "true" : "false"}
              aria-label={faceUp ? `Card ${Number(card.index) + 1}: ${text(card.symbol)}` : `Card ${Number(card.index) + 1}, face down`}
              disabled={card.matched === true}
              onClick={() => app.runtime.interact(view.object.id, "flip", card.index ?? null)}
              className={cx(
                "grid size-16 place-items-center rounded-xl text-3xl transition-all duration-200",
                faceUp ? "border border-line bg-surface" : "bg-[linear-gradient(135deg,var(--color-accent),var(--color-accent-ink))] shadow-sm hover:-translate-y-0.5",
                card.matched === true && "opacity-60",
              )}
            >
              {faceUp ? text(card.symbol) : ""}
            </button>
          );
        })}
      </div>
      <button type="button" className={BUTTON} onClick={() => app.runtime.interact(view.object.id, "newGame")}>
        New game
      </button>
    </div>
  );
};

// ── word guess ───────────────────────────────────────────────────────────

const WordGuess: ComponentRenderer = ({ view, app }) => {
  const letters = rows(view.output("letters"));
  const lives = Number(view.output("lives") ?? 0);
  const maxLives = Number(view.output("maxLives") ?? 6);
  const playing = view.output("outcome") === "playing";
  const guess = (letter: string): void => app.runtime.interact(view.object.id, "guess", letter);
  return (
    <div
      {...marks(view)}
      tabIndex={0}
      className="flex flex-col items-center gap-4 rounded-xl outline-none"
      onKeyDown={(event) => {
        if (/^[a-z]$/i.test(event.key) && !event.metaKey && !event.ctrlKey) guess(event.key.toLowerCase());
      }}
    >
      <div className="flex gap-1" aria-label={`${lives} of ${maxLives} lives`}>
        {Array.from({ length: maxLives }, (_, index) => (
          <Heart key={index} className={cx("size-5", index < lives ? "fill-danger text-danger" : "text-line-strong")} />
        ))}
      </div>
      <div className="font-mono text-3xl font-semibold tracking-[0.2em] text-ink" data-testid="word-pattern">
        {text(view.output("pattern"))}
      </div>
      <Status>{text(view.output("status"))}</Status>
      <div className="flex max-w-md flex-wrap justify-center gap-1.5" role="group" aria-label="Letters">
        {letters.map((entry) => {
          const state = text(entry.state);
          return (
            <button
              key={text(entry.letter)}
              type="button"
              aria-label={`Letter ${text(entry.letter)}`}
              disabled={!playing || state !== "unused"}
              onClick={() => guess(text(entry.letter))}
              className={cx(
                "size-9 rounded-lg text-sm font-semibold uppercase transition-colors",
                state === "hit" ? "bg-success text-white" : state === "miss" ? "bg-subtle text-ink-faint line-through" : "border border-line bg-surface text-ink hover:bg-accent-soft",
              )}
            >
              {text(entry.letter)}
            </button>
          );
        })}
      </div>
      <button type="button" className={BUTTON} onClick={() => app.runtime.interact(view.object.id, "newGame")}>
        New word
      </button>
    </div>
  );
};

// ── glowworm ─────────────────────────────────────────────────────────────

const KEYS: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" };

const Glowworm: ComponentRenderer = ({ view, app }) => {
  const size = Number(view.output("size") ?? 16);
  const body = Array.isArray(view.output("body")) ? (view.output("body") as number[][]) : [];
  const spark = Array.isArray(view.output("spark")) ? (view.output("spark") as number[]) : undefined;
  const state = text(view.output("state"), "ready");
  const act = (name: string, payload?: JsonValue): void => app.runtime.interact(view.object.id, name, payload);
  const overlay =
    state === "ready" ? "Press an arrow key or Start" : state === "paused" ? "Paused — press Space" : state === "over" ? `Game over · ${text(view.output("score"), "0")} sparks — press Space` : "";
  return (
    <div
      {...marks(view)}
      tabIndex={0}
      data-state={state}
      aria-label="Glowworm field. Arrow keys or W A S D steer, Space starts and pauses."
      className="flex flex-col items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onKeyDown={(event) => {
        const direction = KEYS[event.key];
        if (direction) {
          event.preventDefault();
          act("turn", direction);
        } else if (event.key === " ") {
          event.preventDefault();
          act("toggle");
        }
      }}
    >
      <div className="flex w-full max-w-sm items-center justify-between text-sm tabular-nums">
        <span className="font-medium text-ink" data-testid="glowworm-score">
          Sparks: {text(view.output("score"), "0")}
        </span>
        <span className="text-ink-soft">Best: {text(view.output("best"), "0")}</span>
      </div>
      <div className="relative w-full max-w-sm">
        <svg viewBox={`0 0 ${size} ${size}`} className="aspect-square w-full rounded-xl bg-[#121026]" role="img" aria-label={`Worm length ${body.length}`}>
          <defs>
            <radialGradient id={`spark-${view.object.id}`}>
              <stop offset="0%" stopColor="#fff7c2" />
              <stop offset="100%" stopColor="#ffb703" stopOpacity="0" />
            </radialGradient>
          </defs>
          {spark && <circle cx={(spark[0] ?? 0) + 0.5} cy={(spark[1] ?? 0) + 0.5} r={0.7} fill={`url(#spark-${view.object.id})`} />}
          {body.map(([x, y], index) => (
            <rect
              key={index}
              x={(x ?? 0) + 0.08}
              y={(y ?? 0) + 0.08}
              width={0.84}
              height={0.84}
              rx={0.35}
              fill={index === 0 ? "#d8ff7a" : "#7ee081"}
              opacity={index === 0 ? 1 : Math.max(0.35, 1 - index / (body.length + 4))}
            />
          ))}
        </svg>
        {overlay && <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl text-sm font-medium text-white/90">{overlay}</div>}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON} onClick={() => act("toggle")}>
          {state === "running" ? "Pause" : state === "over" ? "Play again" : "Start"}
        </button>
        <button type="button" className={BUTTON} onClick={() => act("newGame")}>
          New game
        </button>
        <div className="ml-2 grid grid-cols-3 gap-0.5" aria-label="Steer">
          <span />
          <button type="button" aria-label="Up" className="grid size-7 place-items-center rounded-md border border-line bg-surface" onClick={() => act("turn", "up")}>
            <ArrowUp className="size-3.5" />
          </button>
          <span />
          <button type="button" aria-label="Left" className="grid size-7 place-items-center rounded-md border border-line bg-surface" onClick={() => act("turn", "left")}>
            <ArrowLeft className="size-3.5" />
          </button>
          <button type="button" aria-label="Down" className="grid size-7 place-items-center rounded-md border border-line bg-surface" onClick={() => act("turn", "down")}>
            <ArrowDown className="size-3.5" />
          </button>
          <button type="button" aria-label="Right" className="grid size-7 place-items-center rounded-md border border-line bg-surface" onClick={() => act("turn", "right")}>
            <ArrowRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const gameRenderers: Record<string, ComponentRenderer> = {
  "game.ticTacToe": TicTacToe,
  "game.pairs": Pairs,
  "game.wordGuess": WordGuess,
  "game.glowworm": Glowworm,
};
