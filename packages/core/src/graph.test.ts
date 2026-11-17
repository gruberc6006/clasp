import { describe, expect, it } from "vitest";
import {
  ClaspError,
  GraphBuilder,
  GraphStore,
  applyOperations,
  childrenOf,
  createGraph,
  dependenciesOf,
  dependentsOf,
  executionOrder,
  findObjects,
  issue,
  parseGraph,
  serializeGraph,
  validateGraph,
  type ClaspGraph,
  type GraphEvent,
  type ObjectTypeInfo,
  type TypeCatalog,
} from "./index";

/** A minimal catalog standing in for the real component registry. */
const types: Record<string, ObjectTypeInfo> = {
  box: { type: "box", version: 1, inputs: [], outputs: [], events: [], actions: [], container: true },
  source: {
    type: "source",
    version: 1,
    inputs: [],
    outputs: [{ name: "value", type: "number" }, { name: "label", type: "string" }],
    events: [{ name: "fired" }],
    actions: [],
    container: false,
  },
  sink: {
    type: "sink",
    version: 2,
    inputs: [{ name: "in", type: "number" }, { name: "other", type: "number" }],
    outputs: [{ name: "out", type: "number" }],
    events: [],
    actions: [{ name: "run" }],
    container: false,
    validateProperties: (properties) =>
      "bad" in properties ? [issue("UNKNOWN_PROPERTY", `Unknown property "bad".`)] : [],
  },
};
const catalog: TypeCatalog = { describe: (object) => types[object.type] };

function sample(): ClaspGraph {
  const builder = new GraphBuilder("Sample", { id: "app_sample" });
  builder.add("box", { id: "box", name: "Box" });
  builder.add("source", { id: "src", name: "Source", parent: "box" });
  builder.add("sink", { id: "sink", name: "Sink", parent: "box" });
  builder.connect("src.value", "sink.in");
  builder.connect("src.fired", "sink.run");
  return builder.build(catalog);
}

function expectRejected(run: () => unknown, issueCode: string): ClaspError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaspError);
    const claspError = error as ClaspError;
    expect(claspError.code).toBe("VALIDATION_FAILED");
    expect(claspError.issues.map((entry) => entry.code)).toContain(issueCode);
    return claspError;
  }
  throw new Error(`Expected a rejection with issue ${issueCode}`);
}

describe("object creation", () => {
  it("creates objects with unique ids, versions, defaults and metadata", () => {
    const graph = createGraph({ name: "Empty" });
    const { graph: next } = applyOperations(
      graph,
      [
        { op: "create", object: { type: "source", name: "A" } },
        { op: "create", object: { type: "source", name: "B" } },
      ],
      { catalog },
    );
    const [a, b] = findObjects(next, { type: "source" });
    expect(a?.id).toMatch(/^obj_[0-9a-f]{32}$/);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.version).toBe(1);
    expect(a?.typeVersion).toBe(1);
    expect(a?.order).toBe(0);
    expect(b?.order).toBe(1);
    expect(a?.metadata.createdAt).toBeTruthy();
    expect(next.version).toBe(1);
    // The input graph was not modified.
    expect(Object.keys(graph.objects)).toHaveLength(0);
  });

  it("stamps the registered type version", () => {
    const graph = applyOperations(createGraph({ name: "g" }), [{ op: "create", object: { id: "s", type: "sink" } }], {
      catalog,
    }).graph;
    expect(graph.objects.s?.typeVersion).toBe(2);
  });

  it("rejects duplicate ids, unknown types and invalid properties", () => {
    const graph = sample();
    expectRejected(() => applyOperations(graph, [{ op: "create", object: { id: "src", type: "source" } }], { catalog }), "DUPLICATE_ID");
    expectRejected(() => applyOperations(graph, [{ op: "create", object: { type: "nope" } }], { catalog }), "UNKNOWN_TYPE");
    expectRejected(
      () => applyOperations(graph, [{ op: "create", object: { type: "sink", properties: { bad: true } } }], { catalog }),
      "UNKNOWN_PROPERTY",
    );
  });

  it("supports nesting and rejects children of non-containers", () => {
    const graph = sample();
    expect(childrenOf(graph, "box").map((object) => object.id)).toEqual(["src", "sink"]);
    expectRejected(
      () => applyOperations(graph, [{ op: "create", object: { type: "source", parentId: "src" } }], { catalog }),
      "NOT_A_CONTAINER",
    );
    expectRejected(
      () => applyOperations(graph, [{ op: "create", object: { type: "source", parentId: "ghost" } }], { catalog }),
      "MISSING_PARENT",
    );
  });
});

