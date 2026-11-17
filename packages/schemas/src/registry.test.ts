import { ClaspError } from "@clasp/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_SCHEMA_IDS, createSchemaRegistry } from "./index";

describe("schema registry", () => {
  it("ships the common schemas with stable ids and versions", () => {
    const registry = createSchemaRegistry();
    expect(BUILTIN_SCHEMA_IDS).toEqual([
      "clasp.project",
      "clasp.task",
      "clasp.note",
      "clasp.event",
      "clasp.contact",
      "clasp.document",
      "clasp.score",
    ]);
    for (const id of BUILTIN_SCHEMA_IDS) expect(registry.require(id).version).toBe(1);
    expect(registry.require("clasp.task").fields.project).toMatchObject({ type: "reference", ref: "clasp.project" });
    expect(registry.list().map((schema) => schema.id)).toContain("clasp.contact");
  });

  it("validates records, applies defaults and reports every problem", () => {
    const registry = createSchemaRegistry();
    const ok = registry.validate({ id: "clasp.task" }, { title: "Build Clasp" });
    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual({ title: "Build Clasp", completed: false });

    const bad = registry.validate({ id: "clasp.task" }, { title: "   ", completed: "yes", priority: "urgent", bogus: 1, dueDate: "tomorrow" });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((entry) => entry.code).sort()).toEqual([
      "INVALID_FIELD",
      "INVALID_FIELD",
      "INVALID_FIELD",
      "INVALID_FIELD",
      "UNKNOWN_FIELD",
    ]);
    expect(registry.validate({ id: "clasp.task" }, {}).issues.map((entry) => entry.code)).toEqual(["REQUIRED_FIELD"]);
    expect(registry.validate({ id: "clasp.task" }, "nope").ok).toBe(false);
  });

  it("validates partial updates without requiring untouched fields", () => {
    const registry = createSchemaRegistry();
    const partial = registry.validate({ id: "clasp.task" }, { completed: true }, { partial: true });
    expect(partial.ok).toBe(true);
    expect(partial.value).toEqual({ completed: true });
    expect(registry.validate({ id: "clasp.task" }, { title: null }, { partial: true }).ok).toBe(false);
    expect(registry.validate({ id: "clasp.task" }, { notes: null }, { partial: true }).value).toEqual({ notes: null });
  });

  it("rejects invalid definitions and conflicting re-registration", () => {
    const registry = createSchemaRegistry();
    expect(() => registry.register({ id: "Task", version: 1, title: "x", fields: {} })).toThrowError(ClaspError);
    expect(() => registry.register({ id: "acme.x", version: 1, title: "x", fields: { id: { type: "string" } } })).toThrow();
    expect(() => registry.register({ id: "acme.x", version: 1, title: "x", fields: { kind: { type: "enum" } } })).toThrow();
    expect(() => registry.register({ id: "acme.x", version: 1, title: "x", extends: "acme.missing", fields: {} })).toThrow();
    registry.register({ id: "acme.x", version: 1, title: "X", fields: { a: { type: "string" } } });
    registry.register({ id: "acme.x", version: 1, title: "X", fields: { a: { type: "string" } } });
    try {
      registry.register({ id: "acme.x", version: 1, title: "X", fields: { a: { type: "number" } } });
      throw new Error("expected conflict");
    } catch (error) {
      expect((error as ClaspError).code).toBe("CONFLICT");
    }
  });

  it("supports extension: a child schema inherits fields and stays compatible with its parent", () => {
    const registry = createSchemaRegistry();
    registry.register({
      id: "acme.sprintTask",
      version: 1,
      title: "Sprint task",
      extends: "clasp.task",
      fields: { points: { type: "number", min: 0 } },
    });
    const schema = registry.require("acme.sprintTask");
    expect(schema.lineage).toEqual(["acme.sprintTask", "clasp.task"]);
    expect(Object.keys(schema.fields)).toEqual(expect.arrayContaining(["title", "completed", "points"]));
    expect(registry.validate({ id: "acme.sprintTask" }, { title: "Ship", points: 3 }).ok).toBe(true);
    expect(registry.checkCompatibility({ id: "acme.sprintTask" }, { id: "clasp.task" })).toMatchObject({
      compatible: true,
      via: "extends",
    });
    // The parent does not satisfy consumers of the child.
    expect(registry.checkCompatibility({ id: "clasp.task" }, { id: "acme.sprintTask" }).compatible).toBe(false);
    expect(registry.mapFields({ id: "acme.sprintTask" }, { id: "clasp.task" }, { title: "Ship", points: 3 })).toEqual({ title: "Ship" });
  });

  it("checks compatibility across versions", () => {
    const registry = createSchemaRegistry();
    registry.register({ id: "acme.item", version: 1, title: "Item", fields: { name: { type: "string" }, qty: { type: "number" } } });
    registry.register({
      id: "acme.item",
      version: 2,
      title: "Item",
      fields: { name: { type: "string" }, qty: { type: "number" }, sku: { type: "string" } },
    });
    registry.register({ id: "acme.item", version: 3, title: "Item", fields: { name: { type: "string" }, qty: { type: "string" } } });
    expect(registry.versions("acme.item")).toEqual([1, 2, 3]);
    expect(registry.require("acme.item").version).toBe(3);
    expect(registry.checkCompatibility({ id: "acme.item", version: 2 }, { id: "acme.item", version: 1 })).toMatchObject({
      compatible: true,
      via: "version",
    });
    // v1 lacks a field v2 consumers expect; v3 changed a field type.
    expect(registry.checkCompatibility({ id: "acme.item", version: 1 }, { id: "acme.item", version: 2 }).issues[0]?.code).toBe("MISSING_FIELD");
    expect(registry.checkCompatibility({ id: "acme.item", version: 3 }, { id: "acme.item", version: 1 }).issues[0]?.code).toBe("FIELD_TYPE_CHANGED");
  });

  it("never assumes same-named fields mean the same thing: unrelated schemas need an explicit mapping", () => {
    const registry = createSchemaRegistry();
    registry.register({
      id: "acme.todo",
      version: 1,
      title: "Todo",
      fields: { title: { type: "string" }, label: { type: "string", required: true }, isDone: { type: "boolean", default: false } },
    });
    // Both have a "title" field, but they are unrelated schemas.
    expect(registry.checkCompatibility({ id: "acme.todo" }, { id: "clasp.task" })).toMatchObject({ compatible: false });
    expect(() => registry.mapFields({ id: "acme.todo" }, { id: "clasp.task" }, { label: "x" })).toThrowError(ClaspError);

    expect(() => registry.registerMapping({ from: "acme.todo", to: "clasp.task", fields: { completed: "isDone" } })).toThrow();
    registry.registerMapping({
      from: "acme.todo",
      to: "clasp.task",
      fields: { title: "label", completed: "isDone", priority: { const: "low" } },
    });
    expect(registry.checkCompatibility({ id: "acme.todo" }, { id: "clasp.task" })).toMatchObject({ compatible: true, via: "mapping" });
    expect(registry.mapFields({ id: "acme.todo" }, { id: "clasp.task" }, { title: "ignored", label: "Water plants", isDone: true })).toEqual({
      title: "Water plants",
      completed: true,
      priority: "low",
    });
  });
});
