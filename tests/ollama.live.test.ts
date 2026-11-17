import { GraphAssistant, OllamaProvider, applyProposal } from "@clasp/ai";
import { buildTaskManager } from "@clasp/examples";
import { documentFeature } from "@clasp/files";
import { createGraph, findObjects } from "@clasp/core";
import { describe, expect, it } from "vitest";
import { openWorkspace } from "./support";

/**
 * Real local inference. Skipped unless CLASP_OLLAMA=1 because it needs a
 * running Ollama server and takes a while:
 *
 *   CLASP_OLLAMA=1 CLASP_OLLAMA_MODEL=qwen2.5-coder:14b pnpm test:ollama
 *
 * This is the only test that involves a language model; the deterministic
 * equivalent (tests/ai.test.ts) uses the clearly labelled scripted provider.
 */
const enabled = process.env.CLASP_OLLAMA === "1";

describe.skipIf(!enabled)("AI generation with a real local model (Ollama)", () => {
  it(
    "generates a working task manager and then adds a filter without losing data",
    async () => {
      const provider = new OllamaProvider({
        ...(process.env.CLASP_OLLAMA_URL ? { baseUrl: process.env.CLASP_OLLAMA_URL } : {}),
        ...(process.env.CLASP_OLLAMA_MODEL ? { model: process.env.CLASP_OLLAMA_MODEL } : {}),
        timeoutMs: 240_000,
      });
      const status = await provider.status();
      expect(status.available, status.reason).toBe(true);
      console.log(`[ollama] using model ${status.model}`);

      const { workspace } = await openWorkspace({ backend: "memory" });
      const app = await workspace.install(createGraph({ name: "Untitled app" }));
      const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 3 });
      const log = (label: string) => (progress: { stage: string; attempt: number; issues?: Array<{ message: string }> }) => {
        if (progress.stage === "repairing") console.log(`[ollama] ${label}: attempt ${progress.attempt} rejected:`, progress.issues?.map((entry) => entry.message));
      };

      // ── create ─────────────────────────────────────────────────────────
      const created = await assistant.propose({
        request: "Create a simple task manager with a title field, an Add Task button, and a list of tasks.",
        graph: app.store.graph,
        onProgress: log("create"),
      });
      console.log(`[ollama] create: ${created.operations.length} operations in ${created.attempts} attempt(s): ${created.summary}`);
      expect(created.provider.kind).toBe("llm");
      applyProposal(app.store, created);
      await workspace.settle();

      const graph = app.store.graph;
      const [collection] = findObjects(graph, { type: "data.collection" });
      const [input] = findObjects(graph, { type: "ui.textInput" });
      const [button] = findObjects(graph, { type: "ui.button" });
      const [list] = findObjects(graph, { type: /^ui\.(list|table)$/ });
      expect(collection, "a collection").toBeDefined();
      expect(input, "a text input").toBeDefined();
      expect(button, "a button").toBeDefined();
      expect(list, "a list").toBeDefined();
      expect(collection!.properties.schema).toBe("clasp.task");
      expect(app.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);

      // Use the generated application exactly as a person would — no model involved.
      const rowsPort = list!.type === "ui.list" ? "items" : "rows";
      const rows = () => (app.runtime.getInput(list!.id, rowsPort) as Array<Record<string, unknown>> | undefined) ?? [];
      const add = async (title: string) => {
        app.runtime.interact(input!.id, "input", title);
        app.runtime.interact(button!.id, "press");
        await workspace.settle();
      };
      await add("Buy milk");
      await add("Walk the dog");
      expect(rows().map((row) => row.title)).toEqual(["Buy milk", "Walk the dog"]);
      const milk = rows()[0]!;
      await app.clasp.mutate({ source: collection!.id, operation: "update", id: String(milk.id), data: { completed: true } });
      await workspace.settle();

      // ── modify ─────────────────────────────────────────────────────────
      const changed = await assistant.propose({
        request: "Add a filter to show only incomplete tasks.",
        graph: app.store.graph,
        onProgress: log("modify"),
      });
      console.log(`[ollama] modify: ${changed.operations.length} operations in ${changed.attempts} attempt(s): ${changed.summary}`);
      applyProposal(app.store, changed);
      await workspace.settle();

      // The collection and its records are untouched; the list now shows only incomplete tasks.
      expect(app.store.graph.objects[collection!.id]).toBeDefined();
      expect(workspace.kernel.data.count(collection!.id)).toBe(2);
      expect(findObjects(app.store.graph, { type: /^data\.(filter|query)$/ }).length).toBeGreaterThan(0);
      expect(rows().map((row) => row.title)).toEqual(["Walk the dog"]);
    },
    900_000,
  );

  it(
    "builds a recipe box from a feature description, with its own kind of record",
    async () => {
      const provider = new OllamaProvider({
        ...(process.env.CLASP_OLLAMA_URL ? { baseUrl: process.env.CLASP_OLLAMA_URL } : {}),
        ...(process.env.CLASP_OLLAMA_MODEL ? { model: process.env.CLASP_OLLAMA_MODEL } : {}),
        timeoutMs: 240_000,
      });
      const { workspace } = await openWorkspace({ backend: "memory" });
      const app = await workspace.install(createGraph({ name: "Untitled app" }));
      const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 3, extensions: [documentFeature] });
      const proposal = await assistant.propose({
        request: "A recipe box where I can add recipes with servings and whether they are vegetarian, search them by title, and filter to vegetarian ones.",
        graph: app.store.graph,
      });
      console.log(`[ollama] recipe box in ${proposal.attempts} attempt(s):\n  ${proposal.features.join("\n  ")}`);
      applyProposal(app.store, proposal, workspace.schemas);
      await workspace.settle();

      const collection = findObjects(app.store.graph, { type: "data.collection" })[0]!;
      const schema = workspace.schemas.require(String(collection.properties.schema));
      expect(Object.keys(schema.fields)).toEqual(expect.arrayContaining(["servings", "vegetarian"]));
      expect(findObjects(app.store.graph, { type: "ui.form" })).toHaveLength(1);
      expect(findObjects(app.store.graph, { type: "data.filter" }).length).toBeGreaterThanOrEqual(2);
      expect(app.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);

      // Records can be created through the API with the fields the user asked for.
      const titleField = schema.fields.title ? "title" : schema.fields.name ? "name" : Object.keys(schema.fields)[0]!;
      await app.clasp.mutate({ source: collection.id, operation: "create", data: { [titleField]: "Tomato soup", servings: 4, vegetarian: true } });
      expect(workspace.kernel.data.count(collection.id)).toBe(1);
    },
    900_000,
  );

  it(
    "\"make a calendar app\" from inside another app proposes a new application with a calendar",
    async () => {
      const provider = new OllamaProvider({
        ...(process.env.CLASP_OLLAMA_URL ? { baseUrl: process.env.CLASP_OLLAMA_URL } : {}),
        ...(process.env.CLASP_OLLAMA_MODEL ? { model: process.env.CLASP_OLLAMA_MODEL } : {}),
        timeoutMs: 240_000,
      });
      const { workspace } = await openWorkspace({ backend: "memory" });
      const manager = await workspace.install(buildTaskManager(workspace.registry));
      const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 3, extensions: [documentFeature] });
      const proposal = await assistant.propose({ request: "make a calendar app", graph: manager.store.graph });
      console.log(`[ollama] calendar → ${JSON.stringify(proposal.target)} in ${proposal.attempts} attempt(s):\n  ${proposal.features.join("\n  ")}`);
      expect(proposal.target.kind).toBe("new");

      const created = await workspace.install(createGraph({ name: proposal.target.kind === "new" ? proposal.target.name : "x" }));
      applyProposal(created.store, proposal, workspace.schemas);
      await workspace.settle();
      const types = Object.values(created.store.graph.objects).map((object) => object.type);
      expect(types).toContain("ui.calendar");
      expect(created.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);
      expect(Object.keys(manager.store.graph.objects)).toHaveLength(10);
    },
    900_000,
  );
  it(
    "builds a kanban board from a plain request, with columns from a choice field",
    async () => {
      const provider = new OllamaProvider({
        ...(process.env.CLASP_OLLAMA_URL ? { baseUrl: process.env.CLASP_OLLAMA_URL } : {}),
        ...(process.env.CLASP_OLLAMA_MODEL ? { model: process.env.CLASP_OLLAMA_MODEL } : {}),
        timeoutMs: 240_000,
      });
      const { workspace } = await openWorkspace({ backend: "memory" });
      const app = await workspace.install(createGraph({ name: "Untitled app" }));
      const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 3, extensions: [documentFeature] });
      const proposal = await assistant.propose({
        request: "A kanban board for my reading list: books move through want to read, reading and finished. Let me add books.",
        graph: app.store.graph,
      });
      console.log(`[ollama] reading board in ${proposal.attempts} attempt(s):\n  ${proposal.features.join("\n  ")}`);
      applyProposal(app.store, proposal, workspace.schemas);
      await workspace.settle();

      const [board] = findObjects(app.store.graph, { type: "ui.board" });
      expect(board, "a board").toBeDefined();
      const columns = board!.properties.columns as string[];
      expect(columns.length).toBeGreaterThanOrEqual(3);
      expect(findObjects(app.store.graph, { type: "ui.form" })).toHaveLength(1);
      expect(app.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);

      // A card added through the API lands in a column, and moving it updates the record.
      const collection = findObjects(app.store.graph, { type: "data.collection" })[0]!;
      const schema = workspace.schemas.require(String(collection.properties.schema));
      const field = String(board!.properties.groupField);
      const titleField = schema.fields.title ? "title" : schema.fields.name ? "name" : Object.keys(schema.fields)[0]!;
      const [created] = (await app.clasp.mutate({ source: collection.id, operation: "create", data: { [titleField]: "Middlemarch", [field]: columns[0]! } })).records;
      await workspace.settle();
      app.runtime.interact(board!.id, "move", { id: created!.id, column: columns[1]! });
      await workspace.settle();
      expect(workspace.kernel.data.get(collection.id, created!.id)?.fields[field]).toBe(columns[1]);
    },
    900_000,
  );
  it(
    "\"a calculator\" builds a calculator, and a game request builds that game — not tasks or editors",
    async () => {
      const provider = new OllamaProvider({
        ...(process.env.CLASP_OLLAMA_URL ? { baseUrl: process.env.CLASP_OLLAMA_URL } : {}),
        ...(process.env.CLASP_OLLAMA_MODEL ? { model: process.env.CLASP_OLLAMA_MODEL } : {}),
        timeoutMs: 240_000,
      });
      const { workspace } = await openWorkspace({ backend: "memory" });
      const assistant = new GraphAssistant({ provider, registry: workspace.registry, schemas: workspace.schemas, maxRepairs: 3, extensions: [documentFeature] });
      const cases: Array<[string, string]> = [
        ["a calculator", "ui.calculator"],
        ["I want to play a memory game where you match pairs of cards", "game.pairs"],
      ];
      for (const [request, type] of cases) {
        const app = await workspace.install(createGraph({ name: "Untitled app" }));
        const proposal = await assistant.propose({ request, graph: app.store.graph });
        console.log(`[ollama] "${request}" in ${proposal.attempts} attempt(s):\n  ${proposal.features.join("\n  ")}`);
        applyProposal(app.store, proposal, workspace.schemas);
        await workspace.settle();
        const types = Object.values(app.store.graph.objects).map((object) => object.type);
        expect(types, request).toContain(type);
        expect(types, request).not.toContain("ui.codeEditor");
        expect(findObjects(app.store.graph, { type: "data.collection" }).every((collection) => collection.properties.schema === "clasp.score"), request).toBe(true);
        expect(app.runtime.diagnostics().filter((entry) => entry.severity === "error")).toEqual([]);
      }
    },
    900_000,
  );
});
