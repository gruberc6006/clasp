import { describe, expect, it } from "vitest";
import { validateGraph, type JsonObject } from "@clasp/core";
import { templates } from "@clasp/examples";
import { bestMove, lineOf, parseMarkdown } from "@clasp/primitives";
import type { TimerHost, Workspace } from "@clasp/runtime";
import { AppDriver, answerAccessRequest, openWorkspace } from "./support";

/** Timers that never fire, so tests step clocks and games by hand. */
const stillTimers: TimerHost = { setInterval: () => 0, clearInterval: () => undefined };

async function until(workspace: Workspace, check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await workspace.settle();
}

async function install(workspace: Workspace, id: string): Promise<AppDriver> {
  const template = templates.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`No template ${id}`);
  for (const schema of template.schemas?.(workspace.registry) ?? []) if (!workspace.schemas.has(schema.id, schema.version)) workspace.schemas.register(schema);
  const driver = new AppDriver(workspace, await workspace.install(template.build(workspace.registry)));
  await workspace.settle();
  return driver;
}

function lines(terminal: AppDriver): string[] {
  return ((terminal.output("Terminal", "lines") as JsonObject[] | undefined) ?? []).map((line) => String(line.text));
}

describe("templates", () => {
  it("every template builds a valid graph, installs and runs without errors", async () => {
    const { workspace } = await openWorkspace({ backend: "memory", timers: stillTimers });
    expect(templates.length).toBeGreaterThanOrEqual(23);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    for (const template of templates) {
      const graph = template.build(workspace.registry);
      const issues = validateGraph(graph, workspace.registry).filter((issue) => issue.severity === "error");
      expect(issues, template.id).toEqual([]);
      const app = await install(workspace, template.id);
      const errors = app.app.runtime.diagnostics().filter((diagnostic) => diagnostic.severity === "error");
      expect(errors, template.id).toEqual([]);
    }
  });
});

