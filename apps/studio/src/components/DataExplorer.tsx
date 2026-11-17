import type { ResourceDescriptor } from "@clasp/universal-api";
import { Boxes, Database, FileJson, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useStudio, useWorkspace } from "../studio/hooks";
import { Badge, Button, EmptyState, SectionTitle, cx } from "./ui";

type Selection = { kind: "collection" | "resource" | "schema" | "orphan"; id: string };

function Row(props: { active: boolean; onClick: () => void; title: string; subtitle?: string; trailing?: ReactNode; testId?: string }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid={props.testId}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        props.active ? "bg-accent-soft" : "hover:bg-subtle",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{props.title}</span>
        {props.subtitle && <span className="block truncate text-xs text-ink-soft">{props.subtitle}</span>}
      </span>
      {props.trailing}
    </button>
  );
}

function value(input: unknown): ReactNode {
  if (input === undefined || input === null) return <span className="text-ink-faint">—</span>;
  if (typeof input === "boolean") return input ? "true" : "false";
  if (typeof input === "object") return <code className="text-xs">{JSON.stringify(input)}</code>;
  return String(input);
}

function CollectionDetail({ resource }: { resource: ResourceDescriptor }): ReactNode {
  const workspace = useWorkspace();
  const records = workspace.kernel.data.list(resource.id);
  const schema = resource.schema ? workspace.schemas.get(resource.schema.id, resource.schema.version) : undefined;
  const fields = Object.keys(schema?.fields ?? {});
  return (
    <div className="flex flex-col gap-5" data-testid="collection-detail">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-ink">{resource.name}</h2>
          {resource.schema && <Badge tone="accent">{resource.schema.id} v{resource.schema.version}</Badge>}
          <Badge tone={resource.exposure === "discoverable" ? "success" : "neutral"}>{resource.exposure}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          Owned by <span className="font-medium text-ink">{workspace.kernel.principalName(resource.ownerId)}</span> ·{" "}
          {records.length} {records.length === 1 ? "record" : "records"}
          {resource.exposure === "discoverable" ? " · other applications can find it, but need your permission to read it" : " · invisible to other applications"}
        </p>
      </header>
      {records.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-faint">No records yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle/60">
                {fields.map((field) => (
                  <th key={field} className="whitespace-nowrap px-3.5 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                    {field}
                  </th>
                ))}
                <th className="whitespace-nowrap px-3.5 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-faint">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {records.map((record) => (
                <tr key={record.id} data-testid="record-row">
                  {fields.map((field) => (
                    <td key={field} className="max-w-72 truncate px-3.5 py-2.5 text-ink">
                      {value(record.fields[field])}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3.5 py-2.5 text-xs text-ink-faint">
                    {new Date(record.updatedAt).toLocaleString()} · v{record.version}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Members({ title, items }: { title: string; items: Array<{ name: string; description?: string }> }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
        {items.map((item) => (
          <li key={item.name} className="flex items-baseline gap-3 px-3.5 py-2.5 text-sm">
            <code className="shrink-0 font-mono text-xs font-medium text-ink">{item.name}</code>
            <span className="min-w-0 text-ink-soft">{item.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResourceDetail({ resource }: { resource: ResourceDescriptor }): ReactNode {
  const workspace = useWorkspace();
  const nothing = [resource.actions, resource.events, resource.outputs, resource.inputs, resource.views].every((list) => list.length === 0);
  return (
    <div className="flex flex-col gap-5">
      <header>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-ink">{resource.name}</h2>
          <Badge>{resource.kind}</Badge>
          <Badge tone={resource.exposure === "discoverable" ? "success" : "neutral"}>{resource.exposure}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {resource.description ?? `Provided by ${workspace.kernel.principalName(resource.ownerId)}.`} Other applications reach only what is listed here, and only
          with your permission.
        </p>
      </header>
      {nothing && <p className="text-sm text-ink-faint">This application exposes nothing. Expose ports from the inspector in Build mode.</p>}
      <Members title="Actions" items={resource.actions} />
      <Members title="Events" items={resource.events} />
      <Members title="Outputs" items={resource.outputs} />
      <Members title="Inputs" items={resource.inputs} />
      <Members title="Views" items={resource.views} />
    </div>
  );
}

function SchemaDetail({ id }: { id: string }): ReactNode {
  const workspace = useWorkspace();
  const schema = workspace.schemas.get(id);
  if (!schema) return null;
  return (
    <div className="flex flex-col gap-5">
      <header>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-ink">{schema.title}</h2>
          <Badge tone="accent">
            {schema.id} v{schema.version}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {schema.description}
          {schema.lineage.length > 1 && <> Extends {schema.lineage.slice(1).join(" → ")}.</>}
        </p>
      </header>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-subtle/60 text-xs font-medium uppercase tracking-wide text-ink-faint">
              <th className="px-3.5 py-2.5">Field</th>
              <th className="px-3.5 py-2.5">Type</th>
              <th className="px-3.5 py-2.5">Required</th>
              <th className="px-3.5 py-2.5">Default</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {Object.entries(schema.fields).map(([name, field]) => (
              <tr key={name}>
                <td className="px-3.5 py-2.5 font-mono text-xs font-medium text-ink">{name}</td>
                <td className="px-3.5 py-2.5 text-ink-soft">
                  {field.type}
                  {field.type === "enum" && ` (${(field.values ?? []).join(", ")})`}
                  {field.type === "reference" && ` → ${field.ref}`}
                  {field.type === "list" && ` of ${field.items ?? "json"}`}
                </td>
                <td className="px-3.5 py-2.5 text-ink-soft">{field.required ? "yes" : "—"}</td>
                <td className="px-3.5 py-2.5 text-ink-soft">{value(field.default)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The user's own view of the workspace's data, schemas and shared objects. */
export function DataExplorer(): ReactNode {
  const studio = useStudio();
  const workspace = useWorkspace();
  const resources = workspace.kernel.listResources();
  // System collections (the file store) have their own views; this one shows application data.
  const collections = resources.filter((resource) => resource.kind === "collection" && resource.ownerId !== "clasp.system");
  const shared = resources.filter((resource) => resource.kind !== "collection");
  const orphans = workspace.kernel.data
    .collectionIds()
    .filter((id) => !resources.some((resource) => resource.id === id) && workspace.kernel.data.count(id) > 0);
  const schemas = workspace.schemas.list();
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const current: Selection | undefined = selection ?? (collections[0] ? { kind: "collection", id: collections[0].id } : schemas[0] ? { kind: "schema", id: schemas[0].id } : undefined);
  const is = (kind: Selection["kind"], id: string): boolean => current?.kind === kind && current.id === id;
  const selected = current && current.kind !== "schema" && current.kind !== "orphan" ? resources.find((resource) => resource.id === current.id) : undefined;

  return (
    <div className="flex min-h-0 flex-1" data-testid="data-explorer">
      <div className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface px-3 py-5">
        <div>
          <div className="px-2.5 pb-1.5">
            <SectionTitle>Collections</SectionTitle>
          </div>
          {collections.length === 0 && <p className="px-2.5 text-xs text-ink-faint">No application has declared a collection yet.</p>}
          {collections.map((collection) => (
            <Row
              key={collection.id}
              active={is("collection", collection.id)}
              onClick={() => setSelection({ kind: "collection", id: collection.id })}
              title={collection.name}
              subtitle={`${workspace.kernel.principalName(collection.ownerId)} · ${collection.schema?.id ?? ""}`}
              trailing={<Badge>{workspace.kernel.data.count(collection.id)}</Badge>}
              testId="collection-row"
            />
          ))}
        </div>
        <div>
          <div className="px-2.5 pb-1.5">
            <SectionTitle>Applications & services</SectionTitle>
          </div>
          {shared.map((resource) => (
            <Row
              key={resource.id}
              active={is("resource", resource.id)}
              onClick={() => setSelection({ kind: "resource", id: resource.id })}
              title={resource.name}
              subtitle={
                resource.kind === "service"
                  ? "System service"
                  : resource.exposure === "private"
                    ? "Private — exposes nothing"
                    : `Exposes ${resource.actions.length + resource.events.length + resource.outputs.length + resource.inputs.length + resource.views.length}`
              }
            />
          ))}
        </div>
        <div>
          <div className="px-2.5 pb-1.5">
            <SectionTitle>Schemas</SectionTitle>
          </div>
          {schemas.map((schema) => (
            <Row key={schema.id} active={is("schema", schema.id)} onClick={() => setSelection({ kind: "schema", id: schema.id })} title={schema.title} subtitle={schema.id} />
          ))}
        </div>
        {orphans.length > 0 && (
          <div>
            <div className="px-2.5 pb-1.5">
              <SectionTitle>Kept data</SectionTitle>
            </div>
            {orphans.map((id) => (
              <Row
                key={id}
                active={is("orphan", id)}
                onClick={() => setSelection({ kind: "orphan", id })}
                title="Records without an owner"
                subtitle={id}
                trailing={<Badge tone="warning">{workspace.kernel.data.count(id)}</Badge>}
              />
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        {!current && (
          <EmptyState icon={<Database className="size-5" />} title="No data yet">
            Collections, schemas and shared objects appear here.
          </EmptyState>
        )}
        {current?.kind === "collection" && selected && <CollectionDetail resource={selected} />}
        {current?.kind === "resource" && selected && <ResourceDetail resource={selected} />}
        {current?.kind === "schema" && <SchemaDetail id={current.id} />}
        {current?.kind === "orphan" && (
          <EmptyState
            icon={<FileJson className="size-5" />}
            title={`${workspace.kernel.data.count(current.id)} kept records`}
            action={
              <Button
                tone="danger"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => {
                  if (window.confirm("Permanently erase these records?")) {
                    void workspace.kernel.data.purge(current.id).then(() => {
                      setSelection(undefined);
                      studio.toast({ tone: "success", message: "The records were erased." });
                    });
                  }
                }}
              >
                Erase records
              </Button>
            }
          >
            These records belonged to a collection whose application was deleted or changed. They are kept until you erase them.
          </EmptyState>
        )}
        {current && current.kind !== "schema" && current.kind !== "orphan" && !selected && (
          <EmptyState icon={<Boxes className="size-5" />} title="No longer available">
            This object was removed.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
