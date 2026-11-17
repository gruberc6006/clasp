import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asRows, asText, fillTemplate, isBlank, pure } from "./helpers";

/**
 * Interface primitives. Each definition here is only the *behavioral* half:
 * state, events and actions. How it looks is the renderer's business
 * (`@clasp/renderer-react`), which talks to these through `interactions`.
 */

const window: ComponentDefinition = {
  type: "ui.window",
  version: 1,
  category: "interface",
  title: "Window",
  description: "The top-level surface of an application. Put every visible element inside one.",
  container: true,
  properties: [
    { name: "title", type: "string", title: "Title", description: "Shown in the window header." },
    { name: "subtitle", type: "string", title: "Subtitle" },
    { name: "width", type: "enum", options: ["narrow", "regular", "wide"], default: "regular", title: "Width" },
  ],
  inputs: [{ name: "title", type: "string" }],
  outputs: [],
  events: [],
  actions: [],
  create: () => undefined,
};

const container: ComponentDefinition = {
  type: "ui.container",
  version: 1,
  category: "interface",
  title: "Container",
  description: "Groups and lays out child elements in a row or a column.",
  container: true,
  properties: [
    { name: "direction", type: "enum", options: ["column", "row"], default: "column", title: "Direction" },
    { name: "gap", type: "enum", options: ["none", "small", "medium", "large"], default: "medium", title: "Spacing" },
    { name: "align", type: "enum", options: ["start", "center", "end", "stretch"], default: "stretch", title: "Align" },
    { name: "justify", type: "enum", options: ["start", "center", "end", "between"], default: "start", title: "Distribute" },
    { name: "surface", type: "enum", options: ["none", "card", "subtle"], default: "none", title: "Surface" },
    { name: "title", type: "string", title: "Title" },
  ],
  inputs: [VISIBLE],
  outputs: [],
  events: [],
  actions: [],
  create: () => undefined,
};

const text: ComponentDefinition = {
  type: "ui.text",
  version: 1,
  category: "interface",
  title: "Text",
  description:
    'Displays text. Connect a value to the "value" input and use {value} in the text to show it, e.g. "{value} tasks left".',
  properties: [
    { name: "text", type: "text", default: "", title: "Text", description: "May contain {value}, or {field} when value is a record." },
    { name: "variant", type: "enum", options: ["title", "heading", "body", "muted", "label", "stat"], default: "body", title: "Style" },
    { name: "caption", type: "string", title: "Caption", description: "Small label shown with the text (useful with the stat style)." },
  ],
  inputs: [
    { name: "text", type: "string", description: "Overrides the text property." },
    { name: "value", type: "any", description: "Value substituted for {value}." },
    VISIBLE,
  ],
  outputs: [{ name: "display", type: "string", description: "The text as displayed." }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const source = asText(ctx.input("text"));
    const value = ctx.input("value");
    const display = source === "" && value !== undefined && value !== null ? fillTemplate("{value}", value) : fillTemplate(source, value);
    ctx.setOutput("display", display);
  }),
};

const button: ComponentDefinition = {
  type: "ui.button",
  version: 1,
  category: "interface",
  title: "Button",
  description: 'Emits "click" when pressed. Connect click to an action, e.g. a form\'s submit.',
  properties: [
    { name: "label", type: "string", default: "Button", title: "Label" },
    { name: "variant", type: "enum", options: ["primary", "secondary", "ghost", "danger"], default: "secondary", title: "Style" },
  ],
  inputs: [{ name: "label", type: "string" }, { name: "disabled", type: "boolean" }, VISIBLE],
  outputs: [],
  events: [{ name: "click", description: "The button was pressed." }],
  actions: [],
  create: (ctx) => ({
    interactions: {
      press: () => {
        if (ctx.input("disabled") !== true) ctx.emit("click");
      },
    },
  }),
};