describe("tools", () => {
  it("Calculator: keypad arithmetic, precedence, errors and history", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const calc = await install(workspace, "calculator");
    await calc.interact("Calculator", "keys", "12+3×4=");
    expect(calc.output("Calculator", "display")).toBe("24");
    await calc.interact("Calculator", "keys", "÷4="); // continues from the result
    expect(calc.output("Calculator", "value")).toBe(6);
    await calc.interact("Calculator", "keys", "7÷0=");
    expect(calc.output("Calculator", "display")).toBe("Cannot divide by zero");
    await calc.interact("Calculator", "keys", "C50%×(1+1)=");
    expect(calc.output("Calculator", "display")).toBe("1");
    const history = (calc.output("Calculator", "history") as JsonObject[]).map((entry) => entry.title);
    expect(history).toEqual(["50%×(1+1) = 1", "24÷4 = 6", "12+3×4 = 24"]);
  });

  it("Word Processor: formatted page from Markdown, never links that run code, and saves as a document", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const writer = await install(workspace, "word-processor");
    await writer.interact("Page", "input", "# Plans\n\nWe **must** go *now*.\n\n- one\n- two\n\n[safe](https://example.org) [bad](javascript:alert(1))");
    expect(writer.output("Page", "words")).toBeGreaterThan(5);
    const blocks = writer.output("Page", "blocks") as JsonObject[];
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "paragraph"]);
    const links = (blocks[3]?.spans as JsonObject[]).filter((span) => span.text === "safe" || span.text === "bad");
    expect(links).toEqual([{ text: "safe", href: "https://example.org" }, { text: "bad" }]);

    dialogs.saves.push({ name: "Plans" });
    await writer.press("Save button");
    const [file] = files.list();
    expect(file).toMatchObject({ name: "Plans", kind: "richtext" });
    expect(parseMarkdown(String(files.get(file!.id)?.content))[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("Text Editor: writes text files that Notes can open, and opens a file it is given", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const editor = await install(workspace, "text-editor");
    await editor.interact("Editor", "input", "line one\nline two");
    expect(editor.output("Editor", "lines")).toBe(2);
    dialogs.saves.push({ name: "notes.txt" });
    await editor.press("Save button");
    const saved = files.list()[0]!;
    expect(saved.kind).toBe("text");

    // The desktop's way of opening a file in an application: grant it, then openFile.
    const created = await files.create("hello.txt", "text", "hello from disk");
    const document = editor.id("Document");
    await files.allow(created.id, editor.app.id, document);
    editor.app.runtime.invoke(document, "openFile", { fileId: created.id });
    await until(workspace, () => editor.output("Editor", "value") === "hello from disk", "the file to open");
    expect(editor.output("Document", "title")).toBe("hello.txt");
  });

  it("Terminal: commands run through the Universal API with this app's permissions only", async () => {
    const { workspace, notifications } = await openWorkspace({ backend: "memory" });
    const manager = await install(workspace, "task-manager");
    await manager.addTask("Water the plants");
    const terminal = await install(workspace, "terminal");
    const run = (line: string) => terminal.interact("Terminal", "run", line);

    await run("echo hello");
    await run("calc (2+3)*4");
    await run("calc alert(1)");
    await run("frobnicate");
    expect(lines(terminal)).toEqual([
      'Clasp terminal. Type "help" for commands.',
      "clasp> echo hello",
      "hello",
      "clasp> calc (2+3)*4",
      "20",
      "clasp> calc alert(1)",
      "calc understands numbers, + - * / %, and brackets.",
      "clasp> frobnicate",
      'Unknown command "frobnicate". Type "help".',
    ]);

    const tasks = manager.id("Tasks");
    await run(`query ${tasks}`);
    await until(workspace, () => lines(terminal).some((line) => line.startsWith("Not allowed")), "the denial");
    await run(`request ${tasks}`);
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the prompt");
    await answerAccessRequest(workspace, true);
    await until(workspace, () => lines(terminal).includes("Granted: collection.query"), "the grant");
    await run(`query ${tasks}`);
    await until(workspace, () => lines(terminal).some((line) => line.includes('title="Water the plants"')), "the records");

    await run("notify hi there");
    await until(workspace, () => lines(terminal).filter((line) => line.startsWith("Not allowed")).length === 2, "the notify denial");
    expect(notifications.list()).toHaveLength(0);
  });

  it("Terminal: talks over a socket to an allowed host", async () => {
    const { workspace, servers } = await openWorkspace({ backend: "memory" });
    const terminal = await install(workspace, "terminal");
    await terminal.interact("Terminal", "run", "connect wss://chat.example/");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the prompt");
    await answerAccessRequest(workspace, true);
    await until(workspace, () => lines(terminal).some((line) => line.startsWith("Connected to chat.example")), "the connection");
    await terminal.interact("Terminal", "run", "send ping");
    await until(workspace, () => lines(terminal).includes("← echo: ping"), "the echo");
    expect(servers.connections[0]?.sent).toEqual(["ping"]);
  });

  it("Clock: stopwatch counts and laps; the timer finishes", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const clock = await install(workspace, "clock");
    expect(String(clock.output("Clock", "display"))).toMatch(/^\d\d:\d\d:\d\d$/);
    await clock.interact("Clock", "mode", "stopwatch");
    await clock.interact("Clock", "start");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await clock.interact("Clock", "lap");
    await clock.interact("Clock", "stop");
    expect(Number(clock.output("Clock", "elapsed"))).toBeGreaterThanOrEqual(100);
    expect(clock.output("Clock", "laps")).toHaveLength(1);
    expect(clock.output("Clock", "running")).toBe(false);

    const finished: string[] = [];
    clock.app.runtime.onEvent((record) => record.event === "finished" && finished.push(record.event));
    await clock.interact("Clock", "mode", "timer");
    await clock.interact("Clock", "minutes", 1 / 60); // one second
    await clock.interact("Clock", "start");
    await until(workspace, () => finished.length === 1, "the timer");
    expect(clock.output("Clock", "display")).toBe("00:00");
  }, 10_000);

  it("Kanban Board: cards move between columns and the collection keeps up", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const board = await install(workspace, "kanban");
    await board.type("Title input", "Write the report");
    await board.press("Add card button");
    const items = (): JsonObject[] => board.rows("Card board");
    expect(items()).toHaveLength(1);
    expect(board.output("Card board", "counts")).toEqual({ "To do": 1, Doing: 0, Done: 0 });
    const id = String(items()[0]!.id);
    await board.interact("Card board", "move", { id, column: "Done" });
    expect(items()[0]!.status).toBe("Done");
    expect(board.output("Card board", "counts")).toEqual({ "To do": 0, Doing: 0, Done: 1 });
    await board.interact("Card board", "move", { id, column: "Nowhere" }); // ignored
    expect(items()[0]!.status).toBe("Done");
    await board.interact("Card board", "remove", { id });
    expect(items()).toHaveLength(0);
  });

  it("System Monitor: reads metrics only with permission, and stops when it is revoked", async () => {
    const { workspace } = await openWorkspace({ backend: "memory", timers: stillTimers });
    const monitor = await install(workspace, "system-monitor");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the prompt");
    expect(monitor.output("System Monitor", "status")).toBe("asking");
    await answerAccessRequest(workspace, true);
    await until(workspace, () => monitor.output("System Monitor", "status") === "live", "metrics");
    expect(monitor.output("System Monitor", "metrics")).toMatchObject({ busy: 12, fps: 60, cores: 8 });

    workspace.kernel.permissions.revokeWhere({ subject: monitor.app.id });
    await monitor.interact("System Monitor", "refresh");
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "a new prompt");
    await answerAccessRequest(workspace, false);
    await until(workspace, () => monitor.output("System Monitor", "status") === "denied", "the denial");
  });

  it("File Browser: lists files only once allowed, and opens them through the desktop with permission", async () => {
    const { workspace, files, launched } = await openWorkspace({ backend: "memory" });
    await files.create("Budget", "spreadsheet", { rows: 5, columns: 5, cells: {} });
    await files.create("Letter", "richtext", "# Dear friend");
    const browser = await install(workspace, "file-browser");
    expect(browser.visible("Access panel")).toBe(true);
    expect(browser.rows("File table", "rows")).toEqual([]);

    await browser.press("Allow button");
    await answerAccessRequest(workspace, true);
    await until(workspace, () => browser.rows("File table", "rows").length === 2, "the files");
    expect(browser.visible("Access panel")).toBe(false);
    expect(browser.rows("File table", "rows").map((row) => row.name)).toEqual(["Budget", "Letter"]);
    await browser.type("Search", "let");
    expect(browser.rows("File table", "rows").map((row) => row.name)).toEqual(["Letter"]);

    // Opening asks once for permission to use the desktop's "open".
    const letter = browser.rows("File table", "rows")[0]!;
    await browser.interact("File table", "rowAction", { id: String(letter.id) });
    await until(workspace, () => workspace.kernel.permissions.pendingRequests().length === 1, "the desktop prompt");
    expect(workspace.kernel.permissions.pendingRequests()[0]).toMatchObject({ resource: "clasp.desktop", actions: ["open"] });
    await answerAccessRequest(workspace, true);
    await until(workspace, () => launched.length === 1, "the launch");
    expect(launched[0]?.name).toBe("Letter");

    // An app that cannot list files cannot open them either.
    const other = await install(workspace, "calculator");
    workspace.kernel.permissions.grant({ subject: other.app.id, resource: "clasp.desktop", capability: "capability.invoke", actions: ["open"] });
    await expect(workspace.kernel.connect(other.app.id).invoke({ target: "clasp.desktop", action: "open", arguments: { fileId: letter.id as string } })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("games", () => {
  it("the perfect tic-tac-toe player never loses", () => {
    // Every possible game where X moves anywhere and O answers perfectly.
    const play = (board: string[]): void => {
      for (let cell = 0; cell < 9; cell++) {
        if (board[cell] !== "") continue;
        const next = [...board];
        next[cell] = "X";
        expect(lineOf(next)?.mark).not.toBe("X");
        if (lineOf(next) || next.every((value) => value !== "")) continue;
        next[bestMove(next, "O", "X")] = "O";
        if (!lineOf(next)) play(next);
      }
    };
    play(Array<string>(9).fill(""));
  });

  it("Tic-tac-toe: a finished game lands in the high scores", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const game = await install(workspace, "tic-tac-toe");
    workspace.requireApp(game.app.id).store.transact([{ op: "update", objectId: game.id("Game"), properties: { difficulty: "easy", seed: 7 } }]);
    await workspace.settle();
    for (let guard = 0; guard < 9 && game.output("Game", "outcome") === "playing"; guard++) {
      const board = game.output("Game", "board") as string[];
      await game.interact("Game", "play", board.indexOf(""));
    }
    expect(["won", "lost", "draw"]).toContain(game.output("Game", "outcome"));
    expect(game.rows("High scores")).toHaveLength(1);
    expect(String(game.rows("High scores")[0]?.summary)).toMatch(/computer \(easy\)/);
  });

  it("Pairs: matching every pair finishes the game, and face-down cards never reveal their symbol", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const game = await install(workspace, "pairs");
    const cards = (): JsonObject[] => game.output("Game", "cards") as JsonObject[];
    expect(cards()).toHaveLength(16);
    expect(cards().every((card) => card.symbol === "")).toBe(true);
    // Play like a person with a perfect memory: look at every card, then match.
    const seen = new Map<number, string>();
    for (let index = 0; index < 16; index++) {
      await game.interact("Game", "flip", index);
      seen.set(index, String(cards()[index]?.symbol));
    }
    for (const [index, symbol] of seen) {
      if (cards()[index]?.matched) continue;
      const twin = [...seen.entries()].find(([other, value]) => other !== index && value === symbol)![0];
      await game.interact("Game", "flip", index);
      await game.interact("Game", "flip", twin);
    }
    expect(game.output("Game", "found")).toBe(8);
    expect(game.rows("High scores")).toHaveLength(1);
    expect(String(game.rows("High scores")[0]?.summary)).toMatch(/^Found 8 pairs in \d+ moves$/);
  });

  it("Word Guess: winning, losing, and ignoring repeats", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const game = await install(workspace, "word-guess");
    workspace.requireApp(game.app.id).store.transact([{ op: "update", objectId: game.id("Game"), properties: { words: ["kiwi"], lives: 2 } }]);
    await workspace.settle();
    await game.interact("Game", "newGame");
    expect(game.output("Game", "pattern")).toBe("_ _ _ _");
    await game.interact("Game", "guess", "k");
    await game.interact("Game", "guess", "k");
    await game.interact("Game", "guess", "z");
    expect(game.output("Game", "lives")).toBe(1);
    await game.interact("Game", "guess", "i");
    await game.interact("Game", "guess", "w");
    expect(game.output("Game", "outcome")).toBe("won");
    await game.interact("Game", "newGame");
    await game.interact("Game", "guess", "x");
    await game.interact("Game", "guess", "y");
    expect(game.output("Game", "outcome")).toBe("lost");
    expect(game.output("Game", "answer")).toBe("kiwi");
    expect(game.rows("High scores").map((row) => row.won)).toEqual([true, false]);
  });

  it("Glowworm: steering, eating, and crashing into the wall ends the game", async () => {
    const { workspace } = await openWorkspace({ backend: "memory", timers: stillTimers });
    const game = await install(workspace, "glowworm");
    expect(game.output("Game", "state")).toBe("ready");
    await game.interact("Game", "turn", "left"); // reversing is not allowed
    expect(game.output("Game", "state")).toBe("ready");
    await game.interact("Game", "turn", "up"); // the first turn starts the game
    expect(game.output("Game", "state")).toBe("running");
    for (let step = 0; step < 40 && game.output("Game", "state") === "running"; step++) game.app.runtime.invoke(game.id("Game"), "step");
    await workspace.settle();
    expect(game.output("Game", "state")).toBe("over");
    expect(game.rows("High scores")).toHaveLength(1);
    expect(String(game.rows("High scores")[0]?.summary)).toMatch(/^Ate \d+ sparks?, grew to \d+$/);
  });
});
