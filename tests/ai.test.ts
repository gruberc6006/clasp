import {
  GraphAssistant,
  OllamaProvider,
  isPlaceholderName,
  ScriptedProvider,
  applyProposal,
  buildHandles,
  buildSystemPrompt,
  buildUserPrompt,
  parsePlan,
  resolvePlan,
  type AIProvider,
  type ChatMessage,
  type GraphPlan,
} from "@clasp/ai";
import { ClaspError, createGraph } from "@clasp/core";
import { buildTaskManager } from "@clasp/examples";
import { describe, expect, it } from "vitest";
import { AppDriver, expectCode, openWorkspace } from "./support";

const CREATE = "Create a simple task manager with a title field, an Add Task button, and a list of tasks.";
const FILTER = "Add a filter to show only incomplete tasks.";

/** A provider that replays fixed replies, to exercise the validation and repair loop. */
function replay(replies: Array<GraphPlan | string>): AIProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let index = 0;
  return {
    id: "replay",
    label: "Replay (test)",
    kind: "scripted",
    seen,
    status: async () => ({ available: true, models: ["replay"], model: "replay" }),
    complete: async ({ messages }) => {
      seen.push(messages.map((message) => ({ ...message })));
      const reply = replies[Math.min(index++, replies.length - 1)]!;
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  };
}

async function blankApp() {
  const session = await openWorkspace({ backend: "memory" });
  const app = await session.workspace.install(createGraph({ name: "Untitled app" }));
  const assistant = (provider: AIProvider, maxRepairs = 2) =>
    new GraphAssistant({ provider, registry: session.workspace.registry, schemas: session.workspace.schemas, maxRepairs });
  return { ...session, app, assistant };
}

describe("what the model is shown", () => {
  it("gets the component catalog, the schemas and only the application being edited", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("A private record");
    const other = await workspace.install(createGraph({ name: "Other app" }));

    const system = buildSystemPrompt({ registry: workspace.registry, schemas: workspace.schemas });
    for (const type of ["ui.window", "ui.form", "ui.list", "data.collection", "data.filter", "logic.compare", "workflow.notify"]) {
      expect(system).toContain(type);
    }
    expect(system).toContain("clasp.task — title:string required, completed:boolean =false");
    expect(system).toContain('variant:enum(primary|secondary|ghost|danger)="secondary"');

    const prompt = buildUserPrompt({ request: FILTER, graph: manager.app.store.graph });
    expect(prompt).toContain('tasks: data.collection "Tasks" {"schema":"clasp.task","exposure":"discoverable"}');
    expect(prompt).toContain("statusFilter.records -> taskList.items");
    expect(prompt).toContain(`REQUEST: ${FILTER}`);
    // No ids, no records, no other applications.
    expect(prompt).not.toContain(manager.id("Tasks"));
    expect(prompt).not.toContain("A private record");
    expect(prompt).not.toContain("Other app");
    expect(buildUserPrompt({ request: "x", graph: other.store.graph })).toContain("is empty");
    // The whole prompt stays well inside the 16K-token context Clasp asks Ollama for (about 4 characters a token).
    expect(system.length + prompt.length).toBeLessThan(32_000);
  });

  it("gives objects stable, readable handles", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const graph = buildTaskManager(workspace.registry);
    const handles = [...buildHandles(graph).keys()];
    expect(handles).toEqual(expect.arrayContaining(["tasks", "window", "newTaskForm", "titleInput", "addButton", "taskList", "statusFilter"]));
    expect(new Set(handles).size).toBe(handles.length);
    expect([...buildHandles(graph).keys()]).toEqual(handles);
  });
});