function inputComponent(config: {
  type: string;
  title: string;
  description: string;
  kind: "string" | "number";
  extra: ComponentDefinition["properties"];
}): ComponentDefinition {
  const empty: JsonValue = config.kind === "string" ? "" : null;
  const coerce = (value: JsonValue | undefined): JsonValue => {
    if (config.kind === "string") return asText(value);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return null;
  };
  return {
    type: config.type,
    version: 1,
    category: "interface",
    title: config.title,
    description: config.description,
    properties: [
      { name: "label", type: "string", title: "Label" },
      { name: "placeholder", type: "string", title: "Placeholder" },
      { name: "field", type: "string", title: "Field name", description: "Name under which an enclosing form submits this value." },
      { name: "value", type: config.kind === "string" ? "string" : "number", title: "Initial value" },
      { name: "required", type: "boolean", default: false, title: "Required", description: "An enclosing form refuses to submit while this is empty." },
      ...config.extra,
    ],
    inputs: [{ name: "disabled", type: "boolean" }, VISIBLE],
    outputs: [{ name: "value", type: config.kind, description: "The current value." }],
    events: [
      { name: "changed", payload: config.kind, description: "The user changed the value." },
      { name: "submitted", payload: config.kind, description: "The user pressed Enter." },
    ],
    actions: [
      { name: "set", payload: config.kind, description: "Replaces the value." },
      { name: "clear", description: "Resets to the initial value." },
    ],
    create: (ctx) => {
      const initial = (): JsonValue => (ctx.props.value === undefined ? empty : coerce(ctx.props.value));
      const write = (value: JsonValue, announce: boolean): void => {
        ctx.setState("value", value);
        ctx.setOutput("value", value);
        if (announce) ctx.emit("changed", value);
      };
      write(ctx.getState("value") ?? initial(), false);
      return {
        actions: {
          set: (payload) => write(coerce(payload), false),
          clear: () => write(initial(), false),
        },
        interactions: {
          input: (payload) => write(coerce(payload), true),
          submit: () => ctx.emit("submitted", ctx.output("value") ?? empty),
        },
      };
    },
  };
}

const textInput = inputComponent({
  type: "ui.textInput",
  title: "Text input",
  description: 'A single-line text field. Outputs its current "value". Inside a form, set "field" to the record field it fills.',
  kind: "string",
  extra: [
    { name: "multiline", type: "boolean", default: false, title: "Multiple lines" },
    { name: "rows", type: "number", default: 3, title: "Visible lines", description: "Height of a multi-line field." },
    {
      name: "inputType",
      type: "enum",
      options: ["text", "date", "time", "email", "url"],
      default: "text",
      title: "Kind of text",
      description: "date produces YYYY-MM-DD, as clasp date fields expect.",
    },
  ],
});

const numberInput = inputComponent({
  type: "ui.numberInput",
  title: "Number input",
  description: 'A numeric field. Outputs its current "value" (empty is null).',
  kind: "number",
  extra: [
    { name: "min", type: "number", title: "Minimum" },
    { name: "max", type: "number", title: "Maximum" },
    { name: "step", type: "number", title: "Step" },
  ],
});

function optionList(value: JsonValue | undefined): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ label: entry, value: entry }];
    if (isJsonObject(entry) && typeof entry.value === "string") return [{ label: asText(entry.label, entry.value), value: entry.value }];
    return [];
  });
}

const select: ComponentDefinition = {
  type: "ui.select",
  version: 1,
  category: "interface",
  title: "Select",
  description: 'A drop-down to choose one of several options. Outputs the chosen "value". Inside a form, set "field" to the record field it fills.',
  properties: [
    { name: "label", type: "string", title: "Label" },
    { name: "options", type: "list", default: [], title: "Options", description: 'List of strings, or { "label", "value" } objects.' },
    { name: "placeholder", type: "string", default: "Choose…", title: "Placeholder" },
    { name: "field", type: "string", title: "Field name", description: "Name under which an enclosing form submits this value." },
    { name: "value", type: "string", title: "Initial value" },
    { name: "required", type: "boolean", default: false, title: "Required" },
  ],
  inputs: [{ name: "disabled", type: "boolean" }, VISIBLE],
  outputs: [{ name: "value", type: "string" }],
  events: [{ name: "changed", payload: "string" }],
  actions: [
    { name: "set", payload: "string" },
    { name: "clear", description: "Resets to the initial value." },
  ],
  create: (ctx) => {
    const initial = (): JsonValue => (typeof ctx.props.value === "string" ? ctx.props.value : null);
    const write = (value: JsonValue, announce: boolean): void => {
      const allowed = value === null || optionList(ctx.props.options).some((option) => option.value === value);
      const next = allowed ? value : null;
      ctx.setState("value", next);
      ctx.setOutput("value", next ?? undefined);
      if (announce) ctx.emit("changed", next);
    };
    write(ctx.getState("value") ?? initial(), false);
    return {
      actions: {
        set: (payload) => write(typeof payload === "string" ? payload : null, false),
        clear: () => write(initial(), false),
      },
      interactions: { choose: (payload) => write(typeof payload === "string" && payload !== "" ? payload : null, true) },
    };
  },
};

