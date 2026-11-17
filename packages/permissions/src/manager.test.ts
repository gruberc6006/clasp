import { ClaspError } from "@clasp/core";
import { describe, expect, it } from "vitest";
import { PermissionManager, type PermissionEvent } from "./index";

function setup(): PermissionManager {
  const permissions = new PermissionManager();
  const owners: Record<string, string> = { tasks: "app.manager", notifier: "clasp.system" };
  permissions.setOwnerResolver((resource) => owners[resource]);
  return permissions;
}

describe("permission enforcement", () => {
  it("lets owners do anything and denies everyone else by default", () => {
    const permissions = setup();
    expect(permissions.check({ subject: "app.manager", capability: "collection.mutate", resource: "tasks" })).toBe(true);
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" })).toBe(false);
    try {
      permissions.authorize({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" });
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaspError);
      expect((error as ClaspError).code).toBe("PERMISSION_DENIED");
    }
  });

  it("scopes grants to one subject, one resource and one capability", () => {
    const permissions = setup();
    permissions.grant({ subject: "app.dashboard", resource: "tasks", capability: "collection.query" });
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" })).toBe(true);
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.mutate", resource: "tasks" })).toBe(false);
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "other" })).toBe(false);
    expect(permissions.check({ subject: "app.other", capability: "collection.query", resource: "tasks" })).toBe(false);
    expect(permissions.granted("app.dashboard", "tasks")).toEqual(["collection.query"]);
  });

  it("rejects wildcard and malformed grants", () => {
    const permissions = setup();
    expect(() => permissions.grant({ subject: "a", resource: "*", capability: "object.read" })).toThrow();
    expect(() => permissions.grant({ subject: "", resource: "tasks", capability: "object.read" })).toThrow();
    expect(() => permissions.grant({ subject: "a", resource: "tasks", capability: "everything" as never })).toThrow();
  });

  it("restricts invoke grants to named actions", () => {
    const permissions = setup();
    permissions.grant({ subject: "app.flow", resource: "notifier", capability: "capability.invoke", actions: ["send"] });
    expect(permissions.check({ subject: "app.flow", capability: "capability.invoke", resource: "notifier", action: "send" })).toBe(true);
    expect(permissions.check({ subject: "app.flow", capability: "capability.invoke", resource: "notifier", action: "wipe" })).toBe(false);
  });

  it("deduplicates identical grants", () => {
    const permissions = setup();
    const first = permissions.grant({ subject: "a", resource: "tasks", capability: "collection.query" });
    const second = permissions.grant({ subject: "a", resource: "tasks", capability: "collection.query" });
    expect(second.id).toBe(first.id);
    expect(permissions.list()).toHaveLength(1);
  });
});

describe("permission revocation", () => {
  it("takes effect immediately and notifies listeners", () => {
    const permissions = setup();
    const events: PermissionEvent[] = [];
    permissions.onChange((event) => events.push(event));
    const grant = permissions.grant({ subject: "app.dashboard", resource: "tasks", capability: "collection.query" });
    expect(permissions.revoke(grant.id)).toBe(true);
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" })).toBe(false);
    expect(permissions.revoke(grant.id)).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(["granted", "revoked"]);
  });

  it("revokes in bulk by subject or resource", () => {
    const permissions = setup();
    permissions.grant({ subject: "a", resource: "tasks", capability: "collection.query" });
    permissions.grant({ subject: "a", resource: "notifier", capability: "capability.invoke" });
    permissions.grant({ subject: "b", resource: "tasks", capability: "collection.query" });
    expect(permissions.revokeWhere({ subject: "a" })).toBe(2);
    expect(permissions.list().map((grant) => grant.subject)).toEqual(["b"]);
    expect(permissions.revokeWhere({ resource: "tasks" })).toBe(1);
    expect(permissions.list()).toHaveLength(0);
  });
});

describe("access requests", () => {
  it("grant nothing until the user approves", async () => {
    const permissions = setup();
    const decision = permissions.request({ subject: "app.dashboard", resource: "tasks", capabilities: ["collection.query"], reason: "Show tasks" });
    const [request] = permissions.pendingRequests();
    expect(request?.capabilities).toEqual(["collection.query"]);
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" })).toBe(false);
    permissions.resolveRequest(request!.id, true);
    await expect(decision).resolves.toEqual({ granted: true, capabilities: ["collection.query"] });
    expect(permissions.check({ subject: "app.dashboard", capability: "collection.query", resource: "tasks" })).toBe(true);
    expect(permissions.pendingRequests()).toHaveLength(0);
  });

  it("can be denied, and resolve immediately when access already exists", async () => {
    const permissions = setup();
    const denied = permissions.request({ subject: "x", resource: "tasks", capabilities: ["collection.mutate"] });
    permissions.resolveRequest(permissions.pendingRequests()[0]!.id, false);
    await expect(denied).resolves.toEqual({ granted: false, capabilities: [] });
    expect(permissions.list()).toHaveLength(0);
    await expect(permissions.request({ subject: "app.manager", resource: "tasks", capabilities: ["collection.query"] })).resolves.toMatchObject({
      granted: true,
    });
    expect(() => permissions.resolveRequest("req_missing", true)).toThrowError(ClaspError);
  });
});

describe("persistence of grants", () => {
  it("round-trips through snapshot and load", () => {
    const permissions = setup();
    permissions.grant({ subject: "a", resource: "tasks", capability: "collection.query" });
    const restored = setup();
    restored.load(permissions.snapshot());
    expect(restored.check({ subject: "a", capability: "collection.query", resource: "tasks" })).toBe(true);
  });
});
