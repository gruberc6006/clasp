import {
  ancestorsOf,
  childrenOf,
  connectionsFrom,
  connectionsTo,
  descendantsOf,
  type ClaspGraph,
  type ClaspObject,
  type GraphInterface,
  type GraphOperation,
  type JsonValue,
} from "@clasp/core";
import type { GraphRevisionSummary } from "@clasp/persistence";
import { CAPABILITY_LABELS } from "@clasp/permissions";
import { useGraph, useRuntimeVersion } from "@clasp/renderer-react";
import type { AppHandle, PropertySpec } from "@clasp/runtime";
import { AlertCircle, ArrowDown, ArrowUp, History, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useStudio, useWorkspace } from "../../studio/hooks";
import { Badge, Button, CommitInput, Field, INPUT, IconButton, SectionTitle, Toggle, cx } from "../ui";
import { CATEGORY_DOT } from "./GraphCanvas";

function unique(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index++) {
    if (!taken.includes(`${base}${index}`)) return `${base}${index}`;
  }
}

function camel(text: string): string {
  const words = text.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "view";
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1))).join("");
}

// ── property editors ───────────────────────────────────────────────────────

function PropertyEditor(props: { spec: PropertySpec; value: JsonValue | undefined; fallback: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void }): ReactNode {
  const { spec, value, onChange } = props;
  const studio = useStudio();
  const workspace = useWorkspace();
  const label = spec.title ?? spec.name;
  const id = `prop-${spec.name}`;
  const effective = value ?? props.fallback;

  switch (spec.type) {
    case "boolean":
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-ink-soft">{label}</div>
            {spec.description && <div className="text-[11px] leading-snug text-ink-faint">{spec.description}</div>}
          </div>
          <Toggle label={label} checked={effective === true} onChange={(checked) => onChange(checked)} />
        </div>
      );
    case "enum":
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <select id={id} className={INPUT} value={typeof effective === "string" ? effective : ""} onChange={(event) => onChange(event.target.value || undefined)}>
            {spec.default === undefined && <option value="">—</option>}
            {(spec.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      );
    case "schema":
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <select id={id} className={INPUT} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
            <option value="">Choose a schema…</option>
            {workspace.schemas.list().map((schema) => (
              <option key={schema.id} value={schema.id}>
                {schema.title} ({schema.id})
              </option>
            ))}
          </select>
        </Field>
      );
    case "resource": {
      const resources = workspace.kernel.listResources().filter((resource) => resource.id !== studio.app?.id);
      const known = typeof value === "string" && resources.some((resource) => resource.id === value);
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <select id={id} className={INPUT} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
            <option value="">None</option>
            {typeof value === "string" && value && !known && <option value={value}>Not in this workspace ({value.slice(0, 14)}…)</option>}
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} · {resource.kind}
                {resource.ownerId !== resource.id ? ` · ${workspace.kernel.principalName(resource.ownerId)}` : ""}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    case "number":
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <CommitInput
            id={id}
            label={label}
            value={typeof value === "number" ? String(value) : ""}
            placeholder={typeof spec.default === "number" ? String(spec.default) : ""}
            onCommit={(text) => {
              if (text.trim() === "") return onChange(undefined);
              const number = Number(text);
              if (Number.isFinite(number)) onChange(number);
              else studio.toast({ tone: "warning", message: `“${text}” is not a number.` });
            }}
          />
        </Field>
      );
    case "list":
    case "object":
    case "json":
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <CommitInput
            id={id}
            label={label}
            multiline
            mono
            value={value === undefined ? "" : JSON.stringify(value, null, 2)}
            placeholder={spec.type === "list" ? "[ ]" : spec.type === "object" ? "{ }" : "JSON value"}
            onCommit={(text) => {
              if (text.trim() === "") return onChange(undefined);
              try {
                onChange(JSON.parse(text) as JsonValue);
              } catch {
                studio.toast({ tone: "warning", title: label, message: "That is not valid JSON, so it was not saved." });
              }
            }}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={spec.description} htmlFor={id}>
          <CommitInput
            id={id}
            label={label}
            multiline={spec.type === "text"}
            value={typeof value === "string" ? value : ""}
            placeholder={typeof spec.default === "string" ? spec.default : ""}
            onCommit={(text) => onChange(text === "" ? undefined : text)}
          />
        </Field>
      );
  }
}

