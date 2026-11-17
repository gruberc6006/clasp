import { createGraph } from "@clasp/core";
import { buildTaskDashboard, buildTaskManager } from "@clasp/examples";
import { compileFeatures, describeFeatures, type FeaturePlan } from "@clasp/features";
import type { AppHandle, Workspace } from "@clasp/runtime";
import { describe, expect, it } from "vitest";
import { AppDriver, answerAccessRequest, openWorkspace } from "./support";

/** Compiles a plan against an installed app and applies it, the way an approved proposal is applied. */
async function apply(workspace: Workspace, app: AppHandle, plan: FeaturePlan) {
  const compiled = compileFeatures(plan, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas });
  expect(compiled.issues).toEqual([]);
  for (const schema of compiled.schemas) workspace.schemas.register(schema);
  app.store.transact(compiled.operations, { label: plan.summary ?? "features" });
  await workspace.settle();
  return compiled;
}

const RECIPES: FeaturePlan = {
  title: "Recipe Box",
  entities: [
    {
      name: "Recipe",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "servings", type: "number" },
        { name: "vegetarian", type: "boolean" },
        { name: "course", type: "choice", options: ["starter", "main", "dessert"] },
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

describe("building an application from features", () => {
  it("turns a feature description into a working application", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(createGraph({ name: "Recipes" }));
    const compiled = await apply(workspace, app, RECIPES);

    expect(compiled.described).toEqual([
      "Stores recipes (title, servings, vegetarian, course)",
      "A form to add recipes (title, servings, vegetarian, course)",
      "A list of recipes you can tick off as vegetarian, edit, remove",
      "Search recipes by title",
      "Filter recipes by vegetarian",
      "Shows how many recipes there are",
    ]);
    // A schema was defined for the new kind of record, and the app runs cleanly.
    expect(workspace.schemas.require("user.recipe").fields.course).toMatchObject({ type: "enum", values: ["starter", "main", "dessert"] });
    expect(app.runtime.diagnostics().filter((entry) => entry.severity !== "warning")).toEqual([]);
    expect(app.store.graph.objects[Object.keys(app.store.graph.objects)[0]!]).toBeDefined();

    const driver = new AppDriver(workspace, app);
    expect(driver.output("Window", "title") ?? driver.input("Window", "title")).toBe("Recipe Box");
    const add = async (title: string, servings: number, vegetarian: boolean, course: string) => {
      await driver.type("Title input", title);
      await driver.interact("Servings input", "input", servings);
      if (vegetarian) await driver.interact("Vegetarian checkbox", "toggle");
      await driver.interact("Course select", "choose", course);
      await driver.press("Add Recipe button");
    };
    await add("Tomato soup", 4, true, "starter");
    await add("Beef stew", 6, false, "main");
    await add("Tiramisu", 8, true, "dessert");
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup", "Beef stew", "Tiramisu"]);
    expect(driver.output("Recipes label", "display")).toBe("3 recipes");
    // The form cleared itself, including the checkbox and the select.
    expect(driver.output("Vegetarian checkbox", "value")).toBe(false);
    expect(driver.output("Course select", "value")).toBeUndefined();

    // Search and filter compose.
    await driver.type("Recipes search", "t");
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup", "Beef stew", "Tiramisu"]);
    await driver.type("Recipes search", "stew");
    expect(driver.titles("Recipe list")).toEqual(["Beef stew"]);
    await driver.type("Recipes search", "");
    await driver.interact("Vegetarian tabs", "select", 1);
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup", "Tiramisu"]);
    await driver.type("Recipes search", "soup");
    expect(driver.titles("Recipe list")).toEqual(["Tomato soup"]);
    // The count is of all recipes, not just the visible ones.
    expect(driver.output("Recipes label", "display")).toBe("3 recipes");

    // Records are real, validated clasp records.
    const stored = await app.clasp.query({ source: driver.id("Recipes") });
    expect(stored.schema?.id).toBe("user.recipe");
    expect(stored.records.map((record) => record.fields)).toContainEqual({ title: "Beef stew", servings: 6, vegetarian: false, course: "main" });
  });

  it("is deterministic: the same plan builds the same structure", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const shape = (plan: FeaturePlan) => {
      const graph = createGraph({ name: "x" });
      const compiled = compileFeatures(plan, { graph, registry: workspace.registry, schemas: workspace.schemas });
      return compiled.operations.map((operation) =>
        operation.op === "create" ? `${operation.object.type}:${operation.object.name}` : operation.op === "connect" ? "connect" : operation.op,
      );
    };
    expect(shape(RECIPES)).toEqual(shape(RECIPES));
  });

  it("uses shared schemas for built-in entities, so other applications can read the records", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(createGraph({ name: "Chores" }));
    await apply(workspace, app, {
      title: "Chores",
      features: [
        { kind: "add", entity: "Task" },
        { kind: "list", entity: "Task" },
        { kind: "share", entity: "Task" },
      ],
    });
    const collection = Object.values(app.store.graph.objects).find((object) => object.type === "data.collection")!;
    expect(collection.properties).toEqual({ schema: "clasp.task", exposure: "discoverable" });

    const dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(workspace.registry)));
    await workspace.settle();
    expect(dashboard.rows("Available sources")).toMatchObject([{ name: "Tasks", ownerName: "Chores" }]);
  });
});

