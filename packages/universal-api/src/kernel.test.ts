import { ClaspError, type ClaspErrorCode } from "@clasp/core";
import { createSchemaRegistry } from "@clasp/schemas";
import { describe, expect, it } from "vitest";
import { ClaspKernel, SYSTEM_PRINCIPAL, flattenRecord, type ClaspAPI, type ClaspEvent, type RecordPersistence, type RecordWrite } from "./index";

const TASKS = "col_tasks";
const SECRETS = "col_secrets";

function setup(persistence?: RecordPersistence) {
  const kernel = new ClaspKernel({ schemas: createSchemaRegistry(), ...(persistence ? { persistence } : {}) });
  kernel.registerPrincipal({ id: "app.manager", name: "Task Manager" });
  kernel.registerPrincipal({ id: "app.dashboard", name: "Task Dashboard" });
  kernel.registerPrincipal({ id: "app.stranger", name: "Stranger" });
  kernel.setResources("app.manager", [
    { id: TASKS, kind: "collection", name: "Tasks", ownerId: "app.manager", exposure: "discoverable", schema: { id: "clasp.task", version: 1 } },
    { id: SECRETS, kind: "collection", name: "Secrets", ownerId: "app.manager", exposure: "private", schema: { id: "clasp.note", version: 1 } },
  ]);
  return {
    kernel,
    manager: kernel.connect("app.manager"),
    dashboard: kernel.connect("app.dashboard"),
    stranger: kernel.connect("app.stranger"),
  };
}

async function expectCode(promise: Promise<unknown> | (() => unknown), code: ClaspErrorCode): Promise<ClaspError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(ClaspError);
    expect((error as ClaspError).code).toBe(code);
    return error as ClaspError;
  }
  throw new Error(`Expected rejection with ${code}`);
}

async function addTask(api: ClaspAPI, title: string, extra: Record<string, unknown> = {}) {
  const result = await api.mutate({ source: TASKS, operation: "create", data: { title, ...extra } as never });
  return result.records[0]!;
}

describe("discover", () => {
  it("lists discoverable resources with ownership and access information", async () => {
    const { manager, dashboard } = setup();
    const own = await manager.discover({ kind: "collection" });
    expect(own.map((resource) => resource.name)).toEqual(["Secrets", "Tasks"]);
    expect(own.every((resource) => resource.owned)).toBe(true);

    const found = await dashboard.discover({ type: "clasp.task", capability: "read" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: TASKS, name: "Tasks", ownerName: "Task Manager", owned: false, access: [] });
    expect(found[0]?.capabilities).toEqual(["collection.query", "collection.mutate"]);
  });

  it("never reveals private resources to other applications", async () => {
    const { dashboard } = setup();
    const all = await dashboard.discover();
    expect(all.map((resource) => resource.id)).not.toContain(SECRETS);
    expect(await dashboard.discover({ schema: "clasp.note" })).toEqual([]);
  });

  it("filters by granted access", async () => {
    const { kernel, dashboard } = setup();
    expect(await dashboard.discover({ capability: "collection.query", access: "granted" })).toEqual([]);
    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    const granted = await dashboard.discover({ capability: "collection.query", access: "granted" });
    expect(granted.map((resource) => resource.id)).toEqual([TASKS]);
    expect(granted[0]?.access).toEqual(["collection.query"]);
  });

  it("matches schemas through extension", async () => {
    const { kernel, dashboard } = setup();
    kernel.schemas.register({ id: "acme.sprintTask", version: 1, title: "Sprint task", extends: "clasp.task", fields: { points: { type: "number" } } });
    kernel.registerPrincipal({ id: "app.sprint", name: "Sprint" });
    kernel.setResources("app.sprint", [
      { id: "col_sprint", kind: "collection", name: "Sprint", ownerId: "app.sprint", exposure: "discoverable", schema: { id: "acme.sprintTask", version: 1 } },
    ]);
    const found = await dashboard.discover({ schema: "clasp.task" });
    expect(found.map((resource) => resource.id).sort()).toEqual(["col_sprint", TASKS]);
  });
});

