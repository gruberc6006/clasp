import { GraphBuilder, GraphStore, createGraph, type ClaspGraph } from "@clasp/core";
import { buildTaskManager, buildTaskNotifier, createStandardRegistry } from "@clasp/examples";
import type { ComponentDefinition, TimerHost } from "@clasp/runtime";
import { NOTIFICATION_SERVICE_ID } from "@clasp/workflows";
import { describe, expect, it } from "vitest";
import { AppDriver, answerAccessRequest, openWorkspace } from "./support";

async function install(build: (b: GraphBuilder) => void, options: Parameters<typeof openWorkspace>[0] = { backend: "memory" }) {
  const session = await openWorkspace(options);
  const builder = new GraphBuilder("Test app");
  build(builder);
  const app = await session.workspace.install(builder.build(session.workspace.registry));
  await session.workspace.settle();
  return { ...session, driver: new AppDriver(session.workspace, app), app };
}

describe("deterministic execution", () => {
  it("propagates values through connections in dependency order", async () => {
    const { driver } = await install((b) => {
      // Declared "backwards" on purpose: order comes from dependencies, not declaration.
      b.add("ui.text", { id: "label", name: "Label", properties: { text: "Total: {value}" } });
      b.add("logic.math", { id: "sum", name: "Sum", properties: { operation: "add" } });
      b.add("ui.numberInput", { id: "a", name: "A", properties: { value: 2 } });
      b.add("ui.numberInput", { id: "b", name: "B", properties: { value: 3 } });
      b.connect("a.value", "sum.a");
      b.connect("b.value", "sum.b");
      b.connect("sum.result", "label.value");
    });
    expect(driver.output("Label", "display")).toBe("Total: 5");
    await driver.interact("A", "input", 40);
    expect(driver.output("Label", "display")).toBe("Total: 43");
  });

  it("produces identical results for identical inputs", async () => {
    const run = async (): Promise<unknown[]> => {
      const { driver } = await install((b) => {
        b.add("logic.state", { id: "s", name: "State", properties: { initial: 0 } });
        b.add("logic.trigger", { id: "t", name: "Trigger" });
        b.add("workflow.sequence", { id: "seq", name: "Sequence" });
        b.connect("t.fired", "seq.run");
        b.connect("seq.first", "s.set");
        b.connect("seq.second", "s.toggle");
        b.connect("seq.third", "s.toggle");
      });
      const seen: unknown[] = [];
      driver.app.runtime.onOutput((record) => seen.push([record.objectId, record.port, record.value]));
      driver.app.runtime.invoke("t", "fire", 7);
      return seen;
    };
    const first = await run();
    expect(first).toEqual([
      ["s", "value", 7],
      ["s", "value", false],
      ["s", "value", true],
    ]);
    expect(await run()).toEqual(first);
  });

  it("delivers event payloads to actions and never needs an interface", async () => {
    const { driver } = await install((b) => {
      b.add("logic.trigger", { id: "start", name: "Start", properties: { onStart: true, payload: { title: "Seeded on start" } } });
      b.add("data.collection", { id: "notes", name: "Notes", properties: { schema: "clasp.task" } });
      b.connect("start.fired", "notes.create");
    });
    expect((driver.output("Notes", "records") as unknown[]).length).toBe(1);
    expect(driver.output("Notes", "count")).toBe(1);
  });
});

