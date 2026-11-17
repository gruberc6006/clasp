import { GraphBuilder } from "@clasp/core";
import { buildTaskManager } from "@clasp/examples";
import { describe, expect, it } from "vitest";
import { AppDriver, answerAccessRequest, expectCode, openWorkspace } from "./support";

describe("application composition", () => {
  async function setup() {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const registry = workspace.registry;
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(registry)));
    await workspace.settle();

    // "Home" uses the Task Manager as a component: it shows its task list,
    // displays its "remaining" output, reacts to its event and calls its action.
    const b = new GraphBuilder("Home");
    b.add("ui.window", { id: "win", name: "Window", properties: { title: "Home" } });
    b.add("app.embed", { id: "tasks", name: "Embedded tasks", parent: "win", properties: { appId: manager.app.id, view: "taskList" } });
    b.add("ui.button", { id: "quick", name: "Quick add", parent: "win", properties: { label: "Add standup" } });
    b.add("logic.trigger", { id: "standup", name: "Standup payload", properties: { payload: { title: "Standup" } } });
    b.add("ui.text", { id: "left", name: "Left", parent: "win", properties: { text: "{value} left" } });
    b.add("logic.state", { id: "sawChange", name: "Saw change", properties: { initial: false } });
    b.connect("quick.click", "standup.fire");
    b.connect("standup.fired", "tasks.addTask");
    b.connect("tasks.remaining", "left.value");
    b.connect("tasks.tasksChanged", "sawChange.toggle");
    const home = new AppDriver(workspace, await workspace.install(b.build(registry)));
    await workspace.settle();
    return { workspace, manager, home };
  }

  it("exposes another application's interface as ports, gated by permission", async () => {
    const { workspace, manager, home } = await setup();

    // The embedded app's declared interface became the embed's ports.
    const ports = workspace.registry.portsOf(home.app.store.graph.objects.tasks!);
    expect(ports?.actions.map((port) => port.name)).toEqual(["requestAccess", "refresh", "addTask"]);
    expect(ports?.outputs.map((port) => port.name)).toEqual(["status", "remaining"]);
    expect(ports?.events.map((port) => port.name)).toEqual(["failed", "tasksChanged"]);

    // Without a grant nothing crosses the boundary.
    expect(home.output("Embedded tasks", "status")).toBe("needs-access");
    expect(home.output("Left", "display")).toBe(" left");
    await home.press("Quick add");
    expect(manager.rows("Task list")).toEqual([]);
    expect(home.app.runtime.diagnostics().map((entry) => entry.code)).toContain("PERMISSION_DENIED");
    expect(() => workspace.resolveView(home.app.id, manager.app.id, "taskList")).toThrowError(/not allowed/);

    // The user approves the embed's request.
    home.app.runtime.invoke("tasks", "requestAccess");
    await workspace.settle();
    expect(workspace.kernel.permissions.pendingRequests()).toMatchObject([
      { subject: home.app.id, resource: manager.app.id, capabilities: ["object.read", "capability.invoke"] },
    ]);
    await answerAccessRequest(workspace, true);
    expect(home.output("Embedded tasks", "status")).toBe("connected");
    expect(home.output("Left", "display")).toBe("0 left");

    // Action in, event and output back — all through the Universal API.
    await home.press("Quick add");
    expect(manager.titles("Task list")).toEqual(["Standup"]);
    expect(home.output("Left", "display")).toBe("1 left");
    expect(home.output("Saw change", "value")).toBe(true);

    // The exposed view resolves to the embedded app's own running objects.
    const view = workspace.resolveView(home.app.id, manager.app.id, "taskList");
    expect(view.app.id).toBe(manager.app.id);
    expect(view.rootId).toBe(manager.id("Task list"));
    expect(() => workspace.resolveView(home.app.id, manager.app.id, "internals")).toThrowError(/no view named/);
  });

  it("keeps everything that is not exposed out of reach", async () => {
    const { workspace, manager, home } = await setup();
    workspace.kernel.permissions.grant({ subject: home.app.id, resource: manager.app.id, capability: "object.read" });
    workspace.kernel.permissions.grant({ subject: home.app.id, resource: manager.app.id, capability: "capability.invoke" });
    await manager.addTask("Private detail");

    // Access to the application is not access to its collection…
    await expectCode(home.app.clasp.query({ source: manager.id("Tasks") }), "PERMISSION_DENIED");
    // …and only declared actions, events and inputs exist from outside.
    await expectCode(home.app.clasp.invoke({ target: manager.app.id, action: "delete" }), "NOT_FOUND");
    await expectCode(home.app.clasp.invoke({ target: manager.app.id, action: "create" }), "NOT_FOUND");
    await expectCode(() => home.app.clasp.subscribe({ source: manager.app.id, event: "failed", handler: () => undefined }), "NOT_FOUND");
    await expectCode(home.app.clasp.mutate({ source: manager.app.id, operation: "set", data: { title: "x" } }), "PERMISSION_DENIED");
    // Exposed outputs are readable; nothing else is included.
    expect((await home.app.clasp.query({ source: manager.app.id })).values).toEqual({ remaining: 1 });

    // Un-exposing an action takes effect immediately.
    const face = manager.app.store.graph.interface;
    manager.app.store.transact([{ op: "setInterface", interface: { ...face, actions: [] } }]);
    await expectCode(home.app.clasp.invoke({ target: manager.app.id, action: "addTask", arguments: { title: "late" } }), "NOT_FOUND");
  });

  it("revoking access disconnects the embed", async () => {
    const { workspace, manager, home } = await setup();
    home.app.runtime.invoke("tasks", "requestAccess");
    await workspace.settle();
    await answerAccessRequest(workspace, true);
    expect(home.output("Embedded tasks", "status")).toBe("connected");

    workspace.kernel.permissions.revokeWhere({ subject: home.app.id });
    await workspace.settle();
    expect(home.output("Embedded tasks", "status")).toBe("needs-access");
    await manager.addTask("Unseen");
    expect(home.output("Left", "display")).toBe("0 left"); // last value it was allowed to see
    await home.press("Quick add");
    expect(manager.titles("Task list")).toEqual(["Unseen"]);
  });

  it("drives an embedded application's exposed inputs", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const registry = workspace.registry;
    const g = new GraphBuilder("Greeter");
    g.add("ui.window", { id: "gwin", name: "Window" });
    g.add("ui.text", { id: "hello", name: "Hello", parent: "gwin", properties: { text: "Hello, {value}!" } });
    g.exposeInput("name", "hello.value", "Who to greet");
    g.exposeOutput("greeting", "hello.display");
    g.exposeView("card", "gwin");
    const greeter = await workspace.install(g.build(registry));

    const h = new GraphBuilder("Host");
    h.add("ui.textInput", { id: "who", name: "Who", properties: { value: "Ada" } });
    h.add("app.embed", { id: "embed", name: "Embed", properties: { appId: greeter.id } });
    h.add("ui.text", { id: "echo", name: "Echo", properties: { text: "{value}" } });
    h.connect("who.value", "embed.name");
    h.connect("embed.greeting", "echo.value");
    const host = new AppDriver(workspace, await workspace.install(h.build(registry)));
    await workspace.settle();

    host.app.runtime.invoke("embed", "requestAccess");
    await workspace.settle();
    expect(workspace.kernel.permissions.pendingRequests()[0]?.capabilities).toEqual(["object.read", "object.write"]);
    await answerAccessRequest(workspace, true);
    expect(greeter.runtime.getOutput("hello", "display")).toBe("Hello, Ada!");
    expect(host.output("Echo", "display")).toBe("Hello, Ada!");

    await host.type("Who", "Grace");
    expect(greeter.runtime.getOutput("hello", "display")).toBe("Hello, Grace!");
    expect(host.output("Echo", "display")).toBe("Hello, Grace!");
  });

  it("tolerates an embedded application that is not installed", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const b = new GraphBuilder("Orphan host");
    b.add("app.embed", { id: "embed", name: "Embed", properties: { appId: "app_not_here" } });
    b.add("ui.text", { id: "label", name: "Label" });
    b.connect("embed.someOutput", "label.value");
    const result = workspace.registry.describe(b.build().objects.embed!);
    expect(result?.unresolved).toBe(true);
    const host = new AppDriver(workspace, await workspace.install(b.build(workspace.registry)));
    await workspace.settle();
    expect(host.output("Embed", "status")).toBe("unresolved");
    expect(host.app.runtime.status).toBe("running");
  });
});
