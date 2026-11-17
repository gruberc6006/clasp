import { GraphBuilder } from "@clasp/core";
import { buildTaskDashboard, buildTaskManager } from "@clasp/examples";
import {
  PACKAGE_FORMAT,
  checkDependencies,
  exportPackage,
  forkGraph,
  importPackage,
  packageFileName,
  serializePackage,
  validatePackage,
  type ClaspPackage,
} from "@clasp/sharing";
import { describe, expect, it } from "vitest";
import { AppDriver, answerAccessRequest, expectCode, openWorkspace } from "./support";

async function connectedPair() {
  const session = await openWorkspace({ backend: "memory" });
  const { workspace } = session;
  const manager = new AppDriver(workspace, await workspace.install(buildTaskManager(workspace.registry)));
  await manager.addTask("Private task");
  const dashboard = new AppDriver(workspace, await workspace.install(buildTaskDashboard(workspace.registry)));
  await workspace.settle();
  await dashboard.interact("Available sources", "select", { id: manager.id("Tasks") });
  await dashboard.press("Request access button");
  await answerAccessRequest(workspace, true);
  expect(dashboard.titles("Task table", "rows")).toEqual(["Private task"]);
  const env = {
    registry: workspace.registry,
    schemas: workspace.schemas,
    describeResource: (id: string) => {
      const resource = workspace.kernel.getResource(id);
      return resource ? { name: resource.name, kind: resource.kind, ...(resource.schema ? { schema: resource.schema.id } : {}) } : undefined;
    },
  };
  return { session, workspace, manager, dashboard, env };
}

describe("package export", () => {
  it("captures the definition and its dependencies — and no private data", async () => {
    const { workspace, manager, dashboard, env } = await connectedPair();
    const pkg = exportPackage(dashboard.app.store.graph, env);

    expect(pkg.format).toBe(PACKAGE_FORMAT);
    expect(pkg.formatVersion).toBe(1);
    expect(pkg.app).toMatchObject({ id: dashboard.app.id, name: "Task Dashboard" });
    expect(pkg.requires.api).toBe(1);
    expect(pkg.requires.components.map((component) => component.type)).toEqual(
      expect.arrayContaining(["ui.window", "data.reference", "data.filter", "ui.table", "logic.compare"]),
    );
    expect(pkg.requires.schemas).toEqual([{ id: "clasp.task", version: 1 }]);
    expect(pkg.requires.capabilities).toEqual([
      {
        capability: "collection.query",
        resource: manager.id("Tasks"),
        resourceName: "Tasks",
        resourceKind: "collection",
        schema: "clasp.task",
        reason: "Read records",
      },
    ]);
    expect(packageFileName(pkg)).toBe("task-dashboard.clasp.json");

    // Nothing private travels: no records, no grants, no runtime state.
    const text = serializePackage(pkg);
    expect(text).not.toContain("Private task");
    const [grant] = workspace.kernel.permissions.list();
    expect(text).not.toContain(grant!.id);
    expect(Object.keys(pkg).sort()).toEqual(["app", "assets", "format", "formatVersion", "graph", "id", "metadata", "requires", "schemas"]);

    // The Task Manager's package does not contain its tasks either.
    const managerPackage = serializePackage(exportPackage(manager.app.store.graph, env));
    expect(managerPackage).not.toContain("Private task");
  });

  it("bundles custom schemas and optional presentation and assets", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    workspace.schemas.register({ id: "acme.recipe", version: 1, title: "Recipe", extends: "clasp.document", fields: { servings: { type: "number" } } });
    const b = new GraphBuilder("Recipes");
    const id = b.add("data.collection", { name: "Recipes", properties: { schema: "acme.recipe" } });
    const pkg = exportPackage(b.build(workspace.registry), {
      registry: workspace.registry,
      schemas: workspace.schemas,
      presentation: { nodes: { [id]: { x: 10, y: 20 } } },
      assets: { "icon.svg": { mimeType: "image/svg+xml", data: "PHN2Zy8+" } },
    });
    expect(pkg.requires.schemas.map((schema) => schema.id).sort()).toEqual(["acme.recipe", "clasp.contact", "clasp.document", "clasp.project"].filter((s) => ["acme.recipe", "clasp.document"].includes(s)));
    expect(pkg.schemas.map((schema) => schema.id)).toEqual(["acme.recipe"]);
    expect(pkg.presentation?.nodes[id]).toEqual({ x: 10, y: 20 });
    expect(pkg.assets["icon.svg"]?.mimeType).toBe("image/svg+xml");

    // A workspace that has never seen the schema learns it from the package.
    const other = await openWorkspace({ backend: "memory" });
    expect(other.workspace.schemas.has("acme.recipe")).toBe(false);
    const result = importPackage(JSON.parse(serializePackage(pkg)), other.workspace);
    expect(result.registeredSchemas).toEqual(["acme.recipe@1"]);
    expect(other.workspace.schemas.require("acme.recipe").lineage).toEqual(["acme.recipe", "clasp.document"]);
    const [newId] = Object.keys(result.graph.objects);
    expect(result.presentation?.nodes[newId!]).toEqual({ x: 10, y: 20 });
    const app = await other.workspace.install(result.graph);
    await app.clasp.mutate({ source: newId!, operation: "create", data: { title: "Soup", servings: 4 } });
    expect(other.workspace.kernel.data.count(newId!)).toBe(1);
  });
});