// ── public interface helpers ───────────────────────────────────────────────

type PortGroup = "inputs" | "actions" | "outputs" | "events";

function isExposed(face: GraphInterface, group: PortGroup, objectId: string, port: string): boolean {
  if (group === "actions") return face.actions.some((entry) => entry.target.objectId === objectId && entry.target.port === port);
  if (group === "inputs") return face.inputs.some((entry) => entry.target.objectId === objectId && entry.target.port === port);
  if (group === "events") return face.events.some((entry) => entry.source.objectId === objectId && entry.source.port === port);
  return face.outputs.some((entry) => entry.source.objectId === objectId && entry.source.port === port);
}

function toggleExposed(face: GraphInterface, group: PortGroup, objectId: string, port: string): GraphInterface {
  const ref = { objectId, port };
  const on = isExposed(face, group, objectId, port);
  switch (group) {
    case "actions":
      return {
        ...face,
        actions: on
          ? face.actions.filter((entry) => !(entry.target.objectId === objectId && entry.target.port === port))
          : [...face.actions, { name: unique(port, face.actions.map((entry) => entry.name)), target: ref }],
      };
    case "inputs":
      return {
        ...face,
        inputs: on
          ? face.inputs.filter((entry) => !(entry.target.objectId === objectId && entry.target.port === port))
          : [...face.inputs, { name: unique(port, face.inputs.map((entry) => entry.name)), target: ref }],
      };
    case "events":
      return {
        ...face,
        events: on
          ? face.events.filter((entry) => !(entry.source.objectId === objectId && entry.source.port === port))
          : [...face.events, { name: unique(port, face.events.map((entry) => entry.name)), source: ref }],
      };
    case "outputs":
      return {
        ...face,
        outputs: on
          ? face.outputs.filter((entry) => !(entry.source.objectId === objectId && entry.source.port === port))
          : [...face.outputs, { name: unique(port, face.outputs.map((entry) => entry.name)), source: ref }],
      };
  }
}

// ── object inspector ───────────────────────────────────────────────────────