const checkbox: ComponentDefinition = {
  type: "ui.checkbox",
  version: 1,
  category: "interface",
  title: "Checkbox",
  description: 'A labelled on/off toggle. Outputs its state as "value".',
  properties: [
    { name: "label", type: "string", title: "Label" },
    { name: "field", type: "string", title: "Field name", description: "Name under which an enclosing form submits this value." },
    { name: "checked", type: "boolean", default: false, title: "Initially checked" },
  ],
  inputs: [{ name: "disabled", type: "boolean" }, VISIBLE],
  outputs: [{ name: "value", type: "boolean" }],
  events: [{ name: "changed", payload: "boolean" }],
  actions: [
    { name: "set", payload: "boolean" },
    { name: "toggle" },
    { name: "clear", description: "Resets to the initial state." },
  ],
  create: (ctx) => {
    const write = (value: boolean, announce: boolean): void => {
      ctx.setState("value", value);
      ctx.setOutput("value", value);
      if (announce) ctx.emit("changed", value);
    };
    write(ctx.getState<boolean>("value") ?? ctx.props.checked === true, false);
    return {
      actions: {
        set: (payload) => write(payload === true, false),
        toggle: () => write(ctx.output("value") !== true, false),
        clear: () => write(ctx.props.checked === true, false),
      },
      interactions: {
        toggle: () => {
          if (ctx.input("disabled") !== true) write(ctx.output("value") !== true, true);
        },
      },
    };
  },
};

function rowId(payload: JsonValue | undefined): string | undefined {
  return isJsonObject(payload) && typeof payload.id === "string" ? payload.id : undefined;
}

const rowEvents: ComponentDefinition["events"] = [
  { name: "change", payload: "object", description: "The user edited a row. Payload: { id, changes }." },
  { name: "remove", payload: "object", description: "The user asked to remove a row. Payload: { id }." },
  { name: "select", payload: "record", description: "The user selected a row. Payload: the row." },
];

const list: ComponentDefinition = {
  type: "ui.list",
  version: 1,
  category: "interface",
  title: "List",
  description:
    'Shows records as a list. Optionally lets the user tick a boolean field, edit the title inline, and remove rows; it only *emits* "change"/"remove" — connect those to a collection\'s update/delete actions.',
  properties: [
    { name: "titleField", type: "field", default: "title", title: "Title field" },
    { name: "subtitleField", type: "field", title: "Subtitle field" },
    { name: "checkField", type: "field", title: "Checkbox field", description: "A boolean field shown as a checkbox on each row." },
    { name: "editable", type: "boolean", default: false, title: "Editable titles" },
    { name: "removable", type: "boolean", default: false, title: "Allow removing" },
    { name: "selectable", type: "boolean", default: false, title: "Selectable rows" },
    { name: "emptyText", type: "string", default: "Nothing here yet.", title: "Empty message" },
  ],
  inputs: [{ name: "items", type: "records", description: "The records to show." }, VISIBLE],
  outputs: [
    { name: "count", type: "number" },
    { name: "selected", type: "record", description: "The selected row, if any." },
  ],
  events: rowEvents,
  actions: [],
  create: (ctx) => {
    const sync = (): void => {
      const rows = asRows(ctx.input("items"));
      ctx.setOutput("count", rows.length);
      const selected = ctx.getState<string>("selected");
      ctx.setOutput("selected", rows.find((row) => row.id === selected) ?? undefined);
    };
    const find = (id: string | undefined): JsonObject | undefined => asRows(ctx.input("items")).find((row) => row.id === id);
    sync();
    return {
      onInput: sync,
      interactions: {
        toggle: (payload) => {
          const field = asText(ctx.props.checkField);
          const row = find(rowId(payload));
          if (row && field) ctx.emit("change", { id: row.id as string, changes: { [field]: row[field] !== true } });
        },
        edit: (payload) => {
          const field = asText(ctx.props.titleField, "title");
          const row = find(rowId(payload));
          const value = isJsonObject(payload) ? payload.value : undefined;
          if (row && ctx.props.editable === true && value !== undefined && value !== row[field]) {
            ctx.emit("change", { id: row.id as string, changes: { [field]: value } });
          }
        },
        remove: (payload) => {
          const row = find(rowId(payload));
          if (row && ctx.props.removable === true) ctx.emit("remove", { id: row.id as string });
        },
        select: (payload) => {
          const row = find(rowId(payload));
          if (!row) return;
          ctx.setState("selected", row.id as string);
          sync();
          ctx.emit("select", row);
        },
      },
    };
  },
};