describe("generation with the scripted test provider (no model involved)", () => {
  it("creates a working task manager, then adds a filter without touching the data", async () => {
    const { workspace, app, assistant } = await blankApp();
    const provider = new ScriptedProvider();
    expect(provider.kind).toBe("scripted");
    expect(provider.label).toContain("not an AI");

    // ── request 1: create ────────────────────────────────────────────────
    const proposal = await assistant(provider).propose({ request: CREATE, graph: app.store.graph });
    expect(proposal.provider).toMatchObject({ id: "scripted", kind: "scripted" });
    expect(proposal.attempts).toBe(1);
    // Proposing changed nothing: the AI cannot mutate an application.
    expect(Object.keys(app.store.graph.objects)).toHaveLength(0);
    // Only additions — plus naming the still-untitled application.
    expect(proposal.operations.every((operation) => ["create", "connect"].includes(operation.op) || (operation.op === "setMetadata" && operation.name === "Task Manager"))).toBe(true);

    applyProposal(app.store, proposal);
    await workspace.settle();
    const types = Object.values(app.store.graph.objects).map((object) => object.type).sort();
    expect(types).toEqual(["data.collection", "ui.button", "ui.form", "ui.list", "ui.textInput", "ui.window"]);
    expect(app.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);

    // The generated application actually works — with no model in the loop.
    const driver = new AppDriver(workspace, app);
    await driver.type("Title input", "Buy milk");
    await driver.press("Add Task button");
    await driver.type("Title input", "Walk the dog");
    await driver.press("Add Task button");
    expect(driver.titles("Task list")).toEqual(["Buy milk", "Walk the dog"]);
    const [milk] = driver.rows("Task list");
    await driver.interact("Task list", "toggle", { id: milk!.id as string });
    expect(driver.rows("Task list")[0]?.completed).toBe(true);
    const collectionId = driver.id("Tasks");

    // ── request 2: modify ────────────────────────────────────────────────
    const change = await assistant(provider).propose({ request: FILTER, graph: app.store.graph });
    expect(change.operations.map((operation) => operation.op)).toEqual(["create", "connect", "disconnect", "connect"]);
    expect(change.operations.some((operation) => operation.op === "delete")).toBe(false);
    applyProposal(app.store, change);
    await workspace.settle();

    // Same collection, same records — only the view changed.
    expect(driver.id("Tasks")).toBe(collectionId);
    expect(workspace.kernel.data.count(collectionId)).toBe(2);
    expect(driver.titles("Task list")).toEqual(["Walk the dog"]);
    expect(app.store.graph.objects[driver.id("Incomplete filter")]?.properties).toEqual({ field: "completed", operator: "eq", value: false });

    // It is one undoable transaction, like any other edit.
    app.store.undo();
    await workspace.settle();
    expect(driver.titles("Task list")).toEqual(["Buy milk", "Walk the dog"]);
    app.store.redo();
    await workspace.settle();
    expect(driver.titles("Task list")).toEqual(["Walk the dog"]);
  });

  it("refuses requests it has no script for, and says it is not an AI", async () => {
    const { app, assistant } = await blankApp();
    const error = await expectCode(assistant(new ScriptedProvider()).propose({ request: "Build a spaceship", graph: app.store.graph }), "UNAVAILABLE");
    expect(error.message).toContain("not an AI");
    await expectCode(assistant(new ScriptedProvider()).propose({ request: "   ", graph: app.store.graph }), "VALIDATION_FAILED");
  });
});