describe("object updates", () => {
  it("merges properties, bumps the object version and can re-parent", () => {
    const graph = sample();
    const { graph: next } = applyOperations(
      graph,
      [
        { op: "update", objectId: "sink", properties: { limit: 3 }, name: "Renamed" },
        { op: "update", objectId: "sink", properties: { extra: "x" }, unset: ["limit"], parentId: null },
      ],
      { catalog },
    );
    expect(next.objects.sink?.properties).toEqual({ extra: "x" });
    expect(next.objects.sink?.metadata.name).toBe("Renamed");
    expect(next.objects.sink?.version).toBe(3);
    expect(next.objects.sink?.parentId).toBeUndefined();
    expect(graph.objects.sink?.parentId).toBe("box");
  });

  it("rejects containment cycles", () => {
    const base = applyOperations(sample(), [{ op: "create", object: { id: "inner", type: "box", parentId: "box" } }], {
      catalog,
    }).graph;
    expectRejected(
      () => applyOperations(base, [{ op: "update", objectId: "box", parentId: "inner" }], { catalog }),
      "CONTAINMENT_CYCLE",
    );
  });
});

describe("object deletion", () => {
  it("cascades to descendants, their connections and interface entries", () => {
    const withInterface = applyOperations(
      sample(),
      [
        {
          op: "setInterface",
          interface: {
            actions: [{ name: "run", target: { objectId: "sink", port: "run" } }],
            events: [],
            outputs: [],
            inputs: [],
            views: [{ name: "main", root: "box" }],
          },
        },
      ],
      { catalog },
    ).graph;
    const { graph: next, changes } = applyOperations(withInterface, [{ op: "delete", objectId: "box" }], { catalog });
    expect(Object.keys(next.objects)).toHaveLength(0);
    expect(Object.keys(next.connections)).toHaveLength(0);
    expect(next.interface.actions).toHaveLength(0);
    expect(next.interface.views).toHaveLength(0);
    expect(changes.filter((change) => change.kind === "object-deleted")).toHaveLength(3);
    expect(changes.filter((change) => change.kind === "connection-deleted")).toHaveLength(2);
  });

  it("rejects deleting a missing object", () => {
    expectRejected(() => applyOperations(sample(), [{ op: "delete", objectId: "ghost" }], { catalog }), "MISSING_OBJECT");
  });
});

