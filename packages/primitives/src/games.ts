import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentContext, ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asNumber, asText } from "./helpers";

/**
 * Small games. Each holds its rules and state; the renderer draws it. When a
 * game ends it emits "finished" with a score record ({ game, score, won,
 * summary, playedOn }) — connect it to a clasp.score collection's "create"
 * to keep a high-score list.
 */

// ── shared ───────────────────────────────────────────────────────────────

/** A small seeded random number generator (mulberry32), so games can be replayed in tests. */
export function nextRandom(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  t = (r ^ (r >>> 14)) >>> 0;
  return [t / 4294967296, (seed + 0x6d2b79f5) | 0];
}

function randomFor(ctx: ComponentContext): () => number {
  return () => {
    const seed = ctx.getState<number>("rng") ?? (asNumber(ctx.props.seed) || Date.now() % 2147483647);
    const [value, next] = nextRandom(seed);
    ctx.setState("rng", next);
    return value;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

function playedOn(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function result(game: string, score: number, won: boolean, summary: string): JsonObject {
  return { game, score, won, summary, playedOn: playedOn() };
}

const SEED = { name: "seed", type: "number" as const, default: 0, title: "Random seed", description: "0 picks a new one each time; any other number replays the same games." };
const FINISHED = { name: "finished", payload: "record" as const, description: "The game ended: { game, score, won, summary, playedOn } — ready for a clasp.score collection." };

// ── tic-tac-toe ──────────────────────────────────────────────────────────

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function lineOf(board: readonly string[]): { mark: string; line: number[] } | undefined {
  for (const line of LINES) {
    const [a, b, c] = line as [number, number, number];
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { mark: board[a] as string, line };
  }
  return undefined;
}

/** The best move for `me` by full search (minimax). Prefers quicker wins and slower losses. */
export function bestMove(board: readonly string[], me: string, them: string): number {
  const score = (state: string[], turn: string, depth: number): number => {
    const won = lineOf(state);
    if (won) return won.mark === me ? 10 - depth : depth - 10;
    if (state.every((cell) => cell !== "")) return 0;
    const scores: number[] = [];
    state.forEach((cell, index) => {
      if (cell !== "") return;
      state[index] = turn;
      scores.push(score(state, turn === me ? them : me, depth + 1));
      state[index] = "";
    });
    return turn === me ? Math.max(...scores) : Math.min(...scores);
  };
  let best = -1;
  let bestScore = -Infinity;
  const state = [...board];
  state.forEach((cell, index) => {
    if (cell !== "") return;
    state[index] = me;
    const value = score(state, them, 1);
    state[index] = "";
    if (value > bestScore) {
      bestScore = value;
      best = index;
    }
  });
  return best;
}

const ticTacToe: ComponentDefinition = {
  type: "game.ticTacToe",
  version: 1,
  category: "game",
  title: "Tic-tac-toe",
  description: 'Three in a row against the computer. You are X. "difficulty" is easy, normal or perfect (the computer never loses).',
  properties: [{ name: "difficulty", type: "enum", options: ["easy", "normal", "perfect"], default: "normal", title: "Difficulty" }, SEED],
  inputs: [VISIBLE],
  outputs: [
    { name: "board", type: "list", description: "Nine cells: X, O or empty." },
    { name: "status", type: "string" },
    { name: "outcome", type: "string", description: "playing, won, lost or draw." },
    { name: "line", type: "list", description: "The winning cells." },
    { name: "tally", type: "object", description: "{ won, lost, drawn } this session." },
  ],
  events: [FINISHED],
  actions: [{ name: "newGame" }],
  create: (ctx) => {
    const random = randomFor(ctx);
    const board = (): string[] => ctx.getState<string[]>("board") ?? Array<string>(9).fill("");
    const publish = (): void => {
      const cells = board();
      const outcome = ctx.getState<string>("outcome") ?? "playing";
      ctx.setOutput("board", cells);
      ctx.setOutput("outcome", outcome);
      ctx.setOutput("line", lineOf(cells)?.line ?? []);
      ctx.setOutput("tally", ctx.getState<JsonObject>("tally") ?? { won: 0, lost: 0, drawn: 0 });
      ctx.setOutput(
        "status",
        outcome === "won" ? "You win!" : outcome === "lost" ? "The computer wins." : outcome === "draw" ? "A draw." : "Your move — you are X.",
      );
    };
    const finish = (outcome: "won" | "lost" | "draw"): void => {
      ctx.setState("outcome", outcome);
      const tally = { won: 0, lost: 0, drawn: 0, ...(ctx.getState<JsonObject>("tally") ?? {}) } as Record<string, number>;
      const key = outcome === "draw" ? "drawn" : outcome;
      tally[key] = (tally[key] ?? 0) + 1;
      ctx.setState("tally", tally);
      publish();
      const level = asText(ctx.props.difficulty, "normal");
      const summary = outcome === "won" ? `Beat the computer (${level})` : outcome === "lost" ? `Lost to the computer (${level})` : `Drew with the computer (${level})`;
      ctx.emit("finished", result("Tic-tac-toe", outcome === "won" ? 2 : outcome === "draw" ? 1 : 0, outcome === "won", summary));
    };
    const settle = (cells: string[]): boolean => {
      const won = lineOf(cells);
      if (won) {
        finish(won.mark === "X" ? "won" : "lost");
        return true;
      }
      if (cells.every((cell) => cell !== "")) {
        finish("draw");
        return true;
      }
      return false;
    };
    const computer = (cells: string[]): void => {
      const empty = cells.map((cell, index) => (cell === "" ? index : -1)).filter((index) => index >= 0);
      const level = asText(ctx.props.difficulty, "normal");
      const smart = level === "perfect" || (level === "normal" && random() < 0.7);
      const move = smart ? bestMove(cells, "O", "X") : (empty[Math.floor(random() * empty.length)] as number);
      cells[move] = "O";
    };
    const newGame = (): void => {
      // Players take turns to start.
      const computerStarts = ctx.getState<boolean>("computerStarts") === true;
      ctx.setState("computerStarts", !computerStarts);
      const cells = Array<string>(9).fill("");
      if (computerStarts) computer(cells);
      ctx.setState("board", cells);
      ctx.setState("outcome", "playing");
      publish();
    };
    publish();
    return {
      actions: { newGame },
      interactions: {
        newGame,
        play: (payload) => {
          const index = asNumber(payload);
          const cells = board();
          if (index === undefined || index < 0 || index > 8 || cells[index] !== "" || (ctx.getState<string>("outcome") ?? "playing") !== "playing") return;
          cells[index] = "X";
          if (!settle(cells)) {
            computer(cells);
            settle(cells);
          }
          ctx.setState("board", cells);
          publish();
        },
      },
    };
  },
};

// ── pairs (memory) ───────────────────────────────────────────────────────

export const PAIR_SYMBOLS = ["🍎", "🌙", "⭐", "🌵", "🎈", "🐟", "🍄", "🔔", "🌻", "🧩", "🚲", "🎲"];

const pairs: ComponentDefinition = {
  type: "game.pairs",
  version: 1,
  category: "game",
  title: "Pairs",
  description: "A memory game: turn over two cards at a time and find every matching pair in as few moves as you can.",
  properties: [{ name: "pairs", type: "number", default: 8, title: "Pairs (4–12)" }, SEED],
  inputs: [VISIBLE],
  outputs: [
    { name: "cards", type: "records", description: "{ id, symbol (only when face up), faceUp, matched }" },
    { name: "moves", type: "number" },
    { name: "found", type: "number" },
    { name: "total", type: "number" },
    { name: "status", type: "string" },
  ],
  events: [FINISHED],
  actions: [{ name: "newGame" }],
  create: (ctx) => {
    const random = randomFor(ctx);
    const count = (): number => Math.min(12, Math.max(4, Math.round(asNumber(ctx.props.pairs) ?? 8)));
    const deck = (): string[] => ctx.getState<string[]>("deck") ?? [];
    const publish = (): void => {
      const symbols = deck();
      const matched = ctx.getState<boolean[]>("matched") ?? [];
      const open = ctx.getState<number[]>("open") ?? [];
      const found = matched.filter(Boolean).length / 2;
      const moves = ctx.getState<number>("moves") ?? 0;
      // Face-down cards carry no symbol, so the answer is not in the page.
      ctx.setOutput(
        "cards",
        symbols.map((symbol, index) => {
          const faceUp = matched[index] === true || open.includes(index);
          return { id: `card-${index}`, index, symbol: faceUp ? symbol : "", faceUp, matched: matched[index] === true };
        }),
      );
      ctx.setOutput("moves", moves);
      ctx.setOutput("found", found);
      ctx.setOutput("total", symbols.length / 2);
      const counted = `${moves} ${moves === 1 ? "move" : "moves"}`;
      ctx.setOutput("status", symbols.length > 0 && found === symbols.length / 2 ? `All ${found} pairs in ${counted}!` : `${found} of ${symbols.length / 2} pairs · ${counted}`);
    };
    const newGame = (): void => {
      const chosen = shuffle(PAIR_SYMBOLS, random).slice(0, count());
      ctx.setState("deck", shuffle([...chosen, ...chosen], random));
      ctx.setState("matched", Array<boolean>(chosen.length * 2).fill(false));
      ctx.setState("open", []);
      ctx.setState("moves", 0);
      publish();
    };
    if (deck().length === 0) newGame();
    else publish();
    return {
      actions: { newGame },
      interactions: {
        newGame,
        flip: (payload) => {
          const index = asNumber(payload);
          const symbols = deck();
          const matched = [...(ctx.getState<boolean[]>("matched") ?? [])];
          let open = [...(ctx.getState<number[]>("open") ?? [])];
          if (index === undefined || index < 0 || index >= symbols.length || matched[index] || open.includes(index)) return;
          if (open.length === 2) open = []; // a mismatched pair turns back over
          open.push(index);
          if (open.length === 2) {
            const moves = (ctx.getState<number>("moves") ?? 0) + 1;
            ctx.setState("moves", moves);
            const [a, b] = open as [number, number];
            if (symbols[a] === symbols[b]) {
              matched[a] = true;
              matched[b] = true;
              open = [];
              ctx.setState("matched", matched);
              if (matched.every(Boolean)) {
                ctx.setState("open", []);
                publish();
                const total = symbols.length / 2;
                ctx.emit("finished", result("Pairs", Math.max(0, 100 - 5 * (moves - total)), true, `Found ${total} pairs in ${moves} moves`));
                return;
              }
            }
          }
          ctx.setState("open", open);
          publish();
        },
      },
    };
  },
};

// ── word guess ───────────────────────────────────────────────────────────

export const GUESS_WORDS = [
  "anchor", "apple", "bakery", "banjo", "basket", "beacon", "bicycle", "blanket", "bridge", "bubble",
  "cactus", "camera", "candle", "canyon", "castle", "cherry", "circus", "cliff", "comet", "compass",
  "cookie", "copper", "cotton", "crystal", "dolphin", "dragon", "echo", "falcon", "feather", "forest",
  "fossil", "galaxy", "garden", "giraffe", "glacier", "harbor", "harvest", "helmet", "island", "jacket",
  "jungle", "kettle", "kitten", "ladder", "lantern", "lemon", "lizard", "magnet", "maple", "meadow",
  "mirror", "monkey", "mountain", "noodle", "ocean", "orange", "orchid", "otter", "paddle", "parrot",
  "pebble", "pencil", "pepper", "piano", "pickle", "pillow", "planet", "pocket", "pretzel", "puzzle",
  "quartz", "rabbit", "rainbow", "river", "rocket", "saddle", "salmon", "sandal", "season", "shadow",
  "silver", "sketch", "spider", "sponge", "squirrel", "summit", "sunset", "teapot", "thunder", "ticket",
  "tiger", "tomato", "tractor", "trumpet", "tunnel", "turtle", "umbrella", "valley", "velvet", "violin",
  "voyage", "walnut", "whistle", "window", "winter", "wizard", "yogurt", "zebra",
];

const wordGuess: ComponentDefinition = {
  type: "game.wordGuess",
  version: 1,
  category: "game",
  title: "Word guess",
  description: "Guess the hidden word one letter at a time before you run out of lives.",
  properties: [{ name: "lives", type: "number", default: 6, title: "Lives" }, { name: "words", type: "list", title: "Words", description: "Your own word list (letters only); the built-in list when empty." }, SEED],
  inputs: [VISIBLE],
  outputs: [
    { name: "pattern", type: "string", description: "The word with unguessed letters as _ ." },
    { name: "letters", type: "records", description: "a–z: { letter, state: unused|hit|miss }" },
    { name: "lives", type: "number" },
    { name: "maxLives", type: "number" },
    { name: "outcome", type: "string", description: "playing, won or lost." },
    { name: "answer", type: "string", description: "The word, once the game is over." },
    { name: "status", type: "string" },
  ],
  events: [FINISHED],
  actions: [{ name: "newGame" }, { name: "guess", payload: "string" }],
  create: (ctx) => {
    const random = randomFor(ctx);
    const maxLives = (): number => Math.min(12, Math.max(1, Math.round(asNumber(ctx.props.lives) ?? 6)));
    const words = (): string[] => {
      const own = Array.isArray(ctx.props.words) ? ctx.props.words.filter((word): word is string => typeof word === "string" && /^[a-z]{2,20}$/i.test(word)) : [];
      return own.length > 0 ? own.map((word) => word.toLowerCase()) : GUESS_WORDS;
    };
    const publish = (): void => {
      const word = ctx.getState<string>("word") ?? "";
      const guessed = ctx.getState<string[]>("guessed") ?? [];
      const outcome = ctx.getState<string>("outcome") ?? "playing";
      const lives = ctx.getState<number>("lives") ?? maxLives();
      ctx.setOutput("pattern", [...word].map((letter) => (guessed.includes(letter) || outcome !== "playing" ? letter : "_")).join(" "));
      ctx.setOutput(
        "letters",
        [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => ({ id: letter, letter, state: guessed.includes(letter) ? (word.includes(letter) ? "hit" : "miss") : "unused" })),
      );
      ctx.setOutput("lives", lives);
      ctx.setOutput("maxLives", maxLives());
      ctx.setOutput("outcome", outcome);
      ctx.setOutput("answer", outcome === "playing" ? "" : word);
      ctx.setOutput("status", outcome === "won" ? "You got it!" : outcome === "lost" ? `Out of lives — it was “${word}”.` : `${lives} ${lives === 1 ? "life" : "lives"} left`);
    };
    const newGame = (): void => {
      const list = words();
      ctx.setState("word", list[Math.floor(random() * list.length)] as string);
      ctx.setState("guessed", []);
      ctx.setState("lives", maxLives());
      ctx.setState("outcome", "playing");
      publish();
    };
    const guess = (payload: JsonValue | undefined): void => {
      const letter = asText(isJsonObject(payload) ? payload.letter : payload).toLowerCase();
      if (!/^[a-z]$/.test(letter) || (ctx.getState<string>("outcome") ?? "playing") !== "playing") return;
      const guessed = ctx.getState<string[]>("guessed") ?? [];
      if (guessed.includes(letter)) return;
      const word = ctx.getState<string>("word") ?? "";
      const next = [...guessed, letter];
      ctx.setState("guessed", next);
      let lives = ctx.getState<number>("lives") ?? maxLives();
      if (!word.includes(letter)) {
        lives -= 1;
        ctx.setState("lives", lives);
      }
      if ([...word].every((character) => next.includes(character))) {
        ctx.setState("outcome", "won");
        publish();
        ctx.emit("finished", result("Word guess", lives * 10 + word.length, true, `Guessed “${word}” with ${lives} ${lives === 1 ? "life" : "lives"} left`));
        return;
      }
      if (lives <= 0) {
        ctx.setState("outcome", "lost");
        publish();
        ctx.emit("finished", result("Word guess", 0, false, `Missed “${word}”`));
        return;
      }
      publish();
    };
    if (!ctx.getState<string>("word")) newGame();
    else publish();
    return { actions: { newGame, guess }, interactions: { newGame, guess } };
  },
};

// ── glowworm ─────────────────────────────────────────────────────────────

type Point = [number, number];
const DIRECTIONS: Record<string, Point> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const glowworm: ComponentDefinition = {
  type: "game.glowworm",
  version: 1,
  category: "game",
  title: "Glowworm",
  description: "Steer a glowworm around a dark field to eat sparks. Each spark makes it longer; don't hit the walls or yourself. Arrow keys or WASD steer, Space pauses.",
  properties: [
    { name: "size", type: "number", default: 16, title: "Field size (cells)" },
    { name: "speed", type: "number", default: 140, title: "Step time (ms)" },
    SEED,
  ],
  inputs: [VISIBLE],
  outputs: [
    { name: "size", type: "number" },
    { name: "body", type: "list", description: "Cells of the worm, head first: [x, y]." },
    { name: "spark", type: "list", description: "The spark's cell: [x, y]." },
    { name: "score", type: "number" },
    { name: "best", type: "number", description: "Best score this session." },
    { name: "state", type: "string", description: "ready, running, paused or over." },
  ],
  events: [FINISHED],
  actions: [{ name: "newGame" }, { name: "step", description: "Advances one step (the game's clock calls this while running)." }],
  create: (ctx) => {
    const random = randomFor(ctx);
    const size = (): number => Math.min(32, Math.max(8, Math.round(asNumber(ctx.props.size) ?? 16)));
    let stopClock: (() => void) | undefined;
    const publish = (): void => {
      ctx.setOutput("size", size());
      ctx.setOutput("body", ctx.getState<Point[]>("body") ?? []);
      ctx.setOutput("spark", ctx.getState<Point>("spark") ?? null);
      ctx.setOutput("score", ctx.getState<number>("score") ?? 0);
      ctx.setOutput("best", ctx.getState<number>("best") ?? 0);
      ctx.setOutput("state", ctx.getState<string>("state") ?? "ready");
    };
    const placeSpark = (body: Point[]): Point | null => {
      const free: Point[] = [];
      for (let y = 0; y < size(); y++) for (let x = 0; x < size(); x++) if (!body.some(([bx, by]) => bx === x && by === y)) free.push([x, y]);
      return free.length > 0 ? (free[Math.floor(random() * free.length)] as Point) : null;
    };
    const clock = (running: boolean): void => {
      stopClock?.();
      stopClock = running ? ctx.setInterval(step, Math.min(1000, Math.max(60, asNumber(ctx.props.speed) ?? 140))) : undefined;
    };
    const newGame = (): void => {
      const middle = Math.floor(size() / 2);
      const body: Point[] = [
        [middle, middle],
        [middle - 1, middle],
        [middle - 2, middle],
      ];
      ctx.setState("body", body);
      ctx.setState("direction", "right");
      ctx.setState("queued", []);
      ctx.setState("spark", placeSpark(body));
      ctx.setState("score", 0);
      ctx.setState("state", "ready");
      clock(false);
      publish();
    };
    function step(): void {
      if (ctx.getState<string>("state") !== "running") return;
      const queued = ctx.getState<string[]>("queued") ?? [];
      const direction = queued[0] ?? ctx.getState<string>("direction") ?? "right";
      ctx.setState("queued", queued.slice(1));
      ctx.setState("direction", direction);
      const body = ctx.getState<Point[]>("body") ?? [];
      const [dx, dy] = DIRECTIONS[direction] as Point;
      const head = body[0] as Point;
      const next: Point = [head[0] + dx, head[1] + dy];
      const spark = ctx.getState<Point>("spark");
      const eats = spark !== undefined && spark !== null && spark[0] === next[0] && spark[1] === next[1];
      const rest = eats ? body : body.slice(0, -1);
      const crashed = next[0] < 0 || next[1] < 0 || next[0] >= size() || next[1] >= size() || rest.some(([x, y]) => x === next[0] && y === next[1]);
      if (crashed) {
        ctx.setState("state", "over");
        clock(false);
        const score = ctx.getState<number>("score") ?? 0;
        ctx.setState("best", Math.max(score, ctx.getState<number>("best") ?? 0));
        publish();
        ctx.emit("finished", result("Glowworm", score, false, `Ate ${score} spark${score === 1 ? "" : "s"}, grew to ${body.length}`));
        return;
      }
      const grown: Point[] = [next, ...rest];
      ctx.setState("body", grown);
      if (eats) {
        ctx.setState("score", (ctx.getState<number>("score") ?? 0) + 1);
        ctx.setState("spark", placeSpark(grown));
      }
      publish();
    }
    const toggle = (): void => {
      const state = ctx.getState<string>("state") ?? "ready";
      if (state === "over") {
        newGame();
        ctx.setState("state", "running");
      } else ctx.setState("state", state === "running" ? "paused" : "running");
      clock(ctx.getState<string>("state") === "running");
      publish();
    };
    if (!ctx.getState<Point[]>("body")) newGame();
    else {
      if (ctx.getState<string>("state") === "running") ctx.setState("state", "paused");
      publish();
    }
    return {
      actions: { newGame, step },
      interactions: {
        newGame,
        toggle,
        turn: (payload) => {
          const direction = asText(payload);
          if (!DIRECTIONS[direction]) return;
          const queued = ctx.getState<string[]>("queued") ?? [];
          const last = queued[queued.length - 1] ?? ctx.getState<string>("direction") ?? "right";
          const [lx, ly] = DIRECTIONS[last] as Point;
          const [nx, ny] = DIRECTIONS[direction] as Point;
          if (direction === last || (lx + nx === 0 && ly + ny === 0)) return; // no reversing into yourself
          ctx.setState("queued", [...queued, direction].slice(-3));
          if ((ctx.getState<string>("state") ?? "ready") === "ready") toggle();
        },
      },
      dispose: () => stopClock?.(),
    };
  },
};

export const gamePrimitives: ComponentDefinition[] = [ticTacToe, pairs, wordGuess, glowworm];