describe("query and mutate (owner)", () => {
  it("creates, updates, deletes and queries with schema validation", async () => {
    const { manager } = setup();
    const a = await addTask(manager, "Write tests");
    const b = await addTask(manager, "Ship", { priority: "high" });
    expect(a.fields).toEqual({ title: "Write tests", completed: false });
    expect(a.schema).toEqual({ id: "clasp.task", version: 1 });

    await manager.mutate({ source: TASKS, operation: "update", id: a.id, data: { completed: true } });
    const done = await manager.query({ source: TASKS, filter: { completed: true } });
    expect(done.records.map((record) => record.fields.title)).toEqual(["Write tests"]);
    expect(done.records[0]?.version).toBe(2);

    const sorted = await manager.query({ source: TASKS, sort: { field: "title", direction: "asc" }, limit: 1 });
    expect(sorted.total).toBe(2);
    expect(sorted.records.map((record) => record.fields.title)).toEqual(["Ship"]);
    expect((await manager.query({ source: TASKS, filter: { title: { $contains: "ship" } } })).total).toBe(1);
    expect((await manager.query({ source: TASKS, filter: { priority: { $in: ["high", "medium"] } } })).total).toBe(1);
    expect((await manager.query({ source: TASKS, filter: { id: b.id } })).total).toBe(1);

    await manager.mutate({ source: TASKS, operation: "delete", id: b.id });
    expect((await manager.query({ source: TASKS })).total).toBe(1);
  });

  it("rejects invalid data, unknown fields and bad requests with structured errors", async () => {
    const { manager } = setup();
    const error = await expectCode(manager.mutate({ source: TASKS, operation: "create", data: { title: "", flavor: "x" } }), "VALIDATION_FAILED");
    expect(error.issues.map((entry) => entry.code).sort()).toEqual(["INVALID_FIELD", "UNKNOWN_FIELD"]);
    await expectCode(manager.query({ source: TASKS, filter: { nope: 1 } }), "VALIDATION_FAILED");
    await expectCode(manager.query({ source: TASKS, sort: { field: "nope" } }), "VALIDATION_FAILED");
    await expectCode(manager.query({ source: "col_missing" }), "NOT_FOUND");
    await expectCode(manager.mutate({ source: TASKS, operation: "update", id: "rec_missing", data: { completed: true } }), "NOT_FOUND");
    await expectCode(manager.mutate({ source: TASKS, operation: "explode" } as never), "VALIDATION_FAILED");
    await expectCode(manager.query(undefined as never), "VALIDATION_FAILED");
    expect((await manager.query({ source: TASKS })).total).toBe(0);
  });

  it("applies batches atomically", async () => {
    const { manager } = setup();
    const first = await addTask(manager, "Existing");
    await expectCode(
      manager.mutate({
        source: TASKS,
        operation: "batch",
        operations: [
          { operation: "create", data: { title: "New" } },
          { operation: "update", id: first.id, data: { completed: true } },
          { operation: "delete", id: "rec_missing" },
        ],
      }),
      "NOT_FOUND",
    );
    const after = await manager.query({ source: TASKS });
    expect(after.records.map((record) => record.fields)).toEqual([{ title: "Existing", completed: false }]);

    const ok = await manager.mutate({
      source: TASKS,
      operation: "batch",
      operations: [
        { operation: "create", data: { title: "New" } },
        { operation: "update", id: first.id, data: { completed: true } },
      ],
    });
    expect(ok.changes.map((change) => change.type)).toEqual(["created", "updated"]);
  });

  it("detects conflicting writes through expected versions", async () => {
    const { manager } = setup();
    const task = await addTask(manager, "Contended");
    await manager.mutate({ source: TASKS, operation: "update", id: task.id, data: { notes: "first" }, expectedVersion: 1 });
    await expectCode(
      manager.mutate({ source: TASKS, operation: "update", id: task.id, data: { notes: "second" }, expectedVersion: 1 }),
      "CONFLICT",
    );
  });

  it("returns copies: callers cannot corrupt the store by mutating results", async () => {
    const { manager } = setup();
    await addTask(manager, "Immutable");
    const result = await manager.query({ source: TASKS });
    result.records[0]!.fields.title = "tampered";
    expect((await manager.query({ source: TASKS })).records[0]?.fields.title).toBe("Immutable");
  });

  it("does not apply a change that cannot be persisted", async () => {
    const stored: RecordWrite[] = [];
    let fail = false;
    const { manager } = setup({
      loadRecords: async () => [],
      commitRecords: async (writes) => {
        if (fail) throw new Error("disk full");
        stored.push(...writes);
      },
    });
    await addTask(manager, "Saved");
    fail = true;
    await expectCode(addTask(manager, "Lost"), "STORAGE_FAILURE");
    fail = false;
    expect((await manager.query({ source: TASKS })).records.map((record) => record.fields.title)).toEqual(["Saved"]);
    expect(stored).toHaveLength(1);
  });
});