describe("validation and repair", () => {
  const broken: GraphPlan = {
    summary: "Broken",
    operations: [
      { op: "create", ref: "win", type: "ui.window", name: "Window" },
      { op: "create", ref: "go", type: "ui.megaButton", name: "Go", parent: "win" },
      { op: "create", ref: "label", type: "ui.text", name: "Label", parent: "win", properties: { colour: "red" } },
      { op: "connect", from: "label.display", to: "nowhere.value" },
      { op: "connect", from: "label.display", to: "win.submit" },
    ],
  };
  const fixed: GraphPlan = {
    summary: "Fixed",
    operations: [
      { op: "create", ref: "win", type: "ui.window", name: "Window" },
      { op: "create", ref: "go", type: "ui.button", name: "Go", parent: "win" },
      { op: "create", ref: "label", type: "ui.text", name: "Label", parent: "win", properties: { text: "Hello" } },
    ],
  };

  it("sends precise errors back to the model and accepts the corrected plan", async () => {
    const { app, assistant } = await blankApp();
    const provider = replay([broken, fixed]);
    const stages: string[] = [];
    const proposal = await assistant(provider).propose({
      request: "Make a hello window",
      graph: app.store.graph,
      onProgress: (progress) => stages.push(progress.stage),
    });
    expect(proposal.attempts).toBe(2);
    expect(proposal.summary).toBe("Fixed");
    expect(stages).toEqual(["asking", "validating", "repairing", "asking", "validating"]);

    const feedback = provider.seen[1]!.at(-1)!.content;
    expect(feedback).toContain('Unknown component type "ui.megaButton". Did you mean "ui.button"?');
    expect(feedback).toContain('ui.text has no property "colour"');
    expect(feedback).toContain('Unknown handle "nowhere"');
    expect(provider.seen[1]!.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("gives up with a structured explanation and leaves the application untouched", async () => {
    const { app, assistant } = await blankApp();
    const before = app.store.graph;
    const provider = replay([broken]);
    const error = await expectCode(assistant(provider, 1).propose({ request: "Make a hello window", graph: app.store.graph }), "VALIDATION_FAILED");
    expect(provider.seen).toHaveLength(2);
    expect(error.issues.length).toBeGreaterThanOrEqual(3);
    expect(String(error.details.explanation)).toContain("ui.megaButton");
    expect(app.store.graph).toBe(before);
  });

  it("recovers from replies that are not JSON at all", async () => {
    const { app, assistant } = await blankApp();
    const provider = replay(["Sure! Here is your app.", "```json\n" + JSON.stringify(fixed) + "\n```"]);
    const proposal = await assistant(provider).propose({ request: "Make a hello window", graph: app.store.graph });
    expect(proposal.attempts).toBe(2);
    expect(provider.seen[1]!.at(-1)!.content).toContain("not JSON");
    expect(parsePlan(`Here you go:\n${JSON.stringify(fixed)}\nEnjoy!`).operations).toHaveLength(3);
    expect(() => parsePlan('{"operations":[{"op":"explode"}]}')).toThrowError(ClaspError);
  });

  it("refuses to delete a collection, so records cannot be lost by accident", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Keep me");
    const destructive: GraphPlan = { summary: "Start over", operations: [{ op: "delete", target: "tasks" }] };

    const resolved = resolvePlan(destructive, manager.app.store.graph, workspace.registry);
    expect(resolved.operations).toEqual([]);
    expect(resolved.issues[0]?.message).toContain("stores the application's data");

    const assistant = new GraphAssistant({ provider: replay([destructive]), registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 0 });
    await expectCode(assistant.propose({ request: "Start over", graph: manager.app.store.graph }), "VALIDATION_FAILED");
    expect(manager.titles("Task list")).toEqual(["Keep me"]);
    // Deleting ordinary objects is fine.
    expect(resolvePlan({ summary: "", operations: [{ op: "delete", target: "remainingLabel" }] }, manager.app.store.graph, workspace.registry).issues).toEqual([]);
  });

  it("is lenient about operation order and fills in the obvious parent", async () => {
    const { app, workspace } = await blankApp();
    const plan: GraphPlan = {
      summary: "Out of order",
      operations: [
        { op: "connect", from: "ok.click", to: "form.submit" },
        { op: "create", ref: "ok", type: "ui.button", name: "OK", parent: "form" },
        { op: "create", ref: "form", type: "ui.form", name: "Form" },
        { op: "create", ref: "win", type: "ui.window", name: "Window" },
      ],
    };
    const resolved = resolvePlan(plan, app.store.graph, workspace.registry);
    expect(resolved.issues).toEqual([]);
    const preview = resolved.preview;
    const byName = (name: string) => Object.values(preview.objects).find((object) => object.metadata.name === name)!;
    expect(byName("Form").parentId).toBe(byName("Window").id);
    expect(byName("OK").parentId).toBe(byName("Form").id);
    expect(Object.keys(preview.connections)).toHaveLength(1);
  });

  it("rejects a stale proposal as a whole", async () => {
    const { app, assistant } = await blankApp();
    const first = await assistant(new ScriptedProvider()).propose({ request: CREATE, graph: app.store.graph });
    applyProposal(app.store, first);
    const change = await assistant(new ScriptedProvider()).propose({ request: FILTER, graph: app.store.graph });
    // Meanwhile the user deletes the list the proposal wires into.
    const list = Object.values(app.store.graph.objects).find((object) => object.type === "ui.list")!;
    app.store.transact([{ op: "delete", objectId: list.id }]);
    const before = app.store.graph;
    await expectCode(() => applyProposal(app.store, change), "CONFLICT");
    expect(app.store.graph).toBe(before);
  });
});

describe("when no local model is available", () => {
  it("reports why, and everything that does not need AI keeps working", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    const offline = new OllamaProvider({
      baseUrl: "http://127.0.0.1:9",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const status = await offline.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("Everything else keeps working");

    const assistant = new GraphAssistant({ provider: offline, registry: workspace.registry, schemas: workspace.schemas });
    const error = await expectCode(assistant.propose({ request: CREATE, graph: manager.app.store.graph }), "UNAVAILABLE");
    expect(error.message).toContain("No local model server is reachable");

    // Existing applications run, manual editing works, saved graphs load.
    await manager.addTask("No AI needed");
    expect(manager.titles("Task list")).toEqual(["No AI needed"]);
    manager.app.store.transact([{ op: "update", objectId: manager.id("Add button"), properties: { label: "Add" } }]);
    await workspace.settle();
    expect(await workspace.storage.loadGraph(manager.app.id)).toEqual(manager.app.store.graph);
  });

  it("explains a server with no models installed", async () => {
    const empty = new OllamaProvider({ fetch: async () => new Response(JSON.stringify({ models: [] })) });
    expect((await empty.status()).reason).toContain("no models installed");
  });
});

describe("Ollama provider", () => {
  it("speaks the Ollama chat API with structured output and picks an installed model", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      baseUrl: "http://localhost:11434/",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
        if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "tinyllama:latest" }, { name: "qwen2.5-coder:14b" }] }));
        return new Response(JSON.stringify({ message: { role: "assistant", content: '{"summary":"ok","operations":[]}' } }));
      },
    });
    expect(await provider.status()).toEqual({ available: true, models: ["tinyllama:latest", "qwen2.5-coder:14b"], model: "qwen2.5-coder:14b" });
    const reply = await provider.complete({ messages: [{ role: "user", content: "hi" }], schema: { type: "object" } });
    expect(reply).toBe('{"summary":"ok","operations":[]}');
    const chat = calls.find((call) => call.url === "http://localhost:11434/api/chat")!;
    expect(chat.body).toMatchObject({ model: "qwen2.5-coder:14b", stream: false, format: { type: "object" }, options: { temperature: 0 } });
  });

  it("retries without the reasoning flag and surfaces server errors", async () => {
    let attempts = 0;
    const picky = new OllamaProvider({
      model: "plain",
      fetch: async (_input, init) => {
        attempts++;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if ("think" in body) return new Response('{"error":"\\"plain\\" does not support thinking"}', { status: 400 });
        return new Response(JSON.stringify({ message: { content: "{}" } }));
      },
    });
    expect(await picky.complete({ messages: [] })).toBe("{}");
    expect(attempts).toBe(2);

    const failing = new OllamaProvider({ model: "m", fetch: async () => new Response("model not found", { status: 404 }) });
    const error = await expectCode(failing.complete({ messages: [] }), "UNAVAILABLE");
    expect(error.message).toContain("404");
  });
});