describe("package validation", () => {
  async function samplePackage(): Promise<{ pkg: ClaspPackage; env: Awaited<ReturnType<typeof connectedPair>>["env"] }> {
    const { dashboard, env } = await connectedPair();
    return { pkg: exportPackage(dashboard.app.store.graph, env), env };
  }

  it("round-trips through JSON", async () => {
    const { pkg } = await samplePackage();
    expect(validatePackage(serializePackage(pkg))).toEqual(pkg);
  });

  it("rejects files that are not packages, are malformed, tampered with or too new", async () => {
    const { pkg } = await samplePackage();
    await expectCode(() => validatePackage("not json"), "VALIDATION_FAILED");
    await expectCode(() => validatePackage({ hello: "world" }), "VALIDATION_FAILED");
    await expectCode(() => validatePackage({ ...pkg, requires: undefined }), "VALIDATION_FAILED");
    await expectCode(() => validatePackage({ ...pkg, formatVersion: 2 }), "INCOMPATIBLE");
    await expectCode(() => validatePackage({ ...pkg, requires: { ...pkg.requires, api: 9 } }), "INCOMPATIBLE");

    const tampered = JSON.parse(serializePackage(pkg)) as ClaspPackage;
    const reference = Object.values(tampered.graph.objects).find((object) => object.type === "data.reference")!;
    reference.properties.writable = true;
    const error = await expectCode(() => validatePackage(tampered), "VALIDATION_FAILED");
    expect(error.message).toContain("checksum");
  });

  it("reports missing and outdated dependencies", async () => {
    const { pkg, env } = await samplePackage();
    expect(checkDependencies(pkg, env).ok).toBe(true);

    const needsMore: ClaspPackage = {
      ...pkg,
      requires: {
        ...pkg.requires,
        components: [...pkg.requires.components, { type: "vendor.chart", version: 1 }, { type: "ui.window", version: 7 }],
        schemas: [...pkg.requires.schemas, { id: "vendor.invoice", version: 1 }],
      },
    };
    const report = checkDependencies(needsMore, env);
    expect(report.ok).toBe(false);
    expect(report.missingComponents).toEqual(["vendor.chart"]);
    expect(report.outdatedComponents).toEqual([{ type: "ui.window", required: 7, available: 1 }]);
    expect(report.missingSchemas).toEqual(["vendor.invoice"]);
    const error = await expectCode(() => importPackage(needsMore, env), "INCOMPATIBLE");
    expect(error.issues.map((entry) => entry.code).sort()).toEqual(["MISSING_COMPONENT", "MISSING_SCHEMA", "OUTDATED_COMPONENT"]);
  });
});