describe("cross-application access", () => {
  it("denies queries, mutations and subscriptions without a grant", async () => {
    const { manager, dashboard, stranger } = setup();
    await addTask(manager, "Private until granted");
    for (const api of [dashboard, stranger]) {
      await expectCode(api.query({ source: TASKS }), "PERMISSION_DENIED");
      await expectCode(api.mutate({ source: TASKS, operation: "create", data: { title: "Intruder" } }), "PERMISSION_DENIED");
      await expectCode(() => api.subscribe({ source: TASKS, handler: () => undefined }), "PERMISSION_DENIED");
      await expectCode(api.query({ source: SECRETS }), "PERMISSION_DENIED");
      await expectCode(api.requestAccess({ resource: SECRETS, capabilities: ["collection.query"] }), "PERMISSION_DENIED");
    }
    expect((await manager.query({ source: TASKS })).total).toBe(1);
  });

  it("allows exactly what was granted", async () => {
    const { kernel, manager, dashboard, stranger } = setup();
    const task = await addTask(manager, "Shared");
    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });

    const read = await dashboard.query({ source: TASKS, filter: { completed: false } });
    expect(read.records.map(flattenRecord)).toEqual([{ id: task.id, title: "Shared", completed: false }]);
    // Read access does not imply write access, nor access for anyone else.
    await expectCode(dashboard.mutate({ source: TASKS, operation: "update", id: task.id, data: { completed: true } }), "PERMISSION_DENIED");
    await expectCode(stranger.query({ source: TASKS }), "PERMISSION_DENIED");
    await expectCode(dashboard.query({ source: SECRETS }), "PERMISSION_DENIED");

    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.mutate" });
    await dashboard.mutate({ source: TASKS, operation: "update", id: task.id, data: { completed: true } });
    expect((await manager.query({ source: TASKS })).records[0]?.fields.completed).toBe(true);
    // Cross-application writes are validated like any other.
    await expectCode(dashboard.mutate({ source: TASKS, operation: "create", data: { title: 42 as never } }), "VALIDATION_FAILED");
  });

  it("request → user approval → access", async () => {
    const { kernel, dashboard } = setup();
    const decision = dashboard.requestAccess({ resource: TASKS, capabilities: ["collection.query"], reason: "Show your tasks" });
    await Promise.resolve();
    const [request] = kernel.permissions.pendingRequests();
    expect(request).toMatchObject({ subject: "app.dashboard", resource: TASKS, reason: "Show your tasks" });
    await expectCode(dashboard.query({ source: TASKS }), "PERMISSION_DENIED");
    kernel.permissions.resolveRequest(request!.id, true);
    await expect(decision).resolves.toMatchObject({ granted: true });
    expect((await dashboard.query({ source: TASKS })).total).toBe(0);
    await expectCode(dashboard.requestAccess({ resource: TASKS, capabilities: ["capability.invoke"] }), "VALIDATION_FAILED");
  });

  it("reads records as another schema through an explicit mapping", async () => {
    const { kernel, manager } = setup();
    kernel.schemas.register({ id: "acme.card", version: 1, title: "Card", fields: { heading: { type: "string", required: true }, archived: { type: "boolean" } } });
    await addTask(manager, "Map me");
    await expectCode(manager.query({ source: TASKS, as: "acme.card" }), "INCOMPATIBLE");
    kernel.schemas.registerMapping({ from: "clasp.task", to: "acme.card", fields: { heading: "title", archived: "completed" } });
    const mapped = await manager.query({ source: TASKS, as: "acme.card", filter: { archived: false } });
    expect(mapped.schema).toEqual({ id: "acme.card", version: 1 });
    expect(mapped.records[0]?.fields).toEqual({ heading: "Map me", archived: false });
    await expectCode(manager.query({ source: TASKS, as: "acme.card", filter: { title: "Map me" } }), "VALIDATION_FAILED");
  });
});

