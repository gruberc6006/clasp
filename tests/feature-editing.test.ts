import { describe, expect, it } from "vitest";
import { createGraph, validateGraph } from "@clasp/core";
import { buildTaskManager, templates } from "@clasp/examples";
import { changeFeature, compileFeatures, inventory, removeFeature, type FeaturePlan, type FeatureSpec, type PresentFeature } from "@clasp/features";
import { documentFeature } from "@clasp/files";
import type { AppHandle, Workspace } from "@clasp/runtime";
import { AppDriver, openWorkspace } from "./support";

const RECIPES: FeaturePlan = {
  title: "Recipe Box",
  entities: [
    {
      name: "Recipe",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "servings", type: "number" },
        { name: "vegetarian", type: "boolean" },
      ],
    },
  ],
  features: [
    { kind: "add", entity: "Recipe" },
    { kind: "list", entity: "Recipe" },
    { kind: "search", entity: "Recipe", field: "title" },
    { kind: "filter", entity: "Recipe", field: "vegetarian" },
    { kind: "count", entity: "Recipe", label: "recipes" },
  ],
};

async function build(workspace: Workspace, plan: FeaturePlan): Promise<AppHandle> {
  const app = await workspace.install(createGraph({ name: "Recipes" }));
  const compiled = compileFeatures(plan, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas });
  expect(compiled.issues).toEqual([]);
  for (const schema of compiled.schemas) workspace.schemas.register(schema);
  app.store.transact(compiled.operations);
  await workspace.settle();
  return app;
}

function features(workspace: Workspace, app: AppHandle): PresentFeature[] {
  return inventory(app.store.graph, workspace.schemas).features;
}

function find(workspace: Workspace, app: AppHandle, kind: string): PresentFeature {
  const feature = features(workspace, app).find((candidate) => candidate.kind === kind);
  if (!feature) throw new Error(`No ${kind} feature`);
  return feature;
}

async function remove(workspace: Workspace, app: AppHandle, kind: string): Promise<string[]> {
  const removal = removeFeature(app.store.graph, find(workspace, app, kind));
  app.store.transact(removal.operations);
  await workspace.settle();
  expect(validateGraph(app.store.graph, workspace.registry).filter((issue) => issue.severity === "error")).toEqual([]);
  return removal.alsoRemoves;
}

async function change(workspace: Workspace, app: AppHandle, kind: string, next: FeatureSpec): Promise<void> {
  const compiled = changeFeature(find(workspace, app, kind), next, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas }, [documentFeature]);
  expect(compiled.issues).toEqual([]);
  app.store.transact(compiled.operations);
  await workspace.settle();
}

async function addRecipes(driver: AppDriver, recipes: Array<[string, boolean]>): Promise<void> {
  for (const [title, vegetarian] of recipes) {
    await driver.type("Title input", title);
    if (vegetarian) await driver.interact("Vegetarian checkbox", "toggle", true);
    await driver.press("Add Recipe button");
  }
}

describe("reading an application as features", () => {
  it("lists what a feature-built application does, with exactly its parts", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await build(workspace, RECIPES);
    const { entities, features: present, other } = inventory(app.store.graph, workspace.schemas);
    expect(entities.map((entity) => [entity.name, entity.plural, entity.editable])).toEqual([["Recipe", "Recipes", true]]);
    expect(present.map((feature) => feature.label)).toEqual([
      "The window is titled “Recipe Box”",
      "A form to add recipes (title, servings, vegetarian)",
      "A list of recipes you can tick off as vegetarian, edit, remove",
      "Search recipes by title",
      "Tabs that filter recipes by vegetarian",
      "Counts recipes, shown as “N recipes”",
    ]);
    expect(other).toEqual([]); // every object belongs to a feature
    expect(find(workspace, app, "search").spec).toEqual({ kind: "search", entity: "Recipe", field: "title" });
    expect(find(workspace, app, "title").locked).toBeDefined();
  });

  it("reads hand-built applications too, and says what it cannot read", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const read = inventory(manager.store.graph, workspace.schemas);
    expect(read.features.map((feature) => feature.kind).sort()).toEqual(["add", "count", "filter", "list", "share", "title"]);
    expect(read.features.find((feature) => feature.kind === "count")?.spec).toMatchObject({ label: "remaining", where: { field: "completed", value: false } });
    expect(read.other).toEqual([]);

    const chat = templates.find((template) => template.id === "socket-chat")!;
    const socket = await workspace.install(chat.build(workspace.registry));
    const parts = inventory(socket.store.graph, workspace.schemas);
    expect(parts.features.map((feature) => feature.kind)).toEqual(["title"]);
    expect(parts.other.length).toBeGreaterThan(5); // the socket and its controls were wired by hand
  });
});