describe("run-time mistakes the validator catches", () => {
  it("rejects form fields the target schema does not have, and payloads that do not fit", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    // What a real model once produced: a note editor wired into the Tasks collection.
    const plan: GraphPlan = {
      summary: "Add a text editor",
      operations: [
        { op: "create", ref: "editorForm", type: "ui.form", name: "Editor form", parent: "window" },
        { op: "create", ref: "noteInput", type: "ui.textInput", name: "Note input", parent: "editorForm", properties: { field: "body" } },
        { op: "create", ref: "save", type: "ui.button", name: "Save", parent: "editorForm" },
        { op: "connect", from: "save.click", to: "editorForm.submit" },
        { op: "connect", from: "editorForm.submitted", to: "tasks.create" },
        { op: "connect", from: "noteInput.changed", to: "tasks.update" },
      ],
    };
    const resolved = resolvePlan(plan, manager.app.store.graph, workspace.registry, { schemas: workspace.schemas });
    const messages = resolved.issues.map((entry) => entry.message);
    expect(messages.some((message) => message.includes('clasp.task has no field "body"'))).toBe(true);
    expect(messages.some((message) => message.includes('require "title"'))).toBe(true);
    expect(messages.some((message) => message.includes("sends a string") && message.includes("expects a object"))).toBe(true);
    // Messages speak in handles, never ids.
    expect(messages.join(" ")).not.toMatch(/obj_[0-9a-f]{8}/);

    // The same plan, pointed at a collection whose schema fits, is accepted.
    const fixed: GraphPlan = {
      summary: "Add a notes editor",
      operations: [
        { op: "create", ref: "notes", type: "data.collection", name: "Notes", properties: { schema: "clasp.note" } },
        ...plan.operations.slice(0, 4),
        { op: "connect", from: "editorForm.submitted", to: "notes.create" },
      ],
    };
    expect(resolvePlan(fixed, manager.app.store.graph, workspace.registry, { schemas: workspace.schemas }).issues).toEqual([]);
  });

  it("does not blame a plan for problems the application already had", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    // Introduce a mismatch by hand (core validation only warns about it).
    const result = manager.app.store.transact([
      { op: "connect", connection: { source: { objectId: manager.id("Title input"), port: "changed" }, target: { objectId: manager.id("Tasks"), port: "update" } } },
    ]);
    expect(result.warnings.map((entry) => entry.code)).toEqual(["PAYLOAD_MISMATCH"]);
    const unrelated: GraphPlan = { summary: "Rename", operations: [{ op: "update", target: "addButton", properties: { label: "Add" } }] };
    expect(resolvePlan(unrelated, manager.app.store.graph, workspace.registry, { schemas: workspace.schemas }).issues).toEqual([]);
  });
});