describe("subscribe", () => {
  it("delivers changes to authorized subscribers and supports event filters", async () => {
    const { kernel, manager, dashboard } = setup();
    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    const all: ClaspEvent[] = [];
    const deletions: ClaspEvent[] = [];
    dashboard.subscribe({ source: TASKS, event: "changed", handler: (event) => all.push(event) });
    dashboard.subscribe({ source: TASKS, event: "deleted", handler: (event) => deletions.push(event) });

    const task = await addTask(manager, "Watch me");
    await manager.mutate({ source: TASKS, operation: "update", id: task.id, data: { completed: true } });
    await manager.mutate({ source: TASKS, operation: "delete", id: task.id });

    expect(all.map((event) => event.changes?.[0]?.type)).toEqual(["created", "updated", "deleted"]);
    expect(all[1]?.changes?.[0]?.previous?.fields.completed).toBe(false);
    expect(deletions).toHaveLength(1);
    await expectCode(() => dashboard.subscribe({ source: TASKS, event: "exploded", handler: () => undefined }), "NOT_FOUND");
  });

  it("stops delivering after unsubscribe and after dispose", async () => {
    const { kernel, manager } = setup();
    let count = 0;
    const subscription = manager.subscribe({ source: TASKS, handler: () => count++ });
    manager.subscribe({ source: TASKS, handler: () => count++ });
    await addTask(manager, "one");
    expect(count).toBe(2);
    subscription.unsubscribe();
    expect(subscription.active).toBe(false);
    await addTask(manager, "two");
    expect(count).toBe(3);
    manager.dispose();
    await addTask(kernel.connect("app.manager"), "three");
    expect(count).toBe(3);
    expect(kernel.subscriptionCount()).toBe(0);
  });

  it("terminates subscriptions the moment permission is revoked", async () => {
    const { kernel, manager, dashboard } = setup();
    const grant = kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    const received: ClaspEvent[] = [];
    const errors: ClaspError[] = [];
    const subscription = dashboard.subscribe({ source: TASKS, handler: (event) => received.push(event), onError: (error) => errors.push(error) });
    await addTask(manager, "before");
    expect(received).toHaveLength(1);

    kernel.permissions.revoke(grant.id);
    expect(subscription.active).toBe(false);
    expect(errors.map((error) => error.code)).toEqual(["PERMISSION_DENIED"]);
    await addTask(manager, "after");
    expect(received).toHaveLength(1);
    await expectCode(dashboard.query({ source: TASKS }), "PERMISSION_DENIED");
  });

  it("tells a subscriber when its own access changes, without leaking data", async () => {
    const { kernel, manager, dashboard } = setup();
    const events: ClaspEvent[] = [];
    dashboard.subscribe({ source: TASKS, event: "access", handler: (event) => events.push(event) });
    await addTask(manager, "invisible");
    expect(events).toHaveLength(0);
    const grant = kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    kernel.permissions.revoke(grant.id);
    expect(events.map((event) => event.payload)).toEqual([{ granted: ["collection.query"] }, { granted: [] }]);
    await expectCode(() => dashboard.subscribe({ source: SECRETS, event: "access", handler: () => undefined }), "PERMISSION_DENIED");
  });

  it("isolates subscribers from each other's failures", async () => {
    const { kernel, manager } = setup();
    const reports: string[] = [];
    kernel.onError((report) => reports.push(report.error.message));
    let delivered = 0;
    manager.subscribe({
      source: TASKS,
      handler: () => {
        throw new Error("subscriber bug");
      },
    });
    manager.subscribe({ source: TASKS, handler: () => delivered++ });
    await addTask(manager, "resilient");
    expect(delivered).toBe(1);
    expect(reports).toEqual(["subscriber bug"]);
  });
});