describe("execution limits", () => {
  it("halts a synchronous event loop instead of hanging", async () => {
    const { driver, app } = await install((b) => {
      b.add("logic.trigger", { id: "ping", name: "Ping" });
      b.add("logic.trigger", { id: "pong", name: "Pong" });
      b.connect("ping.fired", "pong.fire");
      b.connect("pong.fired", "ping.fire");
    });
    app.runtime.invoke("ping", "fire");
    expect(app.runtime.status).toBe("halted");
    const [diagnostic] = app.runtime.diagnostics().filter((entry) => entry.code === "EXECUTION_LIMIT_EXCEEDED");
    expect(diagnostic?.message).toContain("loop");
    // A halted runtime ignores further stimulation; restarting recovers it.
    app.runtime.invoke("ping", "fire");
    app.runtime.restart();
    expect(app.runtime.status).toBe("running");
    expect(driver.id("Ping")).toBe("ping");
  });

  it("halts a loop that bounces through asynchronous work", async () => {
    const { workspace, app } = await install(
      (b) => {
        // Every change to the collection creates another record: a runaway.
        b.add("data.collection", { id: "tasks", name: "Tasks", properties: { schema: "clasp.task" } });
        b.add("logic.trigger", { id: "again", name: "Again", properties: { payload: { title: "more" } } });
        b.connect("tasks.changed", "again.fire");
        b.connect("again.fired", "tasks.create");
      },
      { backend: "memory", limits: { maxStepsPerSecond: 60 } },
    );
    app.runtime.invoke("tasks", "create", { title: "first" });
    await workspace.settle();
    expect(app.runtime.status).toBe("halted");
    expect(workspace.kernel.data.count("tasks")).toBeLessThan(80);
    expect(app.runtime.diagnostics().some((entry) => entry.code === "EXECUTION_LIMIT_EXCEEDED")).toBe(true);
  });

  it("refuses to run a graph with a value cycle and says why", async () => {
    const session = await openWorkspace({ backend: "memory" });
    // Build the cyclic graph without a catalog so validation cannot stop us —
    // as could happen with a hand-edited or corrupted stored graph.
    const b = new GraphBuilder("Cyclic");
    b.add("logic.math", { id: "x", name: "X" });
    b.add("logic.math", { id: "y", name: "Y" });
    const graph = b.build();
    const cyclic: ClaspGraph = {
      ...graph,
      connections: {
        c1: { id: "c1", kind: "value", source: { objectId: "x", port: "result" }, target: { objectId: "y", port: "a" } },
        c2: { id: "c2", kind: "value", source: { objectId: "y", port: "result" }, target: { objectId: "x", port: "a" } },
      },
    };
    await expect(session.workspace.install(cyclic)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("failure handling", () => {
  const explosive: ComponentDefinition = {
    type: "test.explosive",
    version: 1,
    category: "logic",
    title: "Explosive",
    description: "Throws when run.",
    properties: [],
    inputs: [],
    outputs: [],
    events: [{ name: "survived" }],
    actions: [{ name: "run" }],
    create: (ctx) => ({
      actions: {
        run: () => {
          ctx.emit("survived");
          throw new Error("kaboom");
        },
      },
    }),
  };

  it("contains a failing component and keeps the rest of the graph running", async () => {
    const session = await openWorkspace({ backend: "memory" });
    session.workspace.registry.register(explosive);
    const b = new GraphBuilder("Fragile");
    b.add("test.explosive", { id: "bomb", name: "Bomb" });
    b.add("logic.state", { id: "state", name: "State", properties: { initial: "untouched" } });
    b.add("logic.trigger", { id: "t", name: "Trigger", properties: { payload: "still works" } });
    b.connect("t.fired", "bomb.run");
    b.connect("t.fired", "state.set");
    const app = await session.workspace.install(b.build(session.workspace.registry));
    const reported: string[] = [];
    session.workspace.onError((report) => reported.push(report.error.message));

    app.runtime.invoke("t", "fire");
    expect(app.runtime.status).toBe("running");
    expect(app.runtime.getOutput("state", "value")).toBe("still works");
    expect(app.runtime.view("bomb")?.error).toBe("kaboom");
    expect(app.runtime.diagnostics().map((entry) => [entry.objectId, entry.message])).toContainEqual(["bomb", "kaboom"]);
    expect(reported).toContain("kaboom");
  });

  it("reports objects whose component is not registered and runs the rest", async () => {
    const session = await openWorkspace({ backend: "memory" });
    const b = new GraphBuilder("Partly unknown");
    b.add("ui.text", { id: "ok", name: "Fine", properties: { text: "hello" } });
    const graph = b.build(session.workspace.registry);
    const tampered: ClaspGraph = {
      ...graph,
      objects: {
        ...graph.objects,
        ghost: { ...graph.objects.ok!, id: "ghost", type: "vendor.missing", properties: {} },
      },
    };
    // Installation validates and refuses…
    await expect(session.workspace.install(tampered)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // …but a graph that is already stored (e.g. a component was uninstalled) still opens.
    await session.workspace.storage.saveGraph(tampered);
    const reopened = await session.reload();
    const app = reopened.workspace.requireApp(graph.id);
    expect(app.runtime.status).toBe("running");
    expect(app.runtime.getOutput("ok", "display")).toBe("hello");
    expect(app.runtime.diagnostics().map((entry) => entry.code)).toContain("UNKNOWN_TYPE");
  });
});

describe("live editing while running", () => {
  it("applies property changes, new connections and deletions without restarting", async () => {
    const { driver, app } = await install((b) => {
      b.add("ui.textInput", { id: "name", name: "Name", properties: { value: "Ada" } });
      b.add("ui.text", { id: "greeting", name: "Greeting", properties: { text: "Hello" } });
    });
    expect(driver.output("Greeting", "display")).toBe("Hello");

    app.store.transact([
      { op: "update", objectId: "greeting", properties: { text: "Hello, {value}!" } },
      { op: "connect", connection: { id: "wire", source: { objectId: "name", port: "value" }, target: { objectId: "greeting", port: "value" } } },
    ]);
    expect(driver.output("Greeting", "display")).toBe("Hello, Ada!");

    await driver.type("Name", "Grace");
    expect(driver.output("Greeting", "display")).toBe("Hello, Grace!");

    // Reconfiguring an object keeps its runtime state…
    app.store.transact([{ op: "update", objectId: "name", properties: { placeholder: "Your name" } }]);
    expect(driver.output("Name", "value")).toBe("Grace");
    expect(driver.output("Greeting", "display")).toBe("Hello, Grace!");

    // …and removing a source makes its consumers fall back.
    app.store.transact([{ op: "delete", objectId: "name" }]);
    expect(driver.output("Greeting", "display")).toBe("Hello, !");
    expect(app.runtime.status).toBe("running");
  });

  it("follows undo and redo", async () => {
    const { driver, app } = await install((b) => {
      b.add("ui.text", { id: "label", name: "Label", properties: { text: "one" } });
    });
    app.store.transact([{ op: "update", objectId: "label", properties: { text: "two" } }]);
    expect(driver.output("Label", "display")).toBe("two");
    app.store.undo();
    expect(driver.output("Label", "display")).toBe("one");
    app.store.redo();
    expect(driver.output("Label", "display")).toBe("two");
  });

  it("keeps records when the definition changes, even if the collection is removed and restored", async () => {
    const session = await openWorkspace();
    let app = await session.workspace.install(buildTaskManager(session.workspace.registry));
    let driver = new AppDriver(session.workspace, app);
    await driver.addTask("Precious data");
    const collectionId = driver.id("Tasks");

    // Rework the interface: drop the list, add a table instead.
    app.store.transact([
      { op: "delete", objectId: driver.id("Task list") },
      { op: "create", object: { id: "tbl", type: "ui.table", name: "Task table", parentId: driver.id("Window") } },
      { op: "connect", connection: { source: { objectId: driver.id("Status filter"), port: "records" }, target: { objectId: "tbl", port: "rows" } } },
    ]);
    await session.workspace.settle();
    expect(driver.titles("Task table", "rows")).toEqual(["Precious data"]);

    // Even deleting the collection object does not erase its records.
    app.store.transact([{ op: "delete", objectId: collectionId }]);
    await session.workspace.settle();
    expect(session.workspace.kernel.data.count(collectionId)).toBe(1);
    app.store.undo();
    await session.workspace.settle();
    expect(driver.titles("Task table", "rows")).toEqual(["Precious data"]);

    // And all of that survives a reload.
    const reloaded = await session.reload();
    app = reloaded.workspace.requireApp(app.id);
    driver = new AppDriver(reloaded.workspace, app);
    expect(driver.titles("Task table", "rows")).toEqual(["Precious data"]);
    await reloaded.workspace.close();
  });
});

describe("component lifecycle", () => {
  it("drives timers from the host clock and stops them on dispose", async () => {
    const callbacks = new Map<number, () => void>();
    let next = 1;
    const timers: TimerHost = {
      setInterval: (callback) => {
        callbacks.set(next, callback);
        return next++;
      },
      clearInterval: (handle) => void callbacks.delete(handle as number),
    };
    const { driver, app } = await install(
      (b) => {
        b.add("logic.timer", { id: "timer", name: "Timer", properties: { interval: 100, autoStart: true } });
        b.add("ui.text", { id: "label", name: "Label", properties: { text: "ticks: {value}" } });
        b.connect("timer.count", "label.value");
      },
      { backend: "memory", timers },
    );
    expect(callbacks.size).toBe(1);
    const tick = (): void => [...callbacks.values()].forEach((callback) => callback());
    tick();
    tick();
    expect(driver.output("Label", "display")).toBe("ticks: 2");
    app.runtime.invoke("timer", "stop");
    expect(callbacks.size).toBe(0);
    app.runtime.invoke("timer", "start");
    expect(callbacks.size).toBe(1);
    app.runtime.stop();
    expect(callbacks.size).toBe(0);
  });

  it("releases every subscription when an application is uninstalled", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const app = await workspace.install(buildTaskManager(workspace.registry));
    await workspace.settle();
    expect(workspace.kernel.subscriptionCount(app.id)).toBeGreaterThan(0);
    await workspace.uninstall(app.id);
    expect(workspace.kernel.subscriptionCount()).toBe(0);
    expect(workspace.apps()).toEqual([]);
    expect(await workspace.storage.loadGraphs()).toEqual([]);
  });

  it("keeps or erases records on uninstall, as asked", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const keep = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await keep.addTask("kept");
    const keptCollection = keep.id("Tasks");
    await workspace.uninstall(keep.app.id);
    expect(workspace.kernel.data.count(keptCollection)).toBe(1);

    const erase = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await erase.addTask("erased");
    const erasedCollection = erase.id("Tasks");
    await workspace.uninstall(erase.app.id, { deleteData: true });
    expect(workspace.kernel.data.count(erasedCollection)).toBe(0);
    expect((await workspace.storage.loadRecords()).map((record) => record.collectionId)).toEqual([keptCollection]);
  });
});

describe("background workflows", () => {
  it("run on the same runtime as visual apps and are bound by the same permissions", async () => {
    const { workspace, notifications } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    const notifier = new AppDriver(workspace, await workspace.install(buildTaskNotifier(workspace.registry)));
    await workspace.settle();
    const tasksId = manager.id("Tasks");

    // It found the only task collection by schema, but has no access yet.
    expect(notifier.app.store.graph.objects[notifier.id("Task changes")]?.properties.collectionId).toBe(tasksId);
    expect(notifier.output("Task changes", "status")).toBe("needs-access");
    expect(workspace.requirements(notifier.app.id).map((entry) => [entry.capability, entry.resource, entry.satisfied])).toEqual([
      ["collection.query", tasksId, false],
      ["capability.invoke", NOTIFICATION_SERVICE_ID, false],
    ]);

    await manager.addTask("Unwatched");
    const [unwatched] = manager.rows("Task list");
    await manager.interact("Task list", "toggle", { id: unwatched!.id as string });
    expect(notifications.list()).toEqual([]);

    // Grant read access through the app's own request…
    await notifier.press("Request access button");
    await answerAccessRequest(workspace, true);
    expect(notifier.output("Task changes", "status")).toBe("listening");

    // …then complete a task: the workflow asks to notify, the user agrees, it is delivered.
    await manager.addTask("Ship Clasp");
    const ship = manager.rows("Task list").find((row) => row.title === "Ship Clasp");
    await manager.interact("Task list", "toggle", { id: ship!.id as string });
    expect(notifications.list()).toEqual([]);
    expect(workspace.kernel.permissions.pendingRequests()).toMatchObject([
      { subject: notifier.app.id, resource: NOTIFICATION_SERVICE_ID, capabilities: ["capability.invoke"], actions: ["send"] },
    ]);
    await answerAccessRequest(workspace, true);
    expect(notifications.list()).toMatchObject([
      { title: "Task completed", message: "“Ship Clasp” is done.", level: "success", fromName: "Task Notifier" },
    ]);

    // Un-completing and editing do not notify; completing again does.
    await manager.interact("Task list", "toggle", { id: ship!.id as string });
    await manager.interact("Task list", "edit", { id: ship!.id as string, value: "Ship Clasp 1.0" });
    expect(notifications.list()).toHaveLength(1);
    await manager.interact("Task list", "toggle", { id: ship!.id as string });
    expect(notifications.list().map((entry) => entry.message)).toEqual(["“Ship Clasp 1.0” is done.", "“Ship Clasp” is done."]);
    expect(workspace.requirements(notifier.app.id).every((entry) => entry.satisfied)).toBe(true);

    // Revoking the collection grant silences it immediately.
    workspace.kernel.permissions.revokeWhere({ subject: notifier.app.id, resource: tasksId });
    await workspace.settle();
    expect(notifier.output("Task changes", "status")).toBe("needs-access");
    await manager.addTask("After revoke");
    const after = manager.rows("Task list").find((row) => row.title === "After revoke");
    await manager.interact("Task list", "toggle", { id: after!.id as string });
    expect(notifications.list()).toHaveLength(2);
  });
});

describe("component registry", () => {
  it("describes every component in a machine-readable way", () => {
    const registry = createStandardRegistry();
    const catalog = registry.catalog();
    expect(catalog.length).toBeGreaterThanOrEqual(30);
    for (const entry of catalog) {
      expect(entry.type).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(Array.isArray(entry.properties)).toBe(true);
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry); // pure data, no code
    }
    const types = catalog.map((entry) => entry.type);
    for (const required of ["ui.window", "ui.button", "ui.textInput", "ui.list", "ui.form", "data.collection", "data.filter", "logic.compare", "workflow.listener", "app.embed"]) {
      expect(types).toContain(required);
    }
    expect(catalog.find((entry) => entry.type === "data.reference")?.capabilities?.[0]?.capability).toBe("collection.query");
  });

  it("validates object properties against the configuration schema", () => {
    const registry = createStandardRegistry();
    const store = new GraphStore(createGraph({ name: "Props" }), { catalog: registry });
    expect(() => store.transact([{ op: "create", object: { type: "ui.button", properties: { colour: "red" } } }])).toThrowError(/no property "colour"/);
    expect(() => store.transact([{ op: "create", object: { type: "ui.button", properties: { variant: "huge" } } }])).toThrowError(/must be one of/);
    expect(() => store.transact([{ op: "create", object: { type: "ui.button", properties: { label: 5 } } }])).toThrowError(/must be text/);
    const result = store.transact([{ op: "create", object: { type: "data.filter" } }]);
    expect(result.warnings.map((entry) => entry.code)).toEqual(["MISSING_PROPERTY"]);
    expect(() => registry.register(registry.get("ui.button")!)).toThrowError(/already registered/);
  });
});