const table: ComponentDefinition = {
  type: "ui.table",
  version: 1,
  category: "interface",
  title: "Table",
  description:
    'Shows records in columns. Columns marked editable can be changed inline; edits are emitted as "change" events for a collection to apply.',
  properties: [
    {
      name: "columns",
      type: "list",
      default: [],
      title: "Columns",
      description: 'List of { "field": string, "label"?: string, "editable"?: boolean }. Empty shows every field.',
    },
    { name: "removable", type: "boolean", default: false, title: "Allow removing" },
    { name: "emptyText", type: "string", default: "No rows.", title: "Empty message" },
    { name: "actionLabel", type: "string", title: "Row button", description: 'Shows a button with this label on every row; pressing it emits "rowAction" with the row.' },
  ],
  inputs: [{ name: "rows", type: "records", description: "The records to show." }, VISIBLE],
  outputs: [
    { name: "count", type: "number" },
    { name: "selected", type: "record" },
  ],
  events: [...rowEvents, { name: "rowAction", payload: "record", description: "A row's button was pressed. Payload: the row." }],
  actions: [],
  create: (ctx) => {
    const sync = (): void => {
      const rows = asRows(ctx.input("rows"));
      ctx.setOutput("count", rows.length);
      const selected = ctx.getState<string>("selected");
      ctx.setOutput("selected", rows.find((row) => row.id === selected) ?? undefined);
    };
    const find = (id: string | undefined): JsonObject | undefined => asRows(ctx.input("rows")).find((row) => row.id === id);
    const editable = (field: string): boolean =>
      Array.isArray(ctx.props.columns) &&
      ctx.props.columns.some((column) => isJsonObject(column) && column.field === field && column.editable === true);
    sync();
    return {
      onInput: sync,
      interactions: {
        edit: (payload) => {
          const row = find(rowId(payload));
          const field = isJsonObject(payload) ? asText(payload.field) : "";
          const value = isJsonObject(payload) ? payload.value : undefined;
          if (row && field && editable(field) && value !== undefined && value !== row[field]) {
            ctx.emit("change", { id: row.id as string, changes: { [field]: value } });
          }
        },
        remove: (payload) => {
          const row = find(rowId(payload));
          if (row && ctx.props.removable === true) ctx.emit("remove", { id: row.id as string });
        },
        rowAction: (payload) => {
          const row = find(rowId(payload));
          if (row && asText(ctx.props.actionLabel) !== "") ctx.emit("rowAction", row);
        },
        select: (payload) => {
          const row = find(rowId(payload));
          if (!row) return;
          ctx.setState("selected", row.id as string);
          sync();
          ctx.emit("select", row);
        },
      },
    };
  },
};

const form: ComponentDefinition = {
  type: "ui.form",
  version: 1,
  category: "interface",
  title: "Form",
  description:
    'Groups inputs into one submission. On "submit" it collects the value of every nested input that has a "field" name and emits "submitted" with { field: value }. Connect submitted to a collection\'s create action.',
  container: true,
  properties: [
    { name: "direction", type: "enum", options: ["column", "row"], default: "column", title: "Direction" },
    { name: "gap", type: "enum", options: ["none", "small", "medium", "large"], default: "medium", title: "Spacing" },
    { name: "resetOnSubmit", type: "boolean", default: true, title: "Clear after submitting" },
  ],
  inputs: [VISIBLE],
  outputs: [],
  events: [
    { name: "submitted", payload: "object", description: "Payload: an object of field values." },
    { name: "invalid", payload: "object", description: "A required input was empty. Payload: { missing: string[] }." },
  ],
  actions: [
    { name: "submit", description: "Collect and emit the values." },
    { name: "reset", description: "Reset every nested input." },
  ],
  create: (ctx) => {
    const fields = (): Array<{ id: string; field: string; required: boolean }> =>
      ctx
        .descendants()
        .filter((object) => typeof object.properties.field === "string" && object.properties.field !== "")
        .map((object) => ({
          id: object.id,
          field: object.properties.field as string,
          required: object.properties.required === true,
        }));
    const reset = (): void => {
      for (const entry of fields()) ctx.call(entry.id, "clear");
    };
    return {
      actions: {
        submit: () => {
          const values: JsonObject = {};
          const missing: string[] = [];
          for (const entry of fields()) {
            const raw = ctx.peek(entry.id, "value");
            const value = typeof raw === "string" ? raw.trim() : raw;
            if (entry.required && isBlank(value)) missing.push(entry.field);
            if (!isBlank(value)) values[entry.field] = value as JsonValue;
          }
          if (missing.length > 0) {
            ctx.emit("invalid", { missing });
            return;
          }
          ctx.emit("submitted", values);
          if (ctx.props.resetOnSubmit !== false) reset();
        },
        reset,
      },
    };
  },
};