describe("invoke and object resources", () => {
  function withService() {
    const context = setup();
    const sent: unknown[] = [];
    let volume = 5;
    context.kernel.setResources(SYSTEM_PRINCIPAL, [
      {
        id: "svc_notify",
        kind: "service",
        name: "Notifications",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        actions: [{ name: "send" }, { name: "clear" }],
        events: [{ name: "sent" }],
        outputs: [{ name: "count" }],
        inputs: [{ name: "volume" }],
      },
    ]);
    context.kernel.bindProvider("svc_notify", {
      values: () => ({ count: sent.length, volume }),
      setValues: (patch) => {
        volume = patch.volume as number;
      },
      invoke: (action, args) => {
        if (action === "send") {
          sent.push(args);
          context.kernel.publish("svc_notify", "sent", args);
          return { delivered: true };
        }
        throw new Error("boom");
      },
    });
    return { ...context, sent, volume: () => volume };
  }

  it("discovers capabilities and invokes only what was granted", async () => {
    const { kernel, dashboard, sent } = withService();
    const [service] = await dashboard.discover({ kind: "service", capability: "invoke" });
    expect(service?.actions.map((action) => action.name)).toEqual(["send", "clear"]);

    await expectCode(dashboard.invoke({ target: "svc_notify", action: "send", arguments: { message: "hi" } }), "PERMISSION_DENIED");
    kernel.permissions.grant({ subject: "app.dashboard", resource: "svc_notify", capability: "capability.invoke", actions: ["send"] });
    await expect(dashboard.invoke({ target: "svc_notify", action: "send", arguments: { message: "hi" } })).resolves.toEqual({ delivered: true });
    expect(sent).toEqual([{ message: "hi" }]);
    await expectCode(dashboard.invoke({ target: "svc_notify", action: "clear" }), "PERMISSION_DENIED");
    await expectCode(dashboard.invoke({ target: "svc_notify", action: "nope" }), "NOT_FOUND");
    await expectCode(dashboard.invoke({ target: TASKS, action: "send" }), "INVALID_OPERATION");
  });

  it("wraps provider failures and reports unavailable providers", async () => {
    const { kernel, dashboard } = withService();
    kernel.permissions.grant({ subject: "app.dashboard", resource: "svc_notify", capability: "capability.invoke" });
    const error = await expectCode(dashboard.invoke({ target: "svc_notify", action: "clear" }), "INTERNAL");
    expect(error.message).toBe("boom");
    kernel.setResources(SYSTEM_PRINCIPAL, [
      { id: "svc_idle", kind: "service", name: "Idle", ownerId: SYSTEM_PRINCIPAL, exposure: "discoverable", actions: [{ name: "go" }] },
    ]);
    kernel.permissions.grant({ subject: "app.dashboard", resource: "svc_idle", capability: "capability.invoke" });
    await expectCode(dashboard.invoke({ target: "svc_idle", action: "go" }), "UNAVAILABLE");
  });

  it("reads values, sets inputs and receives events under object capabilities", async () => {
    const { kernel, dashboard, volume } = withService();
    await expectCode(dashboard.query({ source: "svc_notify" }), "PERMISSION_DENIED");
    await expectCode(() => dashboard.subscribe({ source: "svc_notify", event: "sent", handler: () => undefined }), "PERMISSION_DENIED");
    kernel.permissions.grant({ subject: "app.dashboard", resource: "svc_notify", capability: "object.read" });
    expect((await dashboard.query({ source: "svc_notify" })).values).toEqual({ count: 0, volume: 5 });

    const payloads: unknown[] = [];
    dashboard.subscribe({ source: "svc_notify", event: "sent", handler: (event) => payloads.push(event.payload) });
    kernel.publish("svc_notify", "sent", { message: "x" });
    expect(payloads).toEqual([{ message: "x" }]);

    await expectCode(dashboard.mutate({ source: "svc_notify", operation: "set", data: { volume: 9 } }), "PERMISSION_DENIED");
    kernel.permissions.grant({ subject: "app.dashboard", resource: "svc_notify", capability: "object.write" });
    await dashboard.mutate({ source: "svc_notify", operation: "set", data: { volume: 9 } });
    expect(volume()).toBe(9);
    await expectCode(dashboard.mutate({ source: "svc_notify", operation: "set", data: { secret: 1 } }), "VALIDATION_FAILED");
    await expectCode(dashboard.mutate({ source: "svc_notify", operation: "create", data: {} }), "VALIDATION_FAILED");
  });
});

