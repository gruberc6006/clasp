import { GraphBuilder } from "@clasp/core";
import { EXTENSION_FORMAT, SANDBOX_REQUIREMENTS, installExtension, validateExtension, type ExtensionManifest } from "@clasp/extensions";
import { exportPackage, importPackage } from "@clasp/sharing";
import { describe, expect, it } from "vitest";
import { expectCode, openWorkspace } from "./support";

async function sampleManifest(): Promise<ExtensionManifest> {
  // Author the template in a scratch workspace that already knows the schema.
  const { workspace } = await openWorkspace({ backend: "memory" });
  workspace.schemas.register({ id: "acme.crm.lead", version: 1, title: "Lead", extends: "clasp.contact", fields: { stage: { type: "enum", values: ["new", "won", "lost"], default: "new" } } });
  const b = new GraphBuilder("Leads");
  const leads = b.add("data.collection", { name: "Leads", properties: { schema: "acme.crm.lead" } });
  const win = b.add("ui.window", { name: "Window", properties: { title: "Leads" } });
  const table = b.add("ui.table", { name: "Lead table", parent: win });
  b.connect(`${leads}.records`, `${table}.rows`);
  const pkg = exportPackage(b.build(workspace.registry), { registry: workspace.registry, schemas: workspace.schemas });
  return {
    format: EXTENSION_FORMAT,
    formatVersion: 1,
    id: "acme.crm",
    name: "Acme CRM",
    version: "1.0.0",
    contributes: {
      schemas: [
        { id: "acme.crm.lead", version: 1, title: "Lead", extends: "clasp.contact", fields: { stage: { type: "enum", values: ["new", "won", "lost"], default: "new" } } },
      ],
      mappings: [{ from: "acme.crm.lead", to: "clasp.task", fields: { title: "name" } }],
      templates: [{ id: "leads", name: "Leads", package: pkg }],
    },
  };
}

describe("declarative extensions", () => {
  it("contribute schemas, mappings and templates to a workspace that has never seen them", async () => {
    const manifest = await sampleManifest();
    const { workspace } = await openWorkspace({ backend: "memory" });
    expect(workspace.schemas.has("acme.crm.lead")).toBe(false);

    const installed = installExtension(JSON.parse(JSON.stringify(manifest)), workspace);
    expect(installed).toMatchObject({ id: "acme.crm", schemas: ["acme.crm.lead@1"], mappings: ["acme.crm.lead>clasp.task"] });
    expect(workspace.schemas.require("acme.crm.lead").lineage).toEqual(["acme.crm.lead", "clasp.contact"]);
    expect(workspace.schemas.checkCompatibility({ id: "acme.crm.lead" }, { id: "clasp.task" }).via).toBe("mapping");

    // The template is an ordinary package: import, install, use.
    const app = await workspace.install(importPackage(installed.templates[0]!.package, workspace).graph);
    const collection = Object.values(app.store.graph.objects).find((object) => object.type === "data.collection")!;
    await app.clasp.mutate({ source: collection.id, operation: "create", data: { name: "Ada", stage: "won" } });
    await workspace.settle();
    expect(workspace.kernel.data.count(collection.id)).toBe(1);

    // Installing the same extension again is harmless.
    expect(installExtension(manifest, workspace).schemas).toEqual([]);
  });

  it("persist contributed schemas with the workspace", async () => {
    const manifest = await sampleManifest();
    const session = await openWorkspace();
    installExtension(manifest, session.workspace);
    await session.workspace.settle();
    const reloaded = await session.reload();
    expect(reloaded.workspace.schemas.has("acme.crm.lead", 1)).toBe(true);
    await reloaded.workspace.close();
  });

  it("refuse anything executable and say what a sandbox would need", async () => {
    const manifest = await sampleManifest();
    for (const smuggled of [
      { ...manifest, components: [{ type: "acme.widget", source: "export default () => fetch('https://evil.example')" }] },
      { ...manifest, contributes: { ...manifest.contributes, scripts: ["alert(1)"] } },
      { ...manifest, main: "index.js" },
    ]) {
      const error = await expectCode(() => validateExtension(smuggled), "INVALID_OPERATION");
      expect(error.message).toContain("does not run third-party code");
      expect(error.details.sandboxRequirements).toEqual([...SANDBOX_REQUIREMENTS]);
    }
    expect(SANDBOX_REQUIREMENTS.length).toBeGreaterThanOrEqual(5);
  });

  it("reject malformed, foreign-namespace and conflicting manifests without changing the workspace", async () => {
    const manifest = await sampleManifest();
    const { workspace } = await openWorkspace({ backend: "memory" });
    const before = workspace.schemas.list().map((schema) => schema.id);

    await expectCode(() => validateExtension("nope"), "VALIDATION_FAILED");
    await expectCode(() => validateExtension({ ...manifest, version: "one" }), "VALIDATION_FAILED");
    await expectCode(() => validateExtension({ ...manifest, formatVersion: 3 }), "INCOMPATIBLE");
    // An extension may not redefine the built-in vocabulary or squat another namespace.
    const hijack = { ...manifest, contributes: { schemas: [{ id: "clasp.task", version: 2, title: "Task", fields: {} }] } };
    const error = await expectCode(() => installExtension(hijack, workspace), "VALIDATION_FAILED");
    expect(error.issues[0]?.code).toBe("FOREIGN_NAMESPACE");

    // A template that needs a component this workspace lacks.
    const needy = JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
    needy.contributes.templates![0]!.package.requires.components.push({ type: "vendor.chart", version: 1 });
    const missing = await expectCode(() => installExtension(needy, workspace), "VALIDATION_FAILED");
    expect(missing.issues.map((entry) => entry.code)).toEqual(["MISSING_COMPONENT"]);

    // A different definition of an already-registered schema version.
    workspace.schemas.register({ id: "acme.crm.lead", version: 1, title: "Lead", fields: { other: { type: "string" } } });
    const conflict = await expectCode(() => installExtension(manifest, workspace), "VALIDATION_FAILED");
    expect(conflict.issues[0]?.code).toBe("SCHEMA_CONFLICT");
    expect(workspace.schemas.list().map((schema) => schema.id)).toEqual([...before, "acme.crm.lead"].sort());
    expect(workspace.schemas.findMapping("acme.crm.lead", "clasp.task")).toBeUndefined();
  });
});