describe("planning by features", () => {
  it("builds an application from a feature description and shows the proposal in feature terms", async () => {
    const { workspace, app, assistant } = await blankApp();
    const proposal = await assistant(new ScriptedProvider()).propose({ request: "Build me a recipe box", graph: app.store.graph });
    expect(proposal.features).toEqual([
      "Stores recipes (title, servings, vegetarian)",
      "A form to add recipes (title, servings, vegetarian)",
      "A list of recipes you can tick off as vegetarian, edit, remove",
      "Search recipes by title",
      "Filter recipes by vegetarian",
      "Shows how many recipes there are",
      "Names the application “Recipe Box”",
    ]);
    expect(proposal.schemas.map((schema) => schema.id)).toEqual(["user.recipe"]);
    // Nothing is registered or changed until the proposal is applied.
    expect(workspace.schemas.has("user.recipe")).toBe(false);
    expect(() => applyProposal(app.store, proposal)).toThrowError(/schema registry/);
    applyProposal(app.store, proposal, workspace.schemas);
    await workspace.settle();
    expect(workspace.schemas.has("user.recipe")).toBe(true);

    const driver = new AppDriver(workspace, app);
    await driver.type("Title input", "Pancakes");
    await driver.press("Add Recipe button");
    expect(driver.titles("Recipe list")).toEqual(["Pancakes"]);
  });

  it("repairs feature plans with feature-level explanations", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const provider = replay([
      { summary: "Search", features: [{ kind: "search", entity: "Task", field: "name" }], operations: [] },
      { summary: "Search", features: [{ kind: "search", entity: "Task", field: "title" }], operations: [] },
    ]);
    const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas });
    const proposal = await assistant.propose({ request: "Let me search tasks", graph: manager.store.graph });
    expect(proposal.attempts).toBe(2);
    expect(proposal.features).toEqual(["Search tasks by title"]);
    const feedback = provider.seen[1]!.at(-1)!.content;
    expect(feedback).toContain('Task has no field "name" (to search). Its fields are: title, completed');
    // The model was shown the application in feature terms, not just wiring.
    expect(provider.seen[0]![1]!.content).toContain("list “Task list” of “Tasks”, checkbox completed, through filter by completed");
  });
});