describe("connection validation", () => {
  it("classifies value and event connections", () => {
    const graph = sample();
    const kinds = Object.values(graph.connections).map((connection) => connection.kind).sort();
    expect(kinds).toEqual(["event", "value"]);
  });

  it("rejects unknown ports, type mismatches and kind mismatches", () => {
    const graph = sample();
    const connect = (source: string, target: string) => () =>
      applyOperations(
        graph,
        [
          {
            op: "connect",
            connection: {
              source: { objectId: source.split(".")[0] as string, port: source.split(".")[1] as string },
              target: { objectId: target.split(".")[0] as string, port: target.split(".")[1] as string },
            },
          },
        ],
        { catalog },
      );
    expectRejected(connect("src.nope", "sink.other"), "UNKNOWN_PORT");
    expectRejected(connect("src.label", "sink.other"), "TYPE_MISMATCH");
    expectRejected(connect("src.value", "sink.run"), "KIND_MISMATCH");
    expectRejected(connect("src.fired", "sink.other"), "KIND_MISMATCH");
    expectRejected(connect("ghost.value", "sink.other"), "MISSING_OBJECT");
  });

  it("allows one writer per value input but many triggers per action", () => {
    const base = applyOperations(sample(), [{ op: "create", object: { id: "src2", type: "source" } }], { catalog }).graph;
    expectRejected(
      () =>
        applyOperations(
          base,
          [{ op: "connect", connection: { source: { objectId: "src2", port: "value" }, target: { objectId: "sink", port: "in" } } }],
          { catalog },
        ),
      "INPUT_ALREADY_CONNECTED",
    );
    const ok = applyOperations(
      base,
      [{ op: "connect", connection: { source: { objectId: "src2", port: "fired" }, target: { objectId: "sink", port: "run" } } }],
      { catalog },
    ).graph;
    expect(Object.keys(ok.connections)).toHaveLength(3);
  });

  it("rejects value-dependency cycles and names only the cycle members", () => {
    const builder = new GraphBuilder("Cycle");
    builder.add("sink", { id: "a", name: "A" });
    builder.add("sink", { id: "b", name: "B" });
    builder.add("sink", { id: "c", name: "Downstream" });
    builder.connect("a.out", "b.in");
    builder.connect("b.out", "a.in");
    builder.connect("b.out", "c.in");
    const error = expectRejected(() => builder.build(catalog), "DEPENDENCY_CYCLE");
    const message = error.issues.find((entry) => entry.code === "DEPENDENCY_CYCLE")?.message ?? "";
    expect(message).toContain("A");
    expect(message).toContain("B");
    expect(message).not.toContain("Downstream");
  });
});

describe("graph validation", () => {
  it("accepts a valid graph", () => {
    expect(validateGraph(sample(), catalog)).toEqual([]);
  });

  it("detects dangling references in a hand-edited graph", () => {
    const graph = sample();
    const broken: ClaspGraph = {
      ...graph,
      objects: { ...graph.objects, sink: { ...graph.objects.sink!, parentId: "ghost" } },
      connections: {
        ...graph.connections,
        dangling: { id: "dangling", kind: "value", source: { objectId: "ghost", port: "value" }, target: { objectId: "sink", port: "other" } },
      },
    };
    const codes = validateGraph(broken, catalog).map((entry) => entry.code);
    expect(codes).toContain("MISSING_PARENT");
    expect(codes).toContain("MISSING_OBJECT");
  });

  it("validates the public interface", () => {
    expectRejected(
      () =>
        applyOperations(
          sample(),
          [
            {
              op: "setInterface",
              interface: {
                actions: [{ name: "run", target: { objectId: "sink", port: "nope" } }],
                events: [],
                outputs: [],
                inputs: [],
                views: [],
              },
            },
          ],
          { catalog },
        ),
      "INVALID_INTERFACE",
    );
  });
});

describe("serialization", () => {
  it("round-trips a graph losslessly and deterministically", () => {
    const graph = sample();
    const text = serializeGraph(graph);
    const parsed = parseGraph(text);
    expect(parsed).toEqual(graph);
    expect(serializeGraph(parsed)).toBe(text);
    expect(validateGraph(parsed, catalog)).toEqual([]);
  });

  it("rejects malformed and too-new input with structured errors", () => {
    expect(() => parseGraph("{not json")).toThrowError(ClaspError);
    expectRejected(() => parseGraph({ id: "x" }), "MALFORMED_GRAPH");
    try {
      parseGraph({ ...sample(), formatVersion: 99 });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as ClaspError).code).toBe("INCOMPATIBLE");
    }
  });
});

