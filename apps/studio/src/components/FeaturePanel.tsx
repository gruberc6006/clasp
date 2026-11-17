import {
  ADDABLE_FEATURES,
  BUILTIN_ENTITIES,
  DOCUMENT_EDITORS,
  FIELD_KINDS,
  TOOLS,
  TOOL_NAMES,
  changeFeature,
  compileFeatures,
  entityNameFor,
  humanize,
  inventory,
  pluralize,
  removeFeature,
  toFieldName,
  type CompiledFeatures,
  type FeatureSpec,
  type FieldKind,
  type FieldSpec,
  type PresentEntity,
  type PresentFeature,
} from "@clasp/features";
import { documentFeature } from "@clasp/files";
import { useGraph } from "@clasp/renderer-react";
import type { AppHandle } from "@clasp/runtime";
import type { FieldDefinition, SchemaRegistry } from "@clasp/schemas";
import {
  ArrowUpDown,
  Blocks,
  CalendarDays,
  Database,
  FileText,
  Filter,
  Hash,
  Heading,
  Kanban,
  List,
  ListChecks,
  Lock,
  Pencil,
  Plus,
  Search,
  Share2,
  SquarePlus,
  Trash2,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { Badge, Button, Field, INPUT, IconButton, cx } from "./ui";

const EXTENSIONS = [documentFeature];

const ICONS: Record<string, ReactNode> = {
  title: <Heading className="size-4" />,
  add: <SquarePlus className="size-4" />,
  list: <List className="size-4" />,
  search: <Search className="size-4" />,
  filter: <Filter className="size-4" />,
  sort: <ArrowUpDown className="size-4" />,
  count: <Hash className="size-4" />,
  share: <Share2 className="size-4" />,
  calendar: <CalendarDays className="size-4" />,
  board: <Kanban className="size-4" />,
  tool: <Wrench className="size-4" />,
  document: <FileText className="size-4" />,
  records: <Database className="size-4" />,
};

const ANY_FIELD = ["string", "number", "boolean", "enum", "date", "datetime"];
const FIELD_TYPE_LABELS: Record<FieldKind, string> = { text: "Text", longtext: "Long text", number: "Number", boolean: "Yes / no", date: "Date", choice: "Choice" };

// ── entities on offer ────────────────────────────────────────────────────

interface EntityOption {
  name: string;
  plural: string;
  fields: Record<string, FieldDefinition>;
  present: boolean;
}

function entityOptions(entities: PresentEntity[], schemas: SchemaRegistry): EntityOption[] {
  const options: EntityOption[] = entities.filter((entity) => entity.editable).map((entity) => ({ name: entity.name, plural: entity.plural, fields: entity.fields, present: true }));
  for (const id of new Set(Object.values(BUILTIN_ENTITIES))) {
    if (id === "clasp.score") continue;
    const name = entityNameFor(id, schemas);
    const schema = schemas.get(id);
    if (!schema || options.some((option) => option.name === name)) continue;
    options.push({ name, plural: pluralize(name), fields: schema.fields, present: false });
  }
  return options;
}

function fieldsOf(option: EntityOption | undefined, types: string[]): string[] {
  return Object.entries(option?.fields ?? {})
    .filter(([, definition]) => types.includes(definition.type))
    .map(([name]) => name);
}

// ── drafts: what the forms edit ──────────────────────────────────────────

type Draft = Record<string, unknown> & { kind: string };

function defaultDraft(kind: string, options: EntityOption[], title: string): Draft {
  const option = options.find((candidate) => candidate.present) ?? options[0];
  const entity = option?.name ?? "Task";
  const first = (types: string[]): string | undefined => fieldsOf(option, types)[0];
  switch (kind) {
    case "records":
      return { kind, name: "", fields: [{ name: "title", type: "text", required: true }] };
    case "add":
      return { kind, entity, fields: fieldsOf(option, ANY_FIELD) };
    case "list":
      return { kind, entity, display: "list", editable: true, removable: true };
    case "search":
      return { kind, entity, field: first(["string"]) };
    case "filter":
      return { kind, entity, field: first(["boolean", "enum"]), mode: "tabs" };
    case "sort":
      return { kind, entity, field: first(ANY_FIELD), direction: "asc" };
    case "count":
      return { kind, entity, label: option?.plural.toLowerCase() ?? "" };
    case "calendar":
      return { kind, entity, field: first(["date", "datetime"]) };
    case "board":
      return { kind, entity, field: first(["enum"]) };
    case "share":
      return { kind, entity };
    case "tool":
      return { kind, tool: "calculator" };
    case "document":
      return { kind, editor: "richtext", files: true };
    case "title":
      return { kind, text: title };
    default:
      return { kind };
  }
}

function draftFrom(spec: FeatureSpec): Draft {
  const draft: Draft = { ...(spec as unknown as Record<string, unknown>), kind: spec.kind };
  if (spec.kind === "filter") draft.mode = spec.value !== undefined && spec.value !== null ? "only" : "tabs";
  return draft;
}

function specFrom(draft: Draft): FeatureSpec {
  const { mode, ...rest } = draft;
  if (draft.kind === "filter" && mode === "tabs") delete rest.value;
  if (draft.kind === "count" && !(rest.where as { field?: string } | undefined)?.field) delete rest.where;
  if (draft.kind === "list" && rest.display !== "table") delete rest.fields;
  for (const [key, value] of Object.entries(rest)) if (value === undefined || value === "") delete rest[key];
  return rest as unknown as FeatureSpec;
}

/** What a draft would do to the application: compiled, never applied. */
function compileDraft(draft: Draft, feature: PresentFeature | undefined, context: Parameters<typeof compileFeatures>[1]): CompiledFeatures {
  const none = (message: string): CompiledFeatures => ({ operations: [], schemas: [], described: [], issues: [message] });
  if (draft.kind === "records") {
    const name = String(draft.name ?? "").trim();
    if (!name) return none("Name the kind of record, for example “Book”.");
    const fields = (draft.fields as FieldSpec[]).filter((field) => field.name.trim() !== "");
    if (fields.length === 0) return none("Give it at least one field.");
    return compileFeatures({ entities: [{ name, fields }], features: [{ kind: "add", entity: name }, { kind: "list", entity: name }] }, context, EXTENSIONS);
  }
  if (draft.kind === "field") {
    const field = draft.field as FieldSpec;
    if (!field.name.trim()) return none("Name the field.");
    const entity = String(draft.entity);
    return compileFeatures({ entities: [{ name: entity, fields: [field] }], features: [{ kind: "add", entity, fields: [toFieldName(field.name)] }] }, context, EXTENSIONS);
  }
  const spec = specFrom(draft);
  if ("field" in spec && !spec.field && ["search", "filter", "sort", "board"].includes(spec.kind)) return none("This needs a field of the right kind — the records have none yet.");
  return feature ? changeFeature(feature, spec, context, EXTENSIONS) : compileFeatures({ features: [spec] }, context, EXTENSIONS);
}

// ── form controls ────────────────────────────────────────────────────────

function Choice(props: { label: string; value: string | undefined; options: Array<[string, string]>; onChange: (value: string) => void; testId?: string; empty?: string }): ReactNode {
  return (
    <Field label={props.label}>
      <select className={INPUT} value={props.value ?? ""} onChange={(event) => props.onChange(event.target.value)} data-testid={props.testId} aria-label={props.label}>
        {props.empty !== undefined && <option value="">{props.empty}</option>}
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Pills(props: { label: string; values: string[]; selected: string[]; onChange: (selected: string[]) => void }): ReactNode {
  return (
    <Field label={props.label}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={props.label}>
        {props.values.map((value) => {
          const on = props.selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => props.onChange(on ? props.selected.filter((entry) => entry !== value) : [...props.selected, value])}
              className={cx("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-soft hover:bg-subtle")}
            >
              {humanize(value)}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function Text(props: { label: string; value: string | undefined; onChange: (value: string) => void; placeholder?: string; testId?: string }): ReactNode {
  return (
    <Field label={props.label}>
      <input className={INPUT} value={props.value ?? ""} placeholder={props.placeholder} aria-label={props.label} data-testid={props.testId} onChange={(event) => props.onChange(event.target.value)} />
    </Field>
  );
}

function FieldRows({ fields, onChange }: { fields: FieldSpec[]; onChange: (fields: FieldSpec[]) => void }): ReactNode {
  const set = (index: number, patch: Partial<FieldSpec>): void => onChange(fields.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  return (
    <Field label="Fields">
      <div className="flex flex-col gap-1.5">
        {fields.map((field, index) => (
          <div key={index} className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-1.5">
              <input className={INPUT} aria-label={`Field ${index + 1} name`} placeholder="Field name" value={field.name} onChange={(event) => set(index, { name: event.target.value })} />
              <select className={INPUT} aria-label={`Field ${index + 1} type`} value={field.type} onChange={(event) => set(index, { type: event.target.value as FieldKind })}>
                {FIELD_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {FIELD_TYPE_LABELS[kind]}
                  </option>
                ))}
              </select>
              <IconButton label="Remove field" onClick={() => onChange(fields.filter((_, at) => at !== index))} disabled={fields.length === 1}>
                <X className="size-3.5" />
              </IconButton>
            </div>
            {field.type === "choice" && (
              <input
                className={INPUT}
                aria-label={`Field ${index + 1} options`}
                placeholder="Options, separated by commas"
                value={(field.options ?? []).join(", ")}
                onChange={(event) => set(index, { options: event.target.value.split(",").map((option) => option.trim()).filter(Boolean) })}
              />
            )}
          </div>
        ))}
        <button type="button" className="self-start text-xs font-medium text-accent-ink hover:underline" onClick={() => onChange([...fields, { name: "", type: "text" }])}>
          + Another field
        </button>
      </div>
    </Field>
  );
}

/** The parameters of one kind of feature. */
function Parameters({ draft, set, options }: { draft: Draft; set: (patch: Record<string, unknown>) => void; options: EntityOption[] }): ReactNode {
  const option = options.find((candidate) => candidate.name === draft.entity);
  const entityChoice =
    "entity" in draft && draft.kind !== "field" ? (
      <Choice
        label="Records"
        testId="feature-entity"
        value={String(draft.entity ?? "")}
        options={options.map((candidate) => [candidate.name, `${candidate.plural}${candidate.present ? "" : " (new here)"}`])}
        onChange={(entity) => {
          const next = options.find((candidate) => candidate.name === entity);
          const patch: Record<string, unknown> = { entity };
          if ("field" in draft) {
            const types = draft.kind === "search" ? ["string"] : draft.kind === "filter" ? ["boolean", "enum"] : draft.kind === "calendar" ? ["date", "datetime"] : draft.kind === "board" ? ["enum"] : ANY_FIELD;
            patch.field = fieldsOf(next, types)[0];
          }
          if (draft.kind === "add") patch.fields = fieldsOf(next, ANY_FIELD);
          set(patch);
        }}
      />
    ) : null;
  const fieldChoice = (label: string, types: string[]): ReactNode => (
    <Choice label={label} testId="feature-field" value={draft.field as string | undefined} options={fieldsOf(option, types).map((name) => [name, humanize(name)])} onChange={(field) => set({ field })} empty={fieldsOf(option, types).length === 0 ? "No suitable field" : undefined} />
  );
  switch (draft.kind) {
    case "records":
      return (
        <>
          <Text label="Kind of record" placeholder="e.g. Book" value={draft.name as string} onChange={(name) => set({ name })} testId="records-name" />
          <FieldRows fields={draft.fields as FieldSpec[]} onChange={(fields) => set({ fields })} />
        </>
      );
    case "field": {
      const field = draft.field as FieldSpec;
      return <FieldRows fields={[field]} onChange={(fields) => set({ field: fields[0] ?? field })} />;
    }
    case "add":
      return (
        <>
          {entityChoice}
          <Pills label="Fields in the form" values={fieldsOf(option, ANY_FIELD)} selected={(draft.fields as string[] | undefined) ?? []} onChange={(fields) => set({ fields })} />
          <Text label="Button" placeholder={`Add ${String(draft.entity ?? "").toLowerCase()}`} value={draft.button as string | undefined} onChange={(button) => set({ button })} />
        </>
      );
    case "list":
      return (
        <>
          {entityChoice}
          <Choice label="Show as" value={(draft.display as string) ?? "list"} options={[["list", "List"], ["table", "Table"]]} onChange={(display) => set({ display })} />
          {draft.display === "table" ? (
            <Pills label="Columns" values={fieldsOf(option, ANY_FIELD)} selected={(draft.fields as string[] | undefined) ?? fieldsOf(option, ANY_FIELD)} onChange={(fields) => set({ fields })} />
          ) : (
            <Choice label="Checkbox" value={draft.toggle as string | undefined} empty="None" options={fieldsOf(option, ["boolean"]).map((name) => [name, humanize(name)])} onChange={(toggle) => set({ toggle: toggle || undefined })} />
          )}
          <div className="flex gap-4 text-sm text-ink">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft.editable !== false} onChange={(event) => set({ editable: event.target.checked })} /> Editable
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft.removable !== false} onChange={(event) => set({ removable: event.target.checked })} /> Removable
            </label>
          </div>
        </>
      );
    case "search":
      return (
        <>
          {entityChoice}
          {fieldChoice("Search in", ["string"])}
        </>
      );
    case "filter": {
      const definition = option?.fields[draft.field as string];
      const values: Array<[string, string]> = definition?.type === "boolean" ? [["true", "Yes"], ["false", "No"]] : (definition?.values ?? []).map((value) => [value, humanize(value)]);
      return (
        <>
          {entityChoice}
          {fieldChoice("By", ["boolean", "enum"])}
          <Choice label="How" value={draft.mode as string} options={[["tabs", "Tabs to switch between"], ["only", "Only ever show matching"]]} onChange={(mode) => set({ mode })} />
          {draft.mode === "only" && (
            <Choice
              label="Matching"
              value={draft.value === undefined ? "" : String(draft.value)}
              empty="Choose…"
              options={values}
              onChange={(value) => set({ value: definition?.type === "boolean" ? value === "true" : value })}
            />
          )}
        </>
      );
    }
    case "sort":
      return (
        <>
          {entityChoice}
          {fieldChoice("By", ANY_FIELD)}
          <Choice label="Order" value={(draft.direction as string) ?? "asc"} options={[["asc", "A → Z, smallest or earliest first"], ["desc", "Z → A, largest or latest first"]]} onChange={(direction) => set({ direction })} />
        </>
      );
    case "count": {
      const where = (draft.where as { field?: string; value?: unknown } | undefined) ?? {};
      const definition = where.field ? option?.fields[where.field] : undefined;
      return (
        <>
          {entityChoice}
          <Text label="Label" value={draft.label as string | undefined} onChange={(label) => set({ label })} />
          <Choice label="Only count" value={where.field ?? ""} empty="All of them" options={fieldsOf(option, ["boolean", "enum"]).map((name) => [name, `where ${humanize(name).toLowerCase()} is…`])} onChange={(field) => set({ where: field ? { field, value: option?.fields[field]?.type === "boolean" ? true : option?.fields[field]?.values?.[0] } : undefined })} />
          {where.field && (
            <Choice
              label="is"
              value={String(where.value)}
              options={definition?.type === "boolean" ? [["true", "Yes"], ["false", "No"]] : (definition?.values ?? []).map((value) => [value, humanize(value)])}
              onChange={(value) => set({ where: { field: where.field, value: definition?.type === "boolean" ? value === "true" : value } })}
            />
          )}
        </>
      );
    }
    case "calendar":
      return (
        <>
          {entityChoice}
          {fieldChoice("By date", ["date", "datetime"])}
        </>
      );
    case "board":
      return (
        <>
          {entityChoice}
          {fieldChoice("Columns from", ["enum"])}
        </>
      );
    case "share":
      return entityChoice;
    case "tool":
      return <Choice label="Which" testId="feature-tool" value={draft.tool as string} options={TOOL_NAMES.map((name) => [name, (TOOLS[name] as { noun: string }).noun])} onChange={(tool) => set({ tool })} />;
    case "document":
      return (
        <Choice
          label="Editor"
          value={draft.editor as string}
          options={DOCUMENT_EDITORS.map((editor) => [editor, { text: "Plain text", richtext: "Word processor", code: "Code editor", spreadsheet: "Spreadsheet", drawing: "Drawing", sequencer: "Music sequencer" }[editor]])}
          onChange={(editor) => set({ editor })}
        />
      );
    case "title":
      return (
        <>
          <Text label="Title" value={draft.text as string} onChange={(text) => set({ text })} testId="feature-title-text" />
          <Text label="Subtitle" value={draft.subtitle as string | undefined} onChange={(subtitle) => set({ subtitle })} />
        </>
      );
    default:
      return null;
  }
}

/** Adds or changes one feature, showing exactly what will happen first. */
function FeatureForm(props: { app: AppHandle; initial: Draft; feature?: PresentFeature; options: EntityOption[]; onDone: () => void; heading: string }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(props.app.store);
  const workspace = studio.workspace;
  const [draft, setDraft] = useState<Draft>(props.initial);
  const compiled = useMemo(
    () => (workspace ? compileDraft(draft, props.feature, { graph, registry: workspace.registry, schemas: workspace.schemas }) : undefined),
    [draft, graph, workspace, props.feature],
  );
  const ready = compiled && compiled.issues.length === 0 && compiled.operations.length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-canvas/60 p-3" data-testid="feature-form" data-kind={draft.kind}>
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="text-accent">{ICONS[draft.kind === "field" ? "records" : draft.kind]}</span>
        {props.heading}
      </div>
      <Parameters draft={draft} set={(patch) => setDraft((current) => ({ ...current, ...patch }))} options={props.options} />
      <div className="rounded-lg bg-surface px-3 py-2 text-xs leading-relaxed" data-testid="feature-preview" aria-live="polite">
        {!compiled ? null : compiled.issues.length > 0 ? (
          <span className="text-warning">{compiled.issues[0]}</span>
        ) : compiled.operations.length === 0 ? (
          <span className="text-ink-faint">That is already how it is.</span>
        ) : (
          <>
            <span className="font-medium text-ink-soft">This will:</span>
            <ul className="mt-0.5 list-disc pl-4 text-ink">
              {compiled.described.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {compiled.described.length === 0 && <li>Make the change</li>}
            </ul>
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={props.onDone} data-testid="feature-cancel">
          Cancel
        </Button>
        <Button
          size="sm"
          tone="primary"
          disabled={!ready}
          data-testid="feature-apply"
          onClick={() => {
            if (compiled && studio.applyFeatureChange(props.app.id, compiled, props.heading)) props.onDone();
          }}
        >
          {props.feature ? "Save" : "Add"}
        </Button>
      </div>
    </div>
  );
}

// ── the panel ────────────────────────────────────────────────────────────

/**
 * The selected application as a list of features — what it keeps and what it
 * does — to change one feature at a time without touching the wiring.
 */
export function FeaturePanel({ app }: { app: AppHandle }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(app.store);
  const schemas = studio.workspace?.schemas;
  const read = useMemo(() => (schemas ? inventory(graph, schemas) : undefined), [graph, schemas]);
  const options = useMemo(() => (read && schemas ? entityOptions(read.entities, schemas) : []), [read, schemas]);
  const [editing, setEditing] = useState<{ key: string; draft: Draft; heading: string } | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  if (!read || !schemas) return null;
  const title = String(Object.values(graph.objects).find((object) => object.type === "ui.window")?.properties.title ?? graph.metadata.name);

  const remove = (feature: PresentFeature): void => {
    const removal = removeFeature(graph, feature);
    if (removal.operations.length === 0) return;
    if (studio.applyFeatureChange(app.id, { operations: removal.operations, schemas: [], issues: [] }, `Remove: ${feature.label}`)) {
      studio.toast({
        tone: "info",
        message: `Removed “${feature.label}”${removal.alsoRemoves.length ? `, and with it ${removal.alsoRemoves.join(" and ")}` : ""}. Undo brings it back.`,
      });
    }
  };

  return (
    <aside className="flex w-[400px] shrink-0 animate-fade flex-col border-l border-line bg-surface" data-testid="feature-panel">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <ListChecks className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Features</h2>
          <p className="truncate text-xs text-ink-soft">What “{graph.metadata.name}” does — change it one feature at a time.</p>
        </div>
        <IconButton label={app.store.undoLabel ? `Undo: ${app.store.undoLabel}` : "Undo"} disabled={!app.store.canUndo} onClick={() => app.store.undo()} data-testid="feature-undo">
          <Undo2 className="size-4" />
        </IconButton>
        <IconButton label="Close features" onClick={() => studio.setFeaturesOpen(false)}>
          <X className="size-4" />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {read.entities.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Records it keeps</h3>
            <ul className="flex flex-col gap-1.5">
              {read.entities.map((entity) => {
                const hasForm = read.features.some((feature) => feature.kind === "add" && feature.entity === entity.name);
                const key = `field:${entity.sourceId}`;
                return (
                  <li key={entity.sourceId} className="rounded-xl border border-line px-3 py-2" data-testid="entity-row" data-entity={entity.name}>
                    <div className="flex items-center gap-2">
                      <Database className="size-4 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 text-sm font-medium text-ink">{entity.plural}</span>
                      {entity.shared && <Badge>shared</Badge>}
                      {!entity.editable && <Badge>{graph.objects[entity.sourceId]?.type === "data.reference" ? "from another app" : "built by hand"}</Badge>}
                      {entity.editable && hasForm && (
                        <button
                          type="button"
                          className="text-xs font-medium text-accent-ink hover:underline"
                          data-testid="entity-add-field"
                          onClick={() => setEditing({ key, heading: `Add a field to ${entity.plural.toLowerCase()}`, draft: { kind: "field", entity: entity.name, field: { name: "", type: "text" } } })}
                        >
                          + Field
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 pl-6 text-xs text-ink-soft">{Object.keys(entity.fields).map((field) => humanize(field).toLowerCase()).join(", ")}</p>
                    {editing?.key === key && (
                      <div className="mt-2">
                        <FeatureForm app={app} initial={editing.draft} heading={editing.heading} options={options} onDone={() => setEditing(undefined)} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="mb-5">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">What it does</h3>
          {read.features.length === 0 && <p className="text-sm text-ink-faint">Nothing yet. Add a feature below.</p>}
          <ul className="flex flex-col gap-1.5">
            {read.features.map((feature) => (
              <li key={feature.key} className="rounded-xl border border-line px-3 py-2" data-testid="feature-row" data-kind={feature.kind} data-label={feature.label}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-ink-faint">{ICONS[feature.kind]}</span>
                  <span className="min-w-0 flex-1 text-sm leading-snug text-ink">{feature.label}</span>
                  {feature.editable && (
                    <IconButton label={`Change: ${feature.label}`} onClick={() => setEditing({ key: feature.key, heading: `Change: ${feature.label}`, draft: draftFrom(feature.spec) })} data-testid="feature-change">
                      <Pencil className="size-3.5" />
                    </IconButton>
                  )}
                  {feature.locked ? (
                    <span className="grid size-7 place-items-center text-ink-faint" title={feature.locked}>
                      <Lock className="size-3.5" />
                    </span>
                  ) : (
                    <IconButton label={`Remove: ${feature.label}`} onClick={() => remove(feature)} data-testid="feature-remove">
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  )}
                </div>
                {editing?.key === feature.key && (
                  <div className="mt-2">
                    <FeatureForm app={app} feature={feature} initial={editing.draft} heading={editing.heading} options={options} onDone={() => setEditing(undefined)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {read.other.length > 0 && (
          <section className="mb-5 rounded-xl bg-subtle/70 px-3 py-2.5 text-xs leading-relaxed text-ink-soft" data-testid="features-other">
            {read.other.length === 1 ? "One part was" : `${read.other.length} parts were`} built by hand and {read.other.length === 1 ? "is" : "are"} not shown as features. They keep working.
            <button type="button" className="ml-1 inline-flex items-center gap-1 font-medium text-accent-ink hover:underline" onClick={() => studio.setMode("build")}>
              <Blocks className="size-3" /> See them in Build mode
            </button>
          </section>
        )}

        {editing?.key === "new" ? (
          <FeatureForm app={app} initial={editing.draft} heading={editing.heading} options={options} onDone={() => setEditing(undefined)} />
        ) : picking ? (
          <section data-testid="feature-picker">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Add a feature</h3>
              <button type="button" className="text-xs text-ink-soft hover:text-ink" onClick={() => setPicking(false)}>
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {ADDABLE_FEATURES.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  data-testid={`feature-kind-${entry.kind}`}
                  title={entry.hint}
                  onClick={() => {
                    setPicking(false);
                    setEditing({ key: "new", heading: entry.kind === "records" ? "Keep a new kind of record" : `Add: ${entry.label.toLowerCase()}`, draft: defaultDraft(entry.kind, options, title) });
                  }}
                  className="flex items-start gap-2 rounded-lg border border-line p-2 text-left hover:border-accent hover:bg-accent-soft/40"
                >
                  <span className="mt-0.5 text-accent">{ICONS[entry.kind]}</span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-ink">{entry.label}</span>
                    <span className="block text-[11px] leading-snug text-ink-soft">{entry.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <Button icon={<Plus className="size-3.5" />} onClick={() => setPicking(true)} data-testid="feature-add" className="w-full">
            Add a feature
          </Button>
        )}
      </div>
    </aside>
  );
}