const tabs: ComponentDefinition = {
  type: "ui.tabs",
  version: 1,
  category: "interface",
  title: "Tabs",
  description:
    'A row of options; outputs the "value" of the selected one (use it to drive a filter). If it has children, child N is shown while option N is selected.',
  container: true,
  properties: [
    {
      name: "options",
      type: "list",
      default: [],
      title: "Options",
      description: 'List of { "label": string, "value": any }. A null value conventionally means "all".',
    },
    { name: "selected", type: "number", default: 0, title: "Initially selected (index)" },
  ],
  inputs: [VISIBLE],
  outputs: [
    { name: "value", type: "any", description: "Value of the selected option." },
    { name: "index", type: "number" },
  ],
  events: [{ name: "changed", payload: "any" }],
  actions: [{ name: "select", payload: "number", description: "Selects an option by index." }],
  create: (ctx) => {
    const options = (): JsonObject[] => (Array.isArray(ctx.props.options) ? ctx.props.options.filter(isJsonObject) : []);
    const write = (index: number, announce: boolean): void => {
      const all = options();
      const bounded = all.length === 0 ? 0 : Math.min(Math.max(0, index), all.length - 1);
      const value = all[bounded]?.value ?? null;
      ctx.setState("index", bounded);
      ctx.setOutput("index", bounded);
      ctx.setOutput("value", value);
      if (announce) ctx.emit("changed", value);
    };
    const initial = typeof ctx.props.selected === "number" ? ctx.props.selected : 0;
    write(ctx.getState<number>("index") ?? initial, false);
    const select = (payload: JsonValue | undefined, announce: boolean): void => {
      if (typeof payload === "number") write(payload, announce);
    };
    return {
      actions: { select: (payload) => select(payload, false) },
      interactions: { select: (payload) => select(payload, true) },
    };
  },
};

const modal: ComponentDefinition = {
  type: "ui.modal",
  version: 1,
  category: "interface",
  title: "Modal",
  description: 'A dialog shown over the application while open. Trigger its "open"/"close" actions from events.',
  container: true,
  properties: [
    { name: "title", type: "string", title: "Title" },
    { name: "open", type: "boolean", default: false, title: "Initially open" },
  ],
  inputs: [],
  outputs: [{ name: "isOpen", type: "boolean" }],
  events: [{ name: "opened" }, { name: "closed" }],
  actions: [{ name: "open" }, { name: "close" }, { name: "toggle" }],
  create: (ctx) => {
    const write = (open: boolean): void => {
      if (ctx.output("isOpen") === open) return;
      ctx.setState("open", open);
      ctx.setOutput("isOpen", open);
      ctx.emit(open ? "opened" : "closed");
    };
    const initial = ctx.getState<boolean>("open") ?? ctx.props.open === true;
    ctx.setState("open", initial);
    ctx.setOutput("isOpen", initial);
    return {
      actions: {
        open: () => write(true),
        close: () => write(false),
        toggle: () => write(ctx.output("isOpen") !== true),
      },
      interactions: { dismiss: () => write(false) },
    };
  },
};

export const interfacePrimitives: ComponentDefinition[] = [
  window,
  container,
  text,
  button,
  textInput,
  numberInput,
  select,
  checkbox,
  list,
  table,
  form,
  tabs,
  modal,
];