describe("transactions", () => {
  it("rolls back every operation when one fails", () => {
    const store = new GraphStore(sample(), { catalog });
    const before = store.graph;
    expectRejected(
      () =>
        store.transact([
          { op: "create", object: { id: "fresh", type: "source" } },
          { op: "update", objectId: "sink", properties: { ok: 1 } },
          { op: "delete", objectId: "ghost" },
        ]),
      "MISSING_OBJECT",
    );
    expect(store.graph).toBe(before);
    expect(store.graph.objects.fresh).toBeUndefined();
    expect(store.graph.objects.sink?.properties).toEqual({});
    expect(store.canUndo).toBe(false);
  });

  it("rolls back when the resulting graph is invalid as a whole", () => {
    const store = new GraphStore(sample(), { catalog });
    const before = store.graph;
    expectRejected(
      () =>
        store.transact([
          { op: "create", object: { id: "fresh", type: "source" } },
          { op: "connect", connection: { source: { objectId: "fresh", port: "value" }, target: { objectId: "sink", port: "in" } } },
        ]),
      "INPUT_ALREADY_CONNECTED",
    );
    expect(store.graph).toBe(before);
  });

  it("supports dry runs that never commit", () => {
    const store = new GraphStore(sample(), { catalog });
    const result = store.dryRun([{ op: "delete", objectId: "src" }]);
    expect(result.graph.objects.src).toBeUndefined();
    expect(store.graph.objects.src).toBeDefined();
  });
});

describe("undo and redo", () => {
  it("walks backwards and forwards through committed transactions", () => {
    const store = new GraphStore(sample(), { catalog });
    store.transact([{ op: "update", objectId: "sink", properties: { step: 1 } }], { label: "one" });
    store.transact([{ op: "delete", objectId: "src" }], { label: "two" });
    expect(store.graph.objects.src).toBeUndefined();
    expect(store.undoLabel).toBe("two");

    expect(store.undo()).toBe(true);
    expect(store.graph.objects.src).toBeDefined();
    expect(Object.keys(store.graph.connections)).toHaveLength(2);
    expect(store.graph.objects.sink?.properties).toEqual({ step: 1 });

    expect(store.undo()).toBe(true);
    expect(store.graph.objects.sink?.properties).toEqual({});
    expect(store.undo()).toBe(false);

    expect(store.redo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.graph.objects.src).toBeUndefined();
    expect(store.redo()).toBe(false);
  });

  it("keeps revisions monotonic and clears redo after a new edit", () => {
    const store = new GraphStore(sample(), { catalog });
    const start = store.graph.version;
    store.transact([{ op: "update", objectId: "sink", properties: { a: 1 } }]);
    store.undo();
    expect(store.graph.version).toBe(start + 2);
    store.transact([{ op: "update", objectId: "sink", properties: { b: 2 } }]);
    expect(store.canRedo).toBe(false);
  });
});

describe("event propagation", () => {
  it("notifies subscribers with precise changes and stops after unsubscribe", () => {
    const store = new GraphStore(sample(), { catalog });
    const events: GraphEvent[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    store.transact([{ op: "create", object: { id: "n", type: "source" } }], { origin: "ai", label: "add" });
    store.undo();
    expect(events.map((event) => event.kind)).toEqual(["transaction", "undo"]);
    expect(events[0]?.origin).toBe("ai");
    expect(events[0]?.changes).toEqual([{ kind: "object-created", objectId: "n" }]);
    expect(events[1]?.changes).toContainEqual({ kind: "object-deleted", objectId: "n" });
    unsubscribe();
    store.redo();
    expect(events).toHaveLength(2);
  });

  it("does not notify for rejected or empty transactions", () => {
    const store = new GraphStore(sample(), { catalog });
    let count = 0;
    store.subscribe(() => count++);
    expect(() => store.transact([{ op: "delete", objectId: "ghost" }])).toThrow();
    store.transact([]);
    expect(count).toBe(0);
  });
});

describe("dependency tracking", () => {
  it("reports dependencies, dependents and a deterministic execution order", () => {
    const builder = new GraphBuilder("Chain");
    builder.add("sink", { id: "c", name: "C" });
    builder.add("sink", { id: "b", name: "B" });
    builder.add("source", { id: "a", name: "A" });
    builder.connect("a.value", "b.in");
    builder.connect("b.out", "c.in");
    const graph = builder.build(catalog);
    expect(dependenciesOf(graph, "c")).toEqual(["b"]);
    expect(dependentsOf(graph, "a")).toEqual(["b"]);
    const first = executionOrder(graph);
    expect(first.order).toEqual(["a", "b", "c"]);
    expect(first.cyclic).toEqual([]);
    expect(executionOrder(parseGraph(serializeGraph(graph))).order).toEqual(first.order);
  });
});