describe("new application or change to this one", () => {
  it("recognizes requests for a separate application", async () => {
    const { asksForNewApp } = await import("@clasp/ai");
    for (const request of ["make a calendar app", "can we make a calendar app", "Build me a recipe tracker application", "create a new app for notes", "write a small budgeting tool"]) {
      expect(asksForNewApp(request), request).toBe(true);
    }
    for (const request of ["make the app show only done tasks", "add a calendar to this", "Let me search by title", "Add a filter to show only incomplete tasks."]) {
      expect(asksForNewApp(request), request).toBe(false);
    }
  });

  it("proposes a new application instead of changing the open one, and can switch", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const before = manager.store.graph;
    const assistant = new GraphAssistant({ provider: new ScriptedProvider(), registry: workspace.registry, schemas: workspace.schemas });

    const proposal = await assistant.propose({ request: "make a calendar app", graph: before });
    expect(proposal.target).toEqual({ kind: "new", name: "Calendar" });
    // Compiled against an empty application: nothing of the Task Manager is touched or reused.
    const createdIds = new Set(proposal.operations.flatMap((operation) => (operation.op === "create" && operation.object.id ? [operation.object.id] : [])));
    expect(
      proposal.operations.every(
        (operation) => operation.op === "create" || operation.op === "connect" || (operation.op === "update" && createdIds.has(operation.objectId)),
      ),
    ).toBe(true);
    expect(proposal.operations.some((operation) => operation.op === "create" && before.objects[operation.object.id ?? ""])).toBe(false);
    expect(proposal.features[0]).toBe("Stores events in the shared Event format");

    // Applying it to a new, empty application builds the calendar there.
    const created = await workspace.install(createGraph({ name: "Calendar" }));
    applyProposal(created.store, proposal, workspace.schemas);
    await workspace.settle();
    expect(Object.values(created.store.graph.objects).map((object) => object.type)).toContain("ui.calendar");
    expect(manager.store.graph).toBe(before);

    // "Add it to the Task Manager instead" recompiles the same plan against the open app, without asking again.
    const here = assistant.retarget(proposal, { kind: "current" }, manager.store.graph);
    expect(here.target).toEqual({ kind: "current" });
    expect(here.baseVersion).toBe(manager.store.graph.version);
    applyProposal(manager.store, here, workspace.schemas);
    await workspace.settle();
    expect(Object.values(manager.store.graph.objects).map((object) => object.type)).toContain("ui.calendar");

    // A model that explicitly says "current" is respected; an empty app is always built in place.
    expect(assistant.targetFor({ summary: "", app: "current", operations: [] }, "make a calendar app", before)).toEqual({ kind: "current" });
    expect(assistant.targetFor({ summary: "", operations: [] }, "make a calendar app", createGraph({ name: "blank" }))).toEqual({ kind: "current" });
    expect(assistant.targetFor({ summary: "", app: "new", title: "Gym log", operations: [] }, "track my workouts", before)).toEqual({ kind: "new", name: "Gym log" });
  });
});

const RECIPE_REQUEST = "A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and filter to vegetarian ones.";

describe("naming applications", () => {
  it("names an untitled application after what it becomes — and never renames one somebody named", async () => {
    const { workspace, app, assistant } = await blankApp();
    const taken = new GraphAssistant({ provider: new ScriptedProvider(), registry: workspace.registry, schemas: workspace.schemas, nameTaken: (name) => name === "Recipe Box" });
    const first = await taken.propose({ request: RECIPE_REQUEST, graph: app.store.graph });
    expect(first.features.at(-1)).toBe("Names the application “Recipe Box 2”");

    applyProposal(app.store, await assistant(new ScriptedProvider()).propose({ request: RECIPE_REQUEST, graph: app.store.graph }), workspace.schemas);
    expect(app.store.graph.metadata.name).toBe("Recipe Box");
    app.store.undo(); // one step undoes the change and the name together
    expect(app.store.graph.metadata.name).toBe("Untitled app");

    app.store.transact([{ op: "setMetadata", name: "My recipes" }]);
    const later = await assistant(new ScriptedProvider()).propose({ request: RECIPE_REQUEST, graph: app.store.graph });
    expect(later.features.some((line) => line.startsWith("Names the application"))).toBe(false);
    expect(isPlaceholderName("Untitled app 3")).toBe(true);
    expect(isPlaceholderName("Untitled ideas")).toBe(false);
  });
});
