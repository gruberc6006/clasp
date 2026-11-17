import { isClaspError, isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import { Check, Lock, Trash2, X } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppView } from "./AppView";
import { editorRenderers } from "./editors";
import { gameRenderers } from "./games";
import { toolRenderers } from "./tools";
import { FramedContext, LayoutContext, type ComponentRenderer, type RendererProps } from "./context";

function text(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function rows(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Attributes every rendered primitive carries, for tools and tests. */
function marks(view: RendererProps["view"]): Record<string, string> {
  return {
    "data-clasp-id": view.object.id,
    "data-clasp-type": view.object.type,
    "data-clasp-name": view.object.metadata.name ?? "",
  };
}

const GAP: Record<string, string> = { none: "gap-0", small: "gap-2", medium: "gap-4", large: "gap-6" };
const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };
const JUSTIFY: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" };

function Stack(props: {
  direction: string;
  gap: string;
  align?: string;
  justify?: string;
  className?: string;
  children: ReactNode;
  attributes?: Record<string, string>;
}): ReactNode {
  const row = props.direction === "row";
  const inRow = useContext(LayoutContext) === "row";
  return (
    <div
      {...props.attributes}
      className={cx(
        "flex min-w-0",
        row ? "flex-row flex-wrap" : "flex-col",
        GAP[props.gap] ?? GAP.medium,
        ALIGN[props.align ?? (row ? "center" : "stretch")],
        JUSTIFY[props.justify ?? "start"],
        inRow && "flex-1",
        props.className,
      )}
    >
      <LayoutContext.Provider value={row ? "row" : "column"}>{props.children}</LayoutContext.Provider>
    </div>
  );
}

const Window: ComponentRenderer = ({ view, childNodes }) => {
  const framed = useContext(FramedContext);
  const title = text(view.input("title"));
  const subtitle = text(view.props.subtitle);
  if (framed) {
    // The host's window chrome shows the title; draw only the contents.
    return (
      <div {...marks(view)} className="flex flex-col gap-5 p-5">
        {subtitle && <p className="-mb-1 text-sm text-ink-soft">{subtitle}</p>}
        <LayoutContext.Provider value="column">{childNodes}</LayoutContext.Provider>
      </div>
    );
  }
  const width = { narrow: "max-w-md", regular: "max-w-xl", wide: "max-w-4xl" }[text(view.props.width, "regular")] ?? "max-w-xl";
  return (
    <section {...marks(view)} className={cx("mx-auto w-full animate-rise rounded-2xl border border-line bg-surface shadow-window", width)}>
      {(title || subtitle) && (
        <header className="border-b border-line px-6 py-5">
          {title && <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>}
          {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
        </header>
      )}
      <div className="flex flex-col gap-5 p-6">
        <LayoutContext.Provider value="column">{childNodes}</LayoutContext.Provider>
      </div>
    </section>
  );
};

const Container: ComponentRenderer = ({ view, childNodes }) => {
  const surface = text(view.props.surface, "none");
  const title = text(view.props.title);
  return (
    <Stack
      attributes={marks(view)}
      direction={text(view.props.direction, "column")}
      gap={text(view.props.gap, "medium")}
      align={text(view.props.align) || undefined}
      justify={text(view.props.justify) || undefined}
      className={cx(surface === "card" && "rounded-xl border border-line bg-surface p-4", surface === "subtle" && "rounded-xl bg-subtle p-4")}
    >
      {title && <div className="w-full text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</div>}
      {childNodes}
    </Stack>
  );
};

const TEXT_STYLES: Record<string, string> = {
  title: "text-2xl font-semibold tracking-tight text-ink",
  heading: "text-base font-semibold text-ink",
  body: "text-sm leading-relaxed text-ink",
  muted: "text-sm text-ink-soft",
  label: "text-xs font-medium uppercase tracking-wide text-ink-faint",
  stat: "text-3xl font-semibold tabular-nums tracking-tight text-ink",
};

const Text: ComponentRenderer = ({ view }) => {
  const variant = text(view.props.variant, "body");
  const caption = text(view.props.caption);
  const display = text(view.output("display"));
  return (
    <div {...marks(view)} className="min-w-0">
      <div className={TEXT_STYLES[variant] ?? TEXT_STYLES.body}>{display}</div>
      {caption && <div className="mt-1 text-xs font-medium text-ink-soft">{caption}</div>}
    </div>
  );
};

const BUTTON_STYLES: Record<string, string> = {
  primary: "bg-accent text-white hover:bg-accent-strong shadow-sm",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-subtle",
  ghost: "text-ink-soft hover:bg-subtle hover:text-ink",
  danger: "border border-danger/30 bg-surface text-danger hover:bg-danger-soft",
};

const Button: ComponentRenderer = ({ view, app }) => {
  const disabled = view.input("disabled") === true;
  return (
    <button
      {...marks(view)}
      type="button"
      disabled={disabled}
      onClick={() => app.runtime.interact(view.object.id, "press")}
      className={cx(
        "inline-flex h-9 shrink-0 items-center justify-center rounded-lg px-3.5 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_STYLES[text(view.props.variant, "secondary")] ?? BUTTON_STYLES.secondary,
      )}
    >
      {text(view.input("label"), "Button")}
    </button>
  );
};

const FIELD =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint transition-shadow focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-50";

function Labelled(props: { view: RendererProps["view"]; children: ReactNode }): ReactNode {
  const label = text(props.view.props.label);
  const inRow = useContext(LayoutContext) === "row";
  return (
    <label {...marks(props.view)} className={cx("flex min-w-0 flex-col gap-1.5", inRow && "flex-1")}>
      {label && <span className="text-xs font-medium text-ink-soft">{label}</span>}
      {props.children}
    </label>
  );
}

const TextInput: ComponentRenderer = ({ view, app }) => {
  const id = view.object.id;
  const common = {
    value: text(view.output("value")),
    placeholder: text(view.props.placeholder),
    disabled: view.input("disabled") === true,
    "aria-label": text(view.props.label) || text(view.props.placeholder) || view.object.metadata.name,
  };
  return (
    <Labelled view={view}>
      {view.props.multiline === true ? (
        <textarea
          {...common}
          rows={typeof view.props.rows === "number" ? Math.min(60, Math.max(2, view.props.rows)) : 3}
          className={cx(FIELD, "h-auto py-2")}
          onChange={(event) => app.runtime.interact(id, "input", event.target.value)}
        />
      ) : (
        <input
          {...common}
          type={["date", "time", "email", "url"].includes(text(view.props.inputType)) ? text(view.props.inputType) : "text"}
          className={FIELD}
          onChange={(event) => app.runtime.interact(id, "input", event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) app.runtime.interact(id, "submit");
          }}
        />
      )}
    </Labelled>
  );
};

const NumberInput: ComponentRenderer = ({ view, app }) => {
  const id = view.object.id;
  const value = view.output("value");
  const bound = (name: string): number | undefined => (typeof view.props[name] === "number" ? (view.props[name] as number) : undefined);
  return (
    <Labelled view={view}>
      <input
        type="number"
        className={FIELD}
        value={typeof value === "number" ? value : ""}
        min={bound("min")}
        max={bound("max")}
        step={bound("step")}
        placeholder={text(view.props.placeholder)}
        disabled={view.input("disabled") === true}
        aria-label={text(view.props.label) || view.object.metadata.name}
        onChange={(event) => app.runtime.interact(id, "input", event.target.value === "" ? null : Number(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") app.runtime.interact(id, "submit");
        }}
      />
    </Labelled>
  );
};

const Select: ComponentRenderer = ({ view, app }) => {
  const options = Array.isArray(view.props.options)
    ? view.props.options.flatMap((entry) =>
        typeof entry === "string" ? [{ label: entry, value: entry }] : isJsonObject(entry) && typeof entry.value === "string" ? [{ label: text(entry.label, entry.value), value: entry.value }] : [],
      )
    : [];
  return (
    <Labelled view={view}>
      <select
        className={FIELD}
        value={text(view.output("value"))}
        disabled={view.input("disabled") === true}
        aria-label={text(view.props.label) || view.object.metadata.name}
        onChange={(event) => app.runtime.interact(view.object.id, "choose", event.target.value)}
      >
        <option value="">{text(view.props.placeholder, "Choose…")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Labelled>
  );
};

function Tick(props: { checked: boolean; onToggle: () => void; label: string; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      className={cx(
        "grid size-[18px] shrink-0 place-items-center rounded-md border transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50",
        props.checked ? "border-accent bg-accent text-white" : "border-line-strong bg-surface hover:border-accent",
      )}
    >
      {props.checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

const Checkbox: ComponentRenderer = ({ view, app }) => {
  const checked = view.output("value") === true;
  const label = text(view.props.label);
  return (
    <div {...marks(view)} className="flex items-center gap-2.5">
      <Tick
        checked={checked}
        label={label || view.object.metadata.name || "Checkbox"}
        disabled={view.input("disabled") === true}
        onToggle={() => app.runtime.interact(view.object.id, "toggle")}
      />
      {label && <span className="text-sm text-ink">{label}</span>}
    </div>
  );
};

/** Text that turns into an input when clicked; commits on Enter or blur. */
function EditableText(props: { value: string; label: string; className?: string; onCommit: (value: string) => void }): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft !== null) input.current?.focus();
  }, [draft !== null]);
  if (draft === null) {
    return (
      <button
        type="button"
        title="Click to edit"
        aria-label={`Edit ${props.label}`}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(props.value);
        }}
        className={cx("min-w-0 flex-1 cursor-text truncate rounded px-1 py-0.5 text-left hover:bg-subtle", props.className)}
      >
        {props.value || <span className="text-ink-faint">Empty</span>}
      </button>
    );
  }
  const commit = (): void => {
    const next = draft.trim();
    setDraft(null);
    if (next !== "" && next !== props.value) props.onCommit(next);
  };
  return (
    <input
      ref={input}
      value={draft}
      aria-label={props.label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
      className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0.5 text-sm text-ink outline-none ring-3 ring-accent/15"
    />
  );
}

function Empty(props: { children: ReactNode }): ReactNode {
  return <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-faint">{props.children}</div>;
}

const List: ComponentRenderer = ({ view, app }) => {
  const id = view.object.id;
  const items = rows(view.input("items"));
  const titleField = text(view.props.titleField, "title");
  const subtitleField = text(view.props.subtitleField);
  const checkField = text(view.props.checkField);
  const editable = view.props.editable === true;
  const removable = view.props.removable === true;
  const selectable = view.props.selectable === true;
  const selected = view.output("selected");
  const selectedId = isJsonObject(selected) ? selected.id : undefined;

  if (items.length === 0) {
    return (
      <div {...marks(view)}>
        <Empty>{text(view.props.emptyText, "Nothing here yet.")}</Empty>
      </div>
    );
  }
  return (
    <ul {...marks(view)} className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {items.map((row) => {
        const rowId = String(row.id);
        const title = text(row[titleField]);
        const done = checkField !== "" && row[checkField] === true;
        return (
          <li
            key={rowId}
            data-clasp-row={rowId}
            data-checked={done ? "true" : "false"}
            onClick={selectable ? () => app.runtime.interact(id, "select", { id: rowId }) : undefined}
            className={cx(
              "group flex min-h-11 items-center gap-3 px-3.5 py-2 text-sm transition-colors",
              selectable && "cursor-pointer hover:bg-subtle",
              selectedId === rowId && "bg-accent-soft",
            )}
          >
            {checkField && (
              <Tick checked={done} label={`${done ? "Mark active" : "Mark complete"}: ${title}`} onToggle={() => app.runtime.interact(id, "toggle", { id: rowId })} />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              {editable ? (
                <EditableText
                  value={title}
                  label={title}
                  className={cx(done && "text-ink-faint line-through")}
                  onCommit={(value) => app.runtime.interact(id, "edit", { id: rowId, value })}
                />
              ) : (
                <span className={cx("truncate", done ? "text-ink-faint line-through" : "text-ink")}>{title}</span>
              )}
              {subtitleField && <span className="truncate text-xs text-ink-soft">{text(row[subtitleField])}</span>}
            </div>
            {removable && (
              <button
                type="button"
                aria-label={`Delete ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  app.runtime.interact(id, "remove", { id: rowId });
                }}
                className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 transition hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

function cell(value: JsonValue | undefined): ReactNode {
  if (value === true) return <Check className="size-4 text-success" aria-label="Yes" />;
  if (value === false || value === undefined || value === null) return <span className="text-ink-faint">—</span>;
  if (typeof value === "object") return <code className="text-xs text-ink-soft">{JSON.stringify(value)}</code>;
  return String(value);
}

const Table: ComponentRenderer = ({ view, app }) => {
  const id = view.object.id;
  const data = rows(view.input("rows"));
  const configured = Array.isArray(view.props.columns) ? view.props.columns.filter(isJsonObject) : [];
  const columns =
    configured.length > 0
      ? configured.map((column) => ({ field: text(column.field), label: text(column.label) || text(column.field), editable: column.editable === true }))
      : Object.keys(data[0] ?? {})
          .filter((key) => key !== "id")
          .map((key) => ({ field: key, label: key, editable: false }));
  const removable = view.props.removable === true;

  if (data.length === 0) {
    return (
      <div {...marks(view)}>
        <Empty>{text(view.props.emptyText, "No rows.")}</Empty>
      </div>
    );
  }
  return (
    <div {...marks(view)} className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-subtle/60">
            {columns.map((column) => (
              <th key={column.field} className="px-3.5 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                {column.label}
              </th>
            ))}
            {text(view.props.actionLabel) && <th className="w-20" />}
            {removable && <th className="w-10" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((row) => {
            const rowId = String(row.id);
            return (
              <tr key={rowId} data-clasp-row={rowId} className="group">
                {columns.map((column) => (
                  <td key={column.field} className="px-3.5 py-2.5 align-middle text-ink">
                    {column.editable && typeof row[column.field] !== "boolean" ? (
                      <EditableText
                        value={text(row[column.field])}
                        label={`${column.label} of row`}
                        onCommit={(value) => app.runtime.interact(id, "edit", { id: rowId, field: column.field, value })}
                      />
                    ) : (
                      cell(row[column.field])
                    )}
                  </td>
                ))}
                {text(view.props.actionLabel) && (
                  <td className="px-2 text-right">
                    <button
                      type="button"
                      data-testid="row-action"
                      onClick={() => app.runtime.interact(id, "rowAction", { id: rowId })}
                      className="inline-flex h-7 items-center rounded-md border border-line px-2.5 text-xs font-medium text-ink hover:bg-subtle"
                    >
                      {text(view.props.actionLabel)}
                    </button>
                  </td>
                )}
                {removable && (
                  <td className="px-2 text-right">
                    <button
                      type="button"
                      aria-label="Delete row"
                      onClick={() => app.runtime.interact(id, "remove", { id: rowId })}
                      className="grid size-7 place-items-center rounded-md text-ink-faint opacity-0 transition hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const Form: ComponentRenderer = ({ view, childNodes }) => (
  <Stack attributes={{ ...marks(view), role: "group" }} direction={text(view.props.direction, "column")} gap={text(view.props.gap, "medium")}>
    {childNodes}
  </Stack>
);

const Tabs: ComponentRenderer = ({ view, app, childNodes }) => {
  const options = Array.isArray(view.props.options) ? view.props.options.filter(isJsonObject) : [];
  const index = typeof view.output("index") === "number" ? (view.output("index") as number) : 0;
  return (
    <div {...marks(view)} className="flex min-w-0 flex-col gap-4">
      <div role="tablist" className="inline-flex w-fit gap-1 rounded-lg bg-subtle p-1">
        {options.map((option, position) => (
          <button
            key={position}
            type="button"
            role="tab"
            aria-selected={position === index}
            onClick={() => app.runtime.interact(view.object.id, "select", position)}
            className={cx(
              "h-7 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
              position === index ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink",
            )}
          >
            {text(option.label, `Option ${position + 1}`)}
          </button>
        ))}
      </div>
      {childNodes.length > 0 && <div>{childNodes[Math.min(index, childNodes.length - 1)]}</div>}
    </div>
  );
};

const Modal: ComponentRenderer = ({ view, app, childNodes }) => {
  if (view.output("isOpen") !== true) return null;
  const title = text(view.props.title);
  const dismiss = (): void => app.runtime.interact(view.object.id, "dismiss");
  return (
    <div {...marks(view)} className="fixed inset-0 z-40 grid animate-fade place-items-center bg-black/35 p-6" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title || "Dialog"}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md animate-rise rounded-2xl border border-line bg-surface shadow-pop"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close" onClick={dismiss} className="grid size-7 place-items-center rounded-md text-ink-soft hover:bg-subtle">
            <X className="size-4" />
          </button>
        </header>
        <div className="flex flex-col gap-4 p-5">{childNodes}</div>
      </div>
    </div>
  );
};

const EMBED_MESSAGES: Record<string, string> = {
  unbound: "Choose an application to embed.",
  unresolved: "The embedded application is not installed in this workspace.",
  "needs-access": "This application needs your permission to show it.",
  pending: "Waiting for your decision…",
  connected: "The embedded application exposes no view to show.",
};

const Embed: ComponentRenderer = ({ view, app, host }) => {
  const targetId = text(view.props.appId);
  const status = text(view.output("status"), "unbound");
  let resolved: ReturnType<NonNullable<typeof host.resolveView>> | undefined;
  let problem: string | undefined;
  if (targetId && host.resolveView) {
    try {
      resolved = host.resolveView(app.id, targetId, text(view.props.view) || undefined);
    } catch (error) {
      problem = isClaspError(error) && error.code === "NOT_FOUND" && status === "connected" ? error.message : undefined;
    }
  }
  const name = (targetId && host.appName?.(targetId)) || "another application";
  if (resolved) {
    return (
      <div {...marks(view)} data-clasp-embeds={resolved.app.id} className="rounded-xl border border-line bg-canvas/60 p-3">
        <div className="mb-2 px-1 text-xs font-medium text-ink-faint">
          {name} · {resolved.name}
        </div>
        <AppView app={resolved.app} host={host} rootId={resolved.rootId} />
      </div>
    );
  }
  return (
    <div {...marks(view)} data-clasp-status={status} className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong p-4">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <Lock className="size-4 shrink-0" />
        <span>
          <span className="font-medium text-ink">{name}</span> — {problem ?? EMBED_MESSAGES[status] ?? status}
        </span>
      </div>
      {status === "needs-access" && (
        <button
          type="button"
          onClick={() => app.runtime.invoke(view.object.id, "requestAccess")}
          className={cx("inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium", BUTTON_STYLES.primary)}
        >
          Request access
        </button>
      )}
    </div>
  );
};

/** Renderers for the built-in interface primitives, keyed by component type. */
export const defaultRenderers: Record<string, ComponentRenderer> = {
  "ui.window": Window,
  "ui.container": Container,
  "ui.text": Text,
  "ui.button": Button,
  "ui.textInput": TextInput,
  "ui.numberInput": NumberInput,
  "ui.select": Select,
  "ui.checkbox": Checkbox,
  "ui.list": List,
  "ui.table": Table,
  "ui.form": Form,
  "ui.tabs": Tabs,
  "ui.modal": Modal,
  "app.embed": Embed,
  ...editorRenderers,
  ...toolRenderers,
  ...gameRenderers,
};
