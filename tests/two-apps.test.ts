import { buildTaskDashboard, buildTaskManager } from "@clasp/examples";
import { describe, expect, it } from "vitest";
import { AppDriver, answerAccessRequest, expectCode, openWorkspace } from "./support";

/**
 * The primary acceptance test, at the platform level (no browser): two
 * independently built applications discover each other, share authorized
 * data, react to changes, persist, and stop sharing when permission is revoked.
 *
 * The browser-level version of the same scenario is tests/e2e/two-apps.spec.ts.
 */
describe("Task Manager + Task Dashboard", () => {
  it("runs the whole scenario end to end", async () => {
    // 1. Launch Clasp.
    let session = await openWorkspace();
    let { workspace } = session;
    const registry = workspace.registry;

    // 2. Open Task Manager and 3. create a task.
    let manager = new AppDriver(workspace, await workspace.install(buildTaskManager(registry)));
    await manager.addTask("Write the acceptance test");
    expect(manager.titles("Task list")).toEqual(["Write the acceptance test"]);
    expect(manager.output("Title input", "value")).toBe(""); // the form cleared itself
    expect(manager.output("Remaining label", "display")).toBe("1 remaining");
    const tasksId = manager.id("Tasks");

    // 4. Open Task Dashboard. It discovers the collection but cannot read it.
    let dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(registry)));
    await workspace.settle();
    expect(dashboard.output("Task source", "status")).toBe("unbound");
    expect(dashboard.rows("Available sources")).toEqual([
      { id: tasksId, name: "Tasks", ownerName: "Task Manager", schema: "clasp.task" },
    ]);
    expect(dashboard.visible("Connect panel")).toBe(true);
    expect(dashboard.visible("Dashboard")).toBe(false);
    expect(workspace.kernel.permissions.list()).toEqual([]);
    await expectCode(dashboard.app.clasp.query({ source: tasksId }), "PERMISSION_DENIED");

    // Choosing a source binds the reference but grants nothing.
    await dashboard.interact("Available sources", "select", { id: tasksId });
    expect(dashboard.output("Task source", "status")).toBe("needs-access");
    expect(dashboard.output("Task source", "records")).toEqual([]);
    expect(dashboard.output("Access explanation", "display")).toBe(
      "This dashboard needs permission to read “Tasks” from Task Manager.",
    );

    // 5. Grant the dashboard read access (the user approves its request).
    await dashboard.press("Request access button");
    expect(dashboard.output("Task source", "status")).toBe("pending");
    expect(workspace.kernel.permissions.pendingRequests()).toMatchObject([
      { subject: dashboard.app.id, resource: tasksId, capabilities: ["collection.query"], reason: "Show your tasks on the dashboard." },
    ]);
    await answerAccessRequest(workspace, true);

    // 6. The task appears.
    expect(dashboard.output("Task source", "status")).toBe("connected");
    expect(dashboard.visible("Dashboard")).toBe(true);
    expect(dashboard.visible("Connect panel")).toBe(false);
    expect(dashboard.titles("Task table", "rows")).toEqual(["Write the acceptance test"]);
    expect(dashboard.output("Active stat", "display")).toBe("1");
    expect(workspace.kernel.permissions.list()).toMatchObject([
      { subject: dashboard.app.id, resource: tasksId, capability: "collection.query" },
    ]);
    // Read access is all it got.
    await expectCode(
      dashboard.app.clasp.mutate({ source: tasksId, operation: "create", data: { title: "Sneaky" } }),
      "PERMISSION_DENIED",
    );

    // 7. Edit the task in Task Manager; 8. the dashboard updates by itself.
    const [task] = manager.rows("Task list");
    await manager.interact("Task list", "edit", { id: task!.id as string, value: "Write the acceptance test (edited)" });
    expect(dashboard.titles("Task table", "rows")).toEqual(["Write the acceptance test (edited)"]);
    await manager.addTask("Second task");
    await manager.interact("Task list", "toggle", { id: task!.id as string });
    expect(dashboard.output("Total stat", "display")).toBe("2");
    expect(dashboard.output("Active stat", "display")).toBe("1");
    expect(dashboard.output("Completed stat", "display")).toBe("1");

    // The dashboard filters completed and active tasks.
    await dashboard.interact("Status tabs", "select", 1);
    expect(dashboard.titles("Task table", "rows")).toEqual(["Second task"]);
    await dashboard.interact("Status tabs", "select", 2);
    expect(dashboard.titles("Task table", "rows")).toEqual(["Write the acceptance test (edited)"]);
    await dashboard.interact("Status tabs", "select", 0);
    expect(dashboard.titles("Task table", "rows")).toHaveLength(2);

    // So does the Task Manager ("view active tasks").
    await manager.interact("Status tabs", "select", 1);
    expect(manager.titles("Task list")).toEqual(["Second task"]);
    await manager.interact("Status tabs", "select", 0);

    // 9. Reload Clasp. 10. Both applications and their data persist.
    const managerId = manager.app.id;
    const dashboardId = dashboard.app.id;
    session = await session.reload();
    workspace = session.workspace;
    expect(workspace.apps().map((app) => app.id).sort()).toEqual([managerId, dashboardId].sort());
    manager = new AppDriver(workspace, workspace.requireApp(managerId));
    dashboard = new AppDriver(workspace, workspace.requireApp(dashboardId));
    expect(manager.titles("Task list")).toEqual(["Write the acceptance test (edited)", "Second task"]);
    expect(manager.rows("Task list")[0]?.completed).toBe(true);
    expect(dashboard.output("Task source", "status")).toBe("connected");
    expect(dashboard.titles("Task table", "rows")).toEqual(["Write the acceptance test (edited)", "Second task"]);

    // 11. Revoke the dashboard's permission.
    const [grant] = workspace.kernel.permissions.list({ subject: dashboardId });
    workspace.kernel.permissions.revoke(grant!.id);
    await workspace.settle();

    // 12. Subsequent queries and updates are denied.
    expect(dashboard.output("Task source", "status")).toBe("needs-access");
    expect(dashboard.output("Task source", "records")).toEqual([]);
    expect(dashboard.rows("Task table", "rows")).toEqual([]);
    expect(dashboard.visible("Dashboard")).toBe(false);
    await expectCode(dashboard.app.clasp.query({ source: tasksId }), "PERMISSION_DENIED");
    await expectCode(() => dashboard.app.clasp.subscribe({ source: tasksId, handler: () => undefined }), "PERMISSION_DENIED");
    await manager.addTask("Created after revocation");
    expect(manager.titles("Task list")).toContain("Created after revocation");
    expect(dashboard.output("Task source", "records")).toEqual([]);
    await dashboard.app.runtime.invoke(dashboard.id("Task source"), "refresh");
    await workspace.settle();
    expect(dashboard.output("Task source", "records")).toEqual([]);

    // Revocation survives a reload too.
    session = await session.reload();
    workspace = session.workspace;
    dashboard = new AppDriver(workspace, workspace.requireApp(dashboardId));
    expect(dashboard.output("Task source", "status")).toBe("needs-access");
    expect(dashboard.output("Task source", "records")).toEqual([]);
    await workspace.close();
  });

  it("denying the request leaves the dashboard without data", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Secret");
    const dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(workspace.registry)));
    await workspace.settle();
    await dashboard.interact("Available sources", "select", { id: manager.id("Tasks") });
    await dashboard.press("Request access button");
    await answerAccessRequest(workspace, false);
    expect(dashboard.output("Task source", "status")).toBe("needs-access");
    expect(dashboard.output("Task source", "records")).toEqual([]);
    expect(workspace.kernel.permissions.list()).toEqual([]);
  });

  it("a private collection is neither discoverable nor requestable", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    manager.app.store.transact([{ op: "update", objectId: manager.id("Tasks"), properties: { exposure: "private" } }]);
    await manager.addTask("Hidden");
    const dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(workspace.registry)));
    await workspace.settle();
    expect(dashboard.rows("Available sources")).toEqual([]);
    const tasksId = manager.id("Tasks");
    await expectCode(dashboard.app.clasp.query({ source: tasksId }), "PERMISSION_DENIED");
    await expectCode(dashboard.app.clasp.requestAccess({ resource: tasksId, capabilities: ["collection.query"] }), "PERMISSION_DENIED");
    expect(await dashboard.app.clasp.discover({ schema: "clasp.task" })).toEqual([]);
  });

  it("rejects invalid tasks without creating anything, and reports why", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    // The form refuses an empty required field…
    await manager.addTask("   ");
    expect(manager.rows("Task list")).toEqual([]);
    // …and the collection itself rejects data that violates clasp.task.
    manager.app.runtime.invoke(manager.id("Tasks"), "create", { title: "ok", priority: "sky-high" });
    await workspace.settle();
    expect(manager.rows("Task list")).toEqual([]);
    expect(manager.output("Tasks", "error")).toContain("priority");
    expect(manager.app.runtime.diagnostics().map((entry) => entry.code)).toContain("VALIDATION_FAILED");
  });

  it("deleting a task removes it everywhere", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
    await manager.addTask("Keep");
    await manager.addTask("Remove");
    const doomed = manager.rows("Task list").find((row) => row.title === "Remove");
    await manager.interact("Task list", "remove", { id: doomed!.id as string });
    expect(manager.titles("Task list")).toEqual(["Keep"]);
    expect(workspace.kernel.data.count(manager.id("Tasks"))).toBe(1);
  });
});