describe("changing an existing application by features", () => {
  it("inserts a search into the Task Manager's existing list without touching its data", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Water the plants");
    await manager.addTask("Pay rent");
    const before = Object.keys(manager.app.store.graph.objects).length;

    const compiled = await apply(workspace, manager.app, { features: [{ kind: "search", entity: "Task" }] });
    expect(compiled.described).toEqual(["Search tasks by title"]);
    // Two objects added (search box + its filter); nothing else created or removed.
    expect(Object.keys(manager.app.store.graph.objects)).toHaveLength(before + 2);
    expect(compiled.operations.filter((operation) => operation.op === "delete")).toEqual([]);

    // The search sits before the list, after the existing status tabs, in the same window.
    const graph = manager.app.store.graph;
    const search = graph.objects[manager.id("Tasks search")]!;
    const list = graph.objects[manager.id("Task list")]!;
    expect(search.parentId).toBe(list.parentId);
    expect(search.order).toBeLessThan(list.order);

    await manager.type("Tasks search", "rent");
    expect(manager.titles("Task list")).toEqual(["Pay rent"]);
    // It composes with the filtering that was already there.
    await manager.interact("Task list", "toggle", { id: manager.rows("Task list")[0]!.id as string });
    await manager.interact("Status tabs", "select", 1);
    expect(manager.titles("Task list")).toEqual([]);
    await manager.interact("Status tabs", "select", 2);
    expect(manager.titles("Task list")).toEqual(["Pay rent"]);
    expect(workspace.kernel.data.count(manager.id("Tasks"))).toBe(2);
  });

  it("adds fields to a built-in entity by extending its schema; records and sharing survive", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Existing task");
    const dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(workspace.registry)));
    await workspace.settle();
    await dashboard.interact("Available sources", "select", { id: manager.id("Tasks") });
    await dashboard.press("Request access button");
    await answerAccessRequest(workspace, true);

    const compiled = await apply(workspace, manager.app, {
      entities: [{ name: "Task", fields: [{ name: "estimate", type: "number" }] }],
      features: [{ kind: "add", entity: "Task" }],
    });
    expect(compiled.schemas.map((schema) => `${schema.id}@${schema.version} extends ${schema.extends}`)).toEqual(["user.task@1 extends clasp.task"]);
    expect(compiled.described).toEqual(["Tasks gain new fields; existing tasks are kept", "Adds estimate to the form for new tasks"]);
    // The existing form gained an input; no second form was made.
    expect(Object.values(manager.app.store.graph.objects).filter((object) => object.type === "ui.form")).toHaveLength(1);

    await manager.type("Title input", "Estimated task");
    await manager.interact("Estimate input", "input", 3);
    await manager.press("Add button");
    const records = (await manager.app.clasp.query({ source: manager.id("Tasks") })).records;
    expect(records.map((record) => record.fields.title)).toEqual(["Existing task", "Estimated task"]);
    expect(records[1]?.fields.estimate).toBe(3);
    // The dashboard, which reads clasp.task, still sees everything.
    expect(dashboard.titles("Task table", "rows")).toEqual(["Existing task", "Estimated task"]);
  });

  it("applies a fixed filter, and is idempotent for features that already exist", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Open");
    await manager.addTask("Done");
    await manager.interact("Task list", "toggle", { id: manager.rows("Task list")[1]!.id as string });

    await apply(workspace, manager.app, { features: [{ kind: "filter", entity: "Task", field: "completed", value: false, name: "Incomplete filter" }] });
    expect(manager.titles("Task list")).toEqual(["Open"]);

    // Asking for an add form and a list that already exist creates nothing new.
    const again = compileFeatures(
      { features: [{ kind: "add", entity: "Task" }] },
      { graph: manager.app.store.graph, registry: workspace.registry, schemas: workspace.schemas },
    );
    expect(again.operations).toEqual([]);
  });

  it("explains what it cannot do, in terms of the features", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const issues = compileFeatures(
      {
        features: [
          { kind: "search", entity: "Task", field: "colour" },
          { kind: "filter", entity: "Task", field: "title" },
          { kind: "teleport" } as never,
          { kind: "list", entity: "Task", toggle: "title" },
        ],
      },
      { graph: manager.store.graph, registry: workspace.registry, schemas: workspace.schemas },
    ).issues;
    expect(issues).toEqual([
      'Task has no field "colour" (to search). Its fields are: title, completed, notes, dueDate, priority, project. Add the field to the entity, or use one of these.',
      'Tabs can only filter by a true/false or choice field; "title" is string. Use "search", or give the filter a "value".',
      'Unknown feature kind "teleport". Use one of: title, add, list, search, filter, sort, count, share, calendar, board, tool, document.',
      '"title" is not a true/false field of Task, so it cannot be a checkbox.',
    ]);
    const orphan = compileFeatures(
      { features: [{ kind: "search", entity: "Recipe" }] },
      { graph: createGraph({ name: "x" }), registry: workspace.registry, schemas: workspace.schemas },
    ).issues;
    expect(orphan).toEqual(['There is no list of recipes to search, filter or sort. Add a "list" feature for Recipe.']);
  });
});