describe("removing features", () => {
  it("removing a search keeps the list showing records, filtered by what is left", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await build(workspace, RECIPES);
    const driver = new AppDriver(workspace, app);
    await addRecipes(driver, [
      ["Tomato soup", true],
      ["Roast chicken", false],
    ]);
    await driver.type("Recipes search", "soup");
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup"]);

    expect(await remove(workspace, app, "search")).toEqual([]);
    expect(Object.values(app.store.graph.objects).some((object) => object.metadata.name === "Recipes search")).toBe(false);
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup", "Roast chicken"]);
    await driver.interact("Vegetarian tabs", "select", 1);
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup"]); // the filter still works
    expect(workspace.kernel.data.count(driver.id("Recipes"))).toBe(2);
  });

  it("removing the last list also removes the search and filter that worked on it; records stay", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await build(workspace, RECIPES);
    const driver = new AppDriver(workspace, app);
    await addRecipes(driver, [["Tomato soup", true]]);
    const also = await remove(workspace, app, "list");
    expect(also).toEqual(["its search", "its Vegetarian filter"]);
    expect(features(workspace, app).map((feature) => feature.kind)).toEqual(["title", "add", "count"]);
    expect(workspace.kernel.data.count(driver.id("Recipes"))).toBe(1);

    // A list added later shows the records again.
    const compiled = compileFeatures({ features: [{ kind: "list", entity: "Recipe" }] }, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas });
    app.store.transact(compiled.operations);
    await workspace.settle();
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup"]);
  });

  it("never removes records or their place; sharing can be switched off; a game leaves its scores", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const read = inventory(manager.store.graph, workspace.schemas);
    expect(removeFeature(manager.store.graph, read.features.find((feature) => feature.kind === "title")!).operations).toEqual([]);
    const share = read.features.find((feature) => feature.kind === "share")!;
    manager.store.transact(removeFeature(manager.store.graph, share).operations);
    expect(Object.values(manager.store.graph.objects).find((object) => object.type === "data.collection")?.properties.exposure).toBe("private");

    const game = await workspace.install(templates.find((template) => template.id === "pairs")!.build(workspace.registry));
    await workspace.settle();
    const tool = inventory(game.store.graph, workspace.schemas).features.find((feature) => feature.kind === "tool")!;
    expect(tool.label).toBe("A memory game of matching pairs, with a high-score list");
    game.store.transact(removeFeature(game.store.graph, tool).operations);
    const left = Object.values(game.store.graph.objects).map((object) => object.type).sort();
    expect(left).toEqual(["data.collection", "ui.window"]);
  });
});

describe("changing features", () => {
  it("changes a sort's direction, a search's field and a list into a table — keeping search and filters working", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await build(workspace, { ...RECIPES, features: [...(RECIPES.features ?? []), { kind: "sort", entity: "Recipe", field: "title" }] });
    const driver = new AppDriver(workspace, app);
    await addRecipes(driver, [
      ["Apple pie", true],
      ["Beef stew", false],
      ["Carrot cake", true],
    ]);
    expect(driver.titles("Recipe list")).toEqual(["Apple pie", "Beef stew", "Carrot cake"]);

    await change(workspace, app, "sort", { kind: "sort", entity: "Recipe", field: "title", direction: "desc" });
    expect(driver.titles("Recipe list")).toEqual(["Carrot cake", "Beef stew", "Apple pie"]);
    expect(find(workspace, app, "sort").label).toBe("Sorts recipes by title, largest or latest first");

    await change(workspace, app, "list", { kind: "list", entity: "Recipe", display: "table", fields: ["title", "servings"] });
    const table = (): string[] => driver.rows("Recipe table", "rows").map((row) => String(row.title));
    expect(table()).toEqual(["Carrot cake", "Beef stew", "Apple pie"]); // the sort still applies
    await driver.interact("Vegetarian tabs", "select", 1);
    expect(table()).toEqual(["Carrot cake", "Apple pie"]); // and the filter
    expect(features(workspace, app).map((feature) => feature.kind)).toEqual(["title", "add", "list", "search", "filter", "sort", "count"]);
  });

  it("changing a form keeps a calendar filling in its date", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const calendarTemplate = templates.find((template) => template.id === "calendar")!;
    const app = await workspace.install(calendarTemplate.build(workspace.registry));
    await workspace.settle();
    await change(workspace, app, "add", { kind: "add", entity: "Event", fields: ["title", "start"], button: "Add" });
    const driver = new AppDriver(workspace, app);
    await driver.interact("Event calendar", "pick", "2026-12-24");
    expect(driver.output("Starts input", "value")).toBe("2026-12-24");
    expect(find(workspace, app, "add").label).toBe("A form to add events (title, start)");
  });

  it("refuses to change what cannot be changed, and a title is just updated", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await build(workspace, RECIPES);
    await change(workspace, app, "title", { kind: "title", text: "My Recipes", subtitle: "Things I like to cook" });
    expect(find(workspace, app, "title").label).toBe("The window is titled “My Recipes”");
    const context = { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas };
    expect(changeFeature(find(workspace, app, "search"), { kind: "sort", entity: "Recipe", field: "title" }, context).issues[0]).toMatch(/keeps its kind/);
  });
});
