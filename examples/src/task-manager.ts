import { GraphBuilder, type ClaspGraph, type TypeCatalog } from "@clasp/core";

/**
 * Task Manager — create, edit, complete and delete tasks.
 *
 * Built only from registered primitives. Its tasks live in a `clasp.task`
 * collection that it owns; the collection is discoverable, so other
 * applications can find it — but they cannot read it until the user says so.
 */
export function buildTaskManager(catalog?: TypeCatalog): ClaspGraph {
  const b = new GraphBuilder("Task Manager", { description: "Create, edit, complete and delete tasks." });

  const tasks = b.add("data.collection", { name: "Tasks", properties: { schema: "clasp.task", exposure: "discoverable" } });

  const window = b.add("ui.window", {
    name: "Window",
    properties: { title: "Task Manager", subtitle: "Everything you need to get done.", width: "regular" },
  });

  const form = b.add("ui.form", { name: "New task form", parent: window, properties: { direction: "row", gap: "small" } });
  const title = b.add("ui.textInput", {
    name: "Title input",
    parent: form,
    properties: { field: "title", placeholder: "What needs to be done?", required: true },
  });
  const add = b.add("ui.button", { name: "Add button", parent: form, properties: { label: "Add task", variant: "primary" } });

  const tabs = b.add("ui.tabs", {
    name: "Status tabs",
    parent: window,
    properties: {
      options: [
        { label: "All", value: null },
        { label: "Active", value: false },
        { label: "Completed", value: true },
      ],
    },
  });
  const filter = b.add("data.filter", { name: "Status filter", properties: { field: "completed", operator: "eq" } });
  const list = b.add("ui.list", {
    name: "Task list",
    parent: window,
    properties: {
      titleField: "title",
      checkField: "completed",
      editable: true,
      removable: true,
      emptyText: "No tasks here. Add one above.",
    },
  });

  const remaining = b.add("data.aggregate", {
    name: "Remaining count",
    properties: { operation: "count", whereField: "completed", whereOperator: "eq", whereValue: false },
  });
  const footer = b.add("ui.text", { name: "Remaining label", parent: window, properties: { text: "{value} remaining", variant: "muted" } });

  // Adding: button or Enter → form → collection.
  b.connect(`${add}.click`, `${form}.submit`);
  b.connect(`${title}.submitted`, `${form}.submit`);
  b.connect(`${form}.submitted`, `${tasks}.create`);
  // Viewing: collection → filter (driven by the tabs) → list.
  b.connect(`${tasks}.records`, `${filter}.records`);
  b.connect(`${tabs}.value`, `${filter}.value`);
  b.connect(`${filter}.records`, `${list}.items`);
  // Editing, completing and deleting: list → collection.
  b.connect(`${list}.change`, `${tasks}.update`);
  b.connect(`${list}.remove`, `${tasks}.delete`);
  // Summary.
  b.connect(`${tasks}.records`, `${remaining}.records`);
  b.connect(`${remaining}.value`, `${footer}.value`);

  // Public interface: what other applications may use, with permission.
  b.exposeAction("addTask", `${tasks}.create`, "Creates a task. Arguments: { title: string }");
  b.exposeOutput("remaining", `${remaining}.value`, "Number of incomplete tasks");
  b.exposeEvent("tasksChanged", `${tasks}.changed`, "Tasks were created, edited or deleted");
  b.exposeView("taskList", list, "The live, editable list of tasks");

  return b.build(catalog);
}
