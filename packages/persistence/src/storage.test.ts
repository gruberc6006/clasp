import "fake-indexeddb/auto";
import { ClaspError, GraphStore, createGraph, createId } from "@clasp/core";
import { describe, expect, it } from "vitest";
import { IndexedDbStorage, MemoryStorage, WorkspaceStorage, type StorageAdapter } from "./index";

const backends: Array<{ name: string; open: () => Promise<StorageAdapter>; reopen?: (adapter: StorageAdapter) => Promise<StorageAdapter> }> = [
  { name: "memory", open: async () => new MemoryStorage() },
  {
    name: "indexeddb",
    open: () => IndexedDbStorage.open(createId("test")),
    reopen: async (adapter) => {
      const name = (adapter as IndexedDbStorage).name.replace(/^clasp:/, "");
      adapter.close();
      return IndexedDbStorage.open(name);
    },
  },
];

function graphWith(names: string[]) {
  const store = new GraphStore(createGraph({ name: "App" }));
  for (const name of names) store.transact([{ op: "create", object: { type: "thing", name } }]);
  return store;
}

describe.each(backends)("$name storage", ({ open, reopen }) => {
  it("stores and lists values by key prefix", async () => {
    const adapter = await open();
    await adapter.commit([
      { store: "meta", key: "b/2", value: { n: 2 } },
      { store: "meta", key: "a/1", value: { n: 1 } },
      { store: "meta", key: "b/1", value: { n: 3 } },
    ]);
    expect(await adapter.get("meta", "a/1")).toEqual({ n: 1 });
    expect(await adapter.get("meta", "missing")).toBeUndefined();
    expect((await adapter.list("meta", "b/")).map((entry) => entry.key)).toEqual(["b/1", "b/2"]);
    expect(await adapter.list("meta")).toHaveLength(3);
    await adapter.commit([{ store: "meta", key: "a/1", delete: true }]);
    expect(await adapter.get("meta", "a/1")).toBeUndefined();
    adapter.close();
  });

  it("saves and loads graphs with revision history", async () => {
    const storage = new WorkspaceStorage(await open(), { revisionLimit: 3 });
    const store = graphWith(["one"]);
    await storage.saveGraph(store.graph, { label: "first" });
    for (const name of ["two", "three", "four", "five"]) {
      store.transact([{ op: "create", object: { type: "thing", name } }]);
      await storage.saveGraph(store.graph, { label: name });
    }
    const loaded = await storage.loadGraph(store.graph.id);
    expect(loaded).toEqual(store.graph);
    expect(await storage.loadGraphs()).toHaveLength(1);

    const revisions = await storage.listRevisions(store.graph.id);
    expect(revisions.map((revision) => revision.label)).toEqual(["five", "four", "three"]);
    expect(revisions[0]?.objectCount).toBe(5);
    const older = await storage.loadRevision(store.graph.id, revisions[2]!.version);
    expect(Object.keys(older.objects)).toHaveLength(3);
    await expect(storage.loadRevision(store.graph.id, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps records when a definition is replaced or deleted", async () => {
    const storage = new WorkspaceStorage(await open());
    const store = graphWith(["collection"]);
    await storage.saveGraph(store.graph);
    await storage.commitRecords([
      { type: "put", record: { id: "r1", collectionId: "c1", fields: { title: "keep me" } } as never },
      { type: "put", record: { id: "r2", collectionId: "c2", fields: { title: "other" } } as never },
    ]);

    store.transact([{ op: "delete", objectId: Object.keys(store.graph.objects)[0] as string }]);
    await storage.saveGraph(store.graph);
    expect(await storage.loadRecords()).toHaveLength(2);

    await storage.deleteGraph(store.graph.id);
    expect(await storage.loadGraphs()).toHaveLength(0);
    expect(await storage.listRevisions(store.graph.id)).toHaveLength(0);
    expect(await storage.loadRecords()).toHaveLength(2);

    await storage.saveGraph(store.graph);
    await storage.deleteGraph(store.graph.id, { purgeCollections: ["c1"] });
    expect((await storage.loadRecords()).map((record) => record.id)).toEqual(["r2"]);
  });

  it("replaces grants atomically and stores presentation and schemas separately", async () => {
    const storage = new WorkspaceStorage(await open());
    await storage.saveGrants([{ id: "g1" }, { id: "g2" }]);
    await storage.saveGrants([{ id: "g2" }, { id: "g3" }]);
    expect((await storage.loadGrants()).map((grant) => grant.id)).toEqual(["g2", "g3"]);

    await storage.savePresentation({ graphId: "app1", nodes: { a: { x: 1, y: 2 } } });
    expect(await storage.loadPresentation("app1")).toEqual({ graphId: "app1", nodes: { a: { x: 1, y: 2 } } });
    expect(await storage.loadGraphs()).toHaveLength(0);

    await storage.saveSchema({ id: "acme.x", version: 2 });
    expect(await storage.loadSchemas()).toEqual([{ id: "acme.x", version: 2 }]);
    await storage.setMeta("name", "Personal");
    expect(await storage.getMeta("name")).toBe("Personal");
  });

  it("exports and imports a whole workspace", async () => {
    const source = new WorkspaceStorage(await open());
    const store = graphWith(["a", "b"]);
    await source.saveGraph(store.graph);
    await source.commitRecords([{ type: "put", record: { id: "r1", collectionId: "c1" } }]);
    await source.saveGrants([{ id: "g1" }]);
    const dump = await source.exportAll();
    expect(dump.format).toBe("clasp.workspace");

    const target = new WorkspaceStorage(await open());
    await target.setMeta("stale", true);
    await target.importAll(JSON.parse(JSON.stringify(dump)));
    expect(await target.loadGraph(store.graph.id)).toEqual(store.graph);
    expect(await target.loadRecords()).toHaveLength(1);
    expect(await target.loadGrants()).toHaveLength(1);
    expect(await target.getMeta("stale")).toBeUndefined();
    await expect(target.importAll({ format: "nope" } as never)).rejects.toBeInstanceOf(ClaspError);
  });

  if (reopen) {
    it("persists across closing and reopening the database", async () => {
      const adapter = await open();
      const storage = new WorkspaceStorage(adapter);
      const store = graphWith(["durable"]);
      await storage.saveGraph(store.graph);
      await storage.commitRecords([{ type: "put", record: { id: "r1", collectionId: "c1" } }]);
      const reopened = new WorkspaceStorage(await reopen(adapter));
      expect(await reopened.loadGraph(store.graph.id)).toEqual(store.graph);
      expect(await reopened.loadRecords()).toEqual([{ id: "r1", collectionId: "c1" }]);
    });
  }
});

describe("transactional updates", () => {
  it("memory: a failed commit writes nothing", async () => {
    const adapter = new MemoryStorage();
    await adapter.commit([{ store: "meta", key: "kept", value: 1 }]);
    adapter.failNextCommit = new Error("disk full");
    await expect(
      adapter.commit([
        { store: "meta", key: "kept", value: 2 },
        { store: "meta", key: "new", value: 3 },
      ]),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(await adapter.get("meta", "kept")).toBe(1);
    expect(await adapter.get("meta", "new")).toBeUndefined();
  });

  it("indexeddb: a commit with an unstorable value writes nothing at all", async () => {
    const adapter = await IndexedDbStorage.open(createId("test"));
    await adapter.commit([{ store: "meta", key: "kept", value: 1 }]);
    await expect(
      adapter.commit([
        { store: "meta", key: "kept", value: 2 },
        { store: "records", key: "new", value: { ok: true } },
        { store: "meta", key: "broken", value: () => "functions cannot be cloned" },
      ]),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(await adapter.get("meta", "kept")).toBe(1);
    expect(await adapter.get("records", "new")).toBeUndefined();
    adapter.close();
  });
});