describe("resource lifecycle", () => {
  it("removing a resource ends its grants and subscriptions but keeps its records", async () => {
    const { kernel, manager, dashboard } = setup();
    await addTask(manager, "survivor");
    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    const errors: ClaspError[] = [];
    dashboard.subscribe({ source: TASKS, handler: () => undefined, onError: (error) => errors.push(error) });

    kernel.setResources("app.manager", []);
    expect(errors.map((error) => error.code)).toEqual(["NOT_FOUND"]);
    expect(kernel.permissions.list()).toHaveLength(0);
    await expectCode(manager.query({ source: TASKS }), "NOT_FOUND");
    expect(kernel.data.count(TASKS)).toBe(1);

    // Re-declaring the same collection id brings the records back — but not the grants.
    kernel.setResources("app.manager", [
      { id: TASKS, kind: "collection", name: "Tasks", ownerId: "app.manager", exposure: "discoverable", schema: { id: "clasp.task", version: 1 } },
    ]);
    expect((await manager.query({ source: TASKS })).total).toBe(1);
    await expectCode(dashboard.query({ source: TASKS }), "PERMISSION_DENIED");
  });

  it("refuses to let one principal take over another's resource id", async () => {
    const { kernel, stranger } = setup();
    const reports: string[] = [];
    kernel.onError((report) => reports.push(report.error.code));
    kernel.setResources("app.stranger", [
      { id: TASKS, kind: "collection", name: "Hijack", ownerId: "app.stranger", schema: { id: "clasp.task", version: 1 } },
    ]);
    expect(reports).toEqual(["CONFLICT"]);
    await expectCode(stranger.query({ source: TASKS }), "PERMISSION_DENIED");
  });

  it("removing a principal revokes what it was granted and cancels its requests", async () => {
    const { kernel, dashboard } = setup();
    kernel.permissions.grant({ subject: "app.dashboard", resource: TASKS, capability: "collection.query" });
    const pending = kernel.connect("app.stranger").requestAccess({ resource: TASKS, capabilities: ["collection.query"] });
    await Promise.resolve();
    kernel.removePrincipal("app.stranger");
    await expect(pending).resolves.toMatchObject({ granted: false });
    kernel.removePrincipal("app.dashboard");
    expect(kernel.permissions.list()).toHaveLength(0);
    await expectCode(dashboard.query({ source: TASKS }), "PERMISSION_DENIED");
    expect(() => kernel.connect("app.dashboard")).toThrowError(ClaspError);
  });
});