describe("package import", () => {
  it("gives the imported application a completely new identity", async () => {
    const { dashboard, env } = await connectedPair();
    const pkg = exportPackage(dashboard.app.store.graph, env);
    const result = importPackage(JSON.parse(serializePackage(pkg)), env);
    const original = dashboard.app.store.graph;

    expect(result.graph.id).not.toBe(original.id);
    expect(Object.keys(result.graph.objects)).toHaveLength(Object.keys(original.objects).length);
    expect(Object.keys(result.graph.connections)).toHaveLength(Object.keys(original.connections).length);
    for (const id of Object.keys(result.graph.objects)) expect(original.objects[id]).toBeUndefined();
    for (const id of Object.keys(result.graph.connections)) expect(original.connections[id]).toBeUndefined();
    // Structure is preserved through the id map.
    for (const object of Object.values(original.objects)) {
      const copy = result.graph.objects[result.idMap[object.id]!]!;
      expect(copy.type).toBe(object.type);
      expect(copy.metadata.name).toBe(object.metadata.name);
      expect(copy.parentId).toBe(object.parentId ? result.idMap[object.parentId] : undefined);
    }
    expect(result.graph.metadata.origin).toEqual({ appId: original.id, packageId: pkg.id, version: original.version, name: "Task Dashboard" });
    expect(result.requiredCapabilities).toHaveLength(1);
    expect(result.externalReferences).toMatchObject([{ property: "collectionId" }]);
  });

  it("does not inherit the original's access — in the same workspace", async () => {
    const { workspace, manager, dashboard, env } = await connectedPair();
    const pkg = exportPackage(dashboard.app.store.graph, env);
    const grantsBefore = workspace.kernel.permissions.list();

    const copy = new AppDriver(workspace, await workspace.install(importPackage(pkg, env, { name: "Dashboard copy" }).graph));
    await workspace.settle();

    // The copy still points at the same collection, but holds no grant for it.
    expect(copy.app.store.graph.objects[copy.id("Task source")]?.properties.collectionId).toBe(manager.id("Tasks"));
    expect(copy.output("Task source", "status")).toBe("needs-access");
    expect(copy.output("Task source", "records")).toEqual([]);
    expect(copy.rows("Task table", "rows")).toEqual([]);
    await expectCode(copy.app.clasp.query({ source: manager.id("Tasks") }), "PERMISSION_DENIED");
    expect(workspace.kernel.permissions.list()).toEqual(grantsBefore);
    expect(workspace.requirements(copy.app.id)).toMatchObject([{ capability: "collection.query", satisfied: false, resolved: true }]);
    // The original keeps working.
    expect(dashboard.titles("Task table", "rows")).toEqual(["Private task"]);

    // The copy can earn access the normal way.
    await copy.press("Request access button");
    await answerAccessRequest(workspace, true);
    expect(copy.titles("Task table", "rows")).toEqual(["Private task"]);
  });

  it("does not inherit the original's access — in another workspace", async () => {
    const { dashboard, env } = await connectedPair();
    const file = serializePackage(exportPackage(dashboard.app.store.graph, env));

    // Another workspace, with its own Task Manager holding its own private tasks.
    const other = await openWorkspace({ backend: "memory" });
    const localManager = new AppDriver(other.workspace, await other.workspace.install(buildTaskManager(other.workspace.registry)));
    await localManager.addTask("Local secret");

    const imported = new AppDriver(other.workspace, await other.workspace.install(importPackage(file, other.workspace).graph));
    await other.workspace.settle();

    // The collection it referred to does not exist here; it reads nothing.
    expect(imported.output("Task source", "status")).toBe("unresolved");
    expect(imported.output("Task source", "records")).toEqual([]);
    expect(other.workspace.kernel.permissions.list()).toEqual([]);
    expect(other.workspace.requirements(imported.app.id)).toMatchObject([{ satisfied: false, resolved: false }]);
    await expectCode(imported.app.clasp.query({ source: localManager.id("Tasks") }), "PERMISSION_DENIED");

    // It can discover the local collection — and still needs the user's permission.
    expect(imported.rows("Available sources")).toMatchObject([{ name: "Tasks", ownerName: "Task Manager" }]);
    await imported.interact("Available sources", "select", { id: localManager.id("Tasks") });
    expect(imported.output("Task source", "status")).toBe("needs-access");
    expect(imported.output("Task source", "records")).toEqual([]);
    await imported.press("Request access button");
    await answerAccessRequest(other.workspace, true);
    expect(imported.titles("Task table", "rows")).toEqual(["Local secret"]);
  });

  it("an imported application with its own collection starts with no records", async () => {
    const { manager, env } = await connectedPair();
    const file = serializePackage(exportPackage(manager.app.store.graph, env));
    const other = await openWorkspace({ backend: "memory" });
    const imported = new AppDriver(other.workspace, await other.workspace.install(importPackage(file, other.workspace).graph));
    await other.workspace.settle();
    expect(imported.rows("Task list")).toEqual([]);
    await imported.addTask("Fresh start");
    expect(imported.titles("Task list")).toEqual(["Fresh start"]);
    expect(imported.id("Tasks")).not.toBe(manager.id("Tasks"));
    // The interface was remapped along with everything else.
    const face = imported.app.store.graph.interface;
    expect(face.actions[0]?.target.objectId).toBe(imported.id("Tasks"));
    expect(face.views[0]?.root).toBe(imported.id("Task list"));
  });
});

describe("forking", () => {
  it("creates an independent copy that tracks its origin", async () => {
    const { workspace, manager, env } = await connectedPair();
    const forkResult = forkGraph(manager.app.store.graph, env);
    const fork = new AppDriver(workspace, await workspace.install(forkResult.graph));
    await workspace.settle();

    expect(fork.app.store.graph.metadata.name).toBe("Task Manager (fork)");
    expect(fork.app.store.graph.metadata.origin).toMatchObject({ appId: manager.app.id, name: "Task Manager", version: manager.app.store.graph.version });
    // Independent data and independent definitions.
    expect(fork.rows("Task list")).toEqual([]);
    await fork.addTask("Only in the fork");
    expect(manager.titles("Task list")).toEqual(["Private task"]);
    fork.app.store.transact([{ op: "update", objectId: fork.id("Window"), properties: { title: "Remix" } }]);
    expect(manager.app.store.graph.objects[manager.id("Window")]?.properties.title).toBe("Task Manager");

    // A fork of a fork records its immediate parent, and the package keeps the lineage.
    const second = forkGraph(fork.app.store.graph, env, { name: "Third generation" });
    expect(second.graph.metadata.name).toBe("Third generation");
    expect(second.graph.metadata.origin?.appId).toBe(fork.app.id);
    expect(exportPackage(fork.app.store.graph, env).app.origin?.appId).toBe(manager.app.id);
  });
});