function ObjectInspector({ app, graph, object }: { app: AppHandle; graph: ClaspGraph; object: ClaspObject }): ReactNode {
  const studio = useStudio();
  const workspace = useWorkspace();
  const registry = workspace.registry;
  const definition = registry.get(object.type);
  const ports = registry.portsOf(object);
  const defaults = registry.defaults(object.type);
  const error = app.runtime.view(object.id)?.error;
  const name = object.metadata.name ?? definition?.title ?? object.type;

  const update = (operation: Omit<Extract<GraphOperation, { op: "update" }>, "op" | "objectId">, label: string): void => {
    studio.transact([{ op: "update", objectId: object.id, ...operation }], label);
  };

  const siblings = childrenOf(graph, object.parentId);
  const position = siblings.findIndex((sibling) => sibling.id === object.id);
  const swap = (direction: -1 | 1): void => {
    const other = siblings[position + direction];
    if (!other) return;
    // Renumber the two siblings so the order survives ties.
    const ordered = [...siblings];
    ordered[position] = other;
    ordered[position + direction] = object;
    studio.transact(
      ordered.map((sibling, index) => ({ op: "update" as const, objectId: sibling.id, order: index })),
      "Reorder",
    );
  };
  const excluded = new Set([object.id, ...descendantsOf(graph, object.id).map((entry) => entry.id)]);
  const containers = Object.values(graph.objects).filter((candidate) => !excluded.has(candidate.id) && registry.get(candidate.type)?.container === true);
  const nestable = definition?.category === "interface" || object.parentId !== undefined;
  const isView = graph.interface.views.some((entry) => entry.root === object.id);

  const groups: Array<{ group: PortGroup; title: string; items: Array<{ name: string; detail?: string }> }> = [
    { group: "inputs", title: "Inputs", items: (ports?.inputs ?? []).map((port) => ({ name: port.name, detail: port.type })) },
    { group: "actions", title: "Actions", items: (ports?.actions ?? []).map((port) => ({ name: port.name, ...(port.payload ? { detail: port.payload } : {}) })) },
    { group: "outputs", title: "Outputs", items: (ports?.outputs ?? []).map((port) => ({ name: port.name, detail: port.type })) },
    { group: "events", title: "Events", items: (ports?.events ?? []).map((port) => ({ name: port.name, ...(port.payload ? { detail: port.payload } : {}) })) },
  ];

  return (
    <div className="flex flex-col gap-6 p-4" data-testid="object-inspector">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className={cx("size-2 rounded-full", CATEGORY_DOT[definition?.category ?? "unknown"])} />
          <span className="text-xs font-medium text-ink-soft">{definition?.title ?? "Unknown component"}</span>
          <code className="ml-auto text-[10px] text-ink-faint">{object.type}</code>
        </div>
        <CommitInput label="Object name" value={name} onCommit={(value) => update({ name: value.trim() || name }, "Rename")} className="font-medium" />
        {definition && <p className="text-xs leading-relaxed text-ink-soft">{definition.description}</p>}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </header>

      {definition && definition.properties.length > 0 && (
        <section className="flex flex-col gap-3.5">
          <SectionTitle>Properties</SectionTitle>
          {definition.properties.map((spec) => (
            <PropertyEditor
              key={`${object.id}:${spec.name}`}
              spec={spec}
              value={object.properties[spec.name] ?? undefined}
              fallback={defaults[spec.name]}
              onChange={(value) =>
                update(value === undefined ? { unset: [spec.name] } : { properties: { [spec.name]: value } }, `Change ${spec.title ?? spec.name}`)
              }
            />
          ))}
        </section>
      )}

      {nestable && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Placement</SectionTitle>
          <Field label="Inside" htmlFor="parent">
            <div className="flex gap-1.5">
              <select
                id="parent"
                className={INPUT}
                value={object.parentId ?? ""}
                onChange={(event) => update({ parentId: event.target.value || null }, "Move")}
              >
                <option value="">Top level</option>
                {containers.map((container) => (
                  <option key={container.id} value={container.id}>
                    {[...ancestorsOf(graph, container.id).reverse(), container].map((entry) => entry.metadata.name ?? entry.type).join(" › ")}
                  </option>
                ))}
              </select>
              <IconButton label="Move earlier" disabled={position <= 0} onClick={() => swap(-1)} className="border border-line">
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton label="Move later" disabled={position < 0 || position >= siblings.length - 1} onClick={() => swap(1)} className="border border-line">
                <ArrowDown className="size-4" />
              </IconButton>
            </div>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-ink-soft">Expose as a view</div>
              <div className="text-[11px] leading-snug text-ink-faint">Lets other applications embed this element.</div>
            </div>
            <Toggle
              label="Expose as a view"
              checked={isView}
              onChange={(checked) => {
                const face = graph.interface;
                const views = checked
                  ? [...face.views, { name: unique(camel(name), face.views.map((entry) => entry.name)), root: object.id }]
                  : face.views.filter((entry) => entry.root !== object.id);
                studio.transact([{ op: "setInterface", interface: { ...face, views } }], checked ? "Expose view" : "Hide view");
              }}
            />
          </div>
        </section>
      )}

      {groups.some((entry) => entry.items.length > 0) && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Ports</SectionTitle>
          <p className="-mt-1 text-[11px] leading-snug text-ink-faint">Drag between ports on the canvas to connect them. Exposed ports become part of this application's public interface.</p>
          {groups
            .filter((entry) => entry.items.length > 0)
            .map((entry) => (
              <div key={entry.group}>
                <div className="mb-1 text-[11px] font-medium text-ink-soft">{entry.title}</div>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {entry.items.map((port) => {
                    const wires = entry.group === "inputs" || entry.group === "actions" ? connectionsTo(graph, object.id, port.name) : connectionsFrom(graph, object.id, port.name);
                    const exposed = isExposed(graph.interface, entry.group, object.id, port.name);
                    return (
                      <li key={port.name} className="flex items-center gap-2 px-2.5 py-1.5">
                        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{port.name}</code>
                        {port.detail && <span className="shrink-0 text-[10px] text-ink-faint">{port.detail}</span>}
                        {wires.length > 0 && <Badge tone="accent">{wires.length}</Badge>}
                        <button
                          type="button"
                          title={exposed ? "Remove from the public interface" : "Add to the public interface"}
                          aria-pressed={exposed}
                          aria-label={`Expose ${port.name}`}
                          onClick={() =>
                            studio.transact(
                              [{ op: "setInterface", interface: toggleExposed(graph.interface, entry.group, object.id, port.name) }],
                              exposed ? `Hide ${port.name}` : `Expose ${port.name}`,
                            )
                          }
                          className={cx(
                            "h-5 shrink-0 rounded-md px-1.5 text-[10px] font-medium transition-colors",
                            exposed ? "bg-accent text-white" : "bg-subtle text-ink-faint hover:text-ink",
                          )}
                        >
                          {exposed ? "exposed" : "expose"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </section>
      )}

      <Button
        tone="secondary"
        icon={<Trash2 className="size-3.5" />}
        className="self-start text-danger"
        data-testid="delete-object"
        onClick={() => {
          if (studio.transact([{ op: "delete", objectId: object.id }], `Delete ${name}`)) studio.selectObject(undefined);
        }}
      >
        Delete object
      </Button>
    </div>
  );
}

// ── application inspector ──────────────────────────────────────────────────

function AppInspector({ app, graph }: { app: AppHandle; graph: ClaspGraph }): ReactNode {
  const studio = useStudio();
  const workspace = useWorkspace();
  const [revisions, setRevisions] = useState<GraphRevisionSummary[]>([]);
  useEffect(() => {
    let alive = true;
    // Saving is asynchronous; ask after the current save has had a chance to land.
    const timer = setTimeout(() => {
      void workspace.storage.listRevisions(app.id).then((list) => {
        if (alive) setRevisions(list.slice(0, 8));
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [app.id, graph.version, workspace]);

  const face = graph.interface;
  const exposed: Array<{ kind: string; name: string; remove: () => GraphInterface }> = [
    ...face.actions.map((entry) => ({ kind: "action", name: entry.name, remove: () => ({ ...face, actions: face.actions.filter((other) => other !== entry) }) })),
    ...face.events.map((entry) => ({ kind: "event", name: entry.name, remove: () => ({ ...face, events: face.events.filter((other) => other !== entry) }) })),
    ...face.outputs.map((entry) => ({ kind: "output", name: entry.name, remove: () => ({ ...face, outputs: face.outputs.filter((other) => other !== entry) }) })),
    ...face.inputs.map((entry) => ({ kind: "input", name: entry.name, remove: () => ({ ...face, inputs: face.inputs.filter((other) => other !== entry) }) })),
    ...face.views.map((entry) => ({ kind: "view", name: entry.name, remove: () => ({ ...face, views: face.views.filter((other) => other !== entry) }) })),
  ];
  const requirements = workspace.requirements(app.id);
  const diagnostics = app.runtime.diagnostics();

  return (
    <div className="flex flex-col gap-6 p-4" data-testid="app-inspector">
      <header className="flex flex-col gap-3">
        <div className="text-xs font-medium text-ink-soft">Application</div>
        <CommitInput
          label="Description"
          multiline
          value={graph.metadata.description ?? ""}
          placeholder="What is this application for?"
          onCommit={(description) => studio.transact([{ op: "setMetadata", description }], "Edit description")}
        />
        <div className="flex flex-wrap gap-1.5">
          <Badge>{Object.keys(graph.objects).length} objects</Badge>
          <Badge>{Object.keys(graph.connections).length} connections</Badge>
          <Badge>revision {graph.version}</Badge>
          <Badge tone={app.runtime.status === "running" ? "success" : "danger"}>{app.runtime.status}</Badge>
        </div>
        <p className="text-xs leading-relaxed text-ink-faint">Select an object on the canvas to configure it. The graph you see here is exactly what runs in Use mode.</p>
      </header>

      <section className="flex flex-col gap-2">
        <SectionTitle>Public interface</SectionTitle>
        {exposed.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-faint">Nothing is exposed. Other applications cannot reach inside this one. Expose ports or views from an object's inspector.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {exposed.map((entry) => (
              <li key={`${entry.kind}:${entry.name}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <Badge tone="accent">{entry.kind}</Badge>
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{entry.name}</code>
                <button
                  type="button"
                  aria-label={`Stop exposing ${entry.name}`}
                  onClick={() => studio.transact([{ op: "setInterface", interface: entry.remove() }], `Hide ${entry.name}`)}
                  className="grid size-5 place-items-center rounded text-ink-faint hover:bg-subtle hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {requirements.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Permissions it needs</SectionTitle>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {requirements.map((requirement) => (
              <li key={`${requirement.objectId}:${requirement.capability}:${requirement.resource}`} className="flex items-center gap-2 px-2.5 py-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">
                    {CAPABILITY_LABELS[requirement.capability]} · {workspace.kernel.getResource(requirement.resource)?.name ?? "not in this workspace"}
                  </span>
                  <span className="block truncate text-ink-faint">{graph.objects[requirement.objectId]?.metadata.name}</span>
                </span>
                <Badge tone={requirement.satisfied ? "success" : requirement.resolved ? "warning" : "neutral"}>
                  {requirement.satisfied ? "granted" : requirement.resolved ? "not granted" : "unavailable"}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {diagnostics.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle
            action={
              <button type="button" className="text-[11px] font-medium text-ink-soft hover:text-ink" onClick={() => app.runtime.clearDiagnostics()}>
                Clear
              </button>
            }
          >
            Diagnostics
          </SectionTitle>
          <ul className="flex flex-col gap-1.5" data-testid="diagnostics">
            {diagnostics
              .slice(-8)
              .reverse()
              .map((diagnostic) => (
                <li key={diagnostic.id}>
                  <button
                    type="button"
                    disabled={!diagnostic.objectId}
                    onClick={() => studio.selectObject(diagnostic.objectId)}
                    className={cx(
                      "w-full rounded-lg border px-2.5 py-2 text-left text-xs leading-snug",
                      diagnostic.severity === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-warning/25 bg-warning-soft text-warning",
                    )}
                  >
                    {diagnostic.objectId && <span className="font-medium">{graph.objects[diagnostic.objectId]?.metadata.name ?? "Object"}: </span>}
                    {diagnostic.message}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionTitle>History</SectionTitle>
        {revisions.length === 0 ? (
          <p className="text-xs text-ink-faint">No saved revisions yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" data-testid="revisions">
            {revisions.map((revision) => (
              <li key={revision.version} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <History className="size-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{revision.label ?? `Revision ${revision.version}`}</span>
                  <span className="block truncate text-ink-faint">
                    {new Date(revision.savedAt).toLocaleTimeString()} · {revision.objectCount} objects
                    {revision.origin && revision.origin !== "user" ? ` · ${revision.origin}` : ""}
                  </span>
                </span>
                {revision.version !== graph.version && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft"
                    onClick={() => {
                      void workspace.storage
                        .loadRevision(app.id, revision.version)
                        .then((stored) => app.store.replace(stored, { label: `Restore revision ${revision.version}` }))
                        .catch((error: unknown) => studio.reportError("Could not restore that revision", error));
                    }}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The properties inspector: configures the selected object, or the application when nothing is selected. */
export function Inspector({ app }: { app: AppHandle }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(app.store);
  useRuntimeVersion(app.runtime);
  const object = studio.selectedObjectId ? graph.objects[studio.selectedObjectId] : undefined;
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-surface" data-testid="inspector">
      {object ? <ObjectInspector key={object.id} app={app} graph={graph} object={object} /> : <AppInspector app={app} graph={graph} />}
    </aside>
  );
}