describe("describing an application by its features", () => {
  it("summarizes entities and features without wiring", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = await workspace.install(buildTaskManager(workspace.registry));
    const text = describeFeatures(manager.store.graph, workspace.schemas);
    expect(text).toContain('Application "Task Manager", window “Task Manager”');
    expect(text).toContain("Task — stored in “Tasks”, shared; fields: title (text, required), completed (boolean)");
    expect(text).toContain("add form “New task form” creating records in “Tasks” with title");
    expect(text).toContain("list “Task list” of “Tasks”, checkbox completed, through filter by completed");
    expect(text).toContain("count “Remaining count” of “Tasks” where completed = false");
    expect(text).not.toMatch(/obj_|con_/);
  });
});

describe("the calendar feature", () => {
  it("places events on a month calendar, and picking a day fills in the form's date", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(createGraph({ name: "Calendar" }));
    const compiled = await apply(workspace, app, {
      title: "Calendar",
      features: [
        { kind: "add", entity: "Event", fields: ["title", "start", "location"], button: "Add event" },
        { kind: "calendar", entity: "Event" },
        { kind: "list", entity: "Event", fields: ["title", "start"] },
      ],
    });
    expect(compiled.described).toContain("A month calendar of events by start; clicking a day fills in the date");
    const driver = new AppDriver(workspace, app);

    await driver.interact("Event calendar", "pick", "2026-12-24");
    expect(driver.output("Starts input", "value")).toBe("2026-12-24");
    await driver.type("Title input", "Christmas Eve dinner");
    await driver.press("Add event button");
    expect(driver.output("Event calendar", "count")).toBe(1);
    expect((driver.output("Event calendar", "onSelectedDate") as Array<{ title: string }>).map((row) => row.title)).toEqual(["Christmas Eve dinner"]);
    // The events are ordinary shared clasp.event records.
    const records = (await app.clasp.query({ source: driver.id("Events") })).records;
    expect(records[0]?.schema.id).toBe("clasp.event");
    expect(records[0]?.fields).toMatchObject({ title: "Christmas Eve dinner", start: "2026-12-24" });
  });

  it("explains when an entity has no date to place on a calendar", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const issues = compileFeatures(
      { entities: [{ name: "Recipe", fields: [{ name: "title", type: "text" }] }], features: [{ kind: "calendar", entity: "Recipe" }] },
      { graph: createGraph({ name: "x" }), registry: workspace.registry, schemas: workspace.schemas },
    ).issues;
    expect(issues).toEqual(['Recipe has no date field to place on a calendar. Add one (type "date") to the entity.']);
  });
});

describe("ready-made tools as features", () => {
  it("a calculator is one feature: the instrument itself, with no records or lists", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(createGraph({ name: "Untitled app" }));
    const compiled = await apply(workspace, app, { title: "Calculator", features: [{ kind: "tool", tool: "calculator" }] });
    expect(compiled.described).toEqual(["A calculator with a keypad and history"]);
    expect(Object.values(app.store.graph.objects).find((object) => object.type === "ui.window")?.properties.title).toBe("Calculator");
    const types = Object.values(app.store.graph.objects).map((object) => object.type).sort();
    expect(types).toEqual(["ui.calculator", "ui.window"]);
    const driver = new AppDriver(workspace, app);
    await driver.interact("Calculator", "keys", "6×7=");
    expect(driver.output("Calculator", "display")).toBe("42");
    expect(describeFeatures(app.store.graph, workspace.schemas)).toContain("tool calculator “Calculator”");

    // Asking again does not add a second one; a stopwatch is a different instrument.
    const again = compileFeatures({ features: [{ kind: "tool", tool: "calculator" }, { kind: "tool", tool: "stopwatch" }] }, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas });
    expect(again.described).toEqual(["A stopwatch with laps"]);
  });

  it("games come with a high-score list, and unknown tools are explained", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(createGraph({ name: "Untitled app" }));
    await apply(workspace, app, { title: "Word Guess", features: [{ kind: "tool", tool: "word-guess" }] });
    const driver = new AppDriver(workspace, app);
    workspace.requireApp(app.id).store.transact([{ op: "update", objectId: driver.id("Word guess"), properties: { words: ["ox"] } }]);
    await workspace.settle();
    await driver.interact("Word guess", "newGame");
    await driver.interact("Word guess", "guess", "o");
    await driver.interact("Word guess", "guess", "x");
    expect(driver.rows("High scores").map((row) => row.summary)).toEqual(["Guessed “ox” with 6 lives left"]);

    const { issues } = compileFeatures({ features: [{ kind: "tool", tool: "weather" as never }] }, { graph: app.store.graph, registry: workspace.registry, schemas: workspace.schemas });
    expect(issues[0]).toMatch(/^Unknown tool "weather"\. Use one of: calculator, clock, stopwatch, timer, terminal/);
  });
});
