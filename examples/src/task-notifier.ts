import { GraphBuilder, type ClaspGraph, type TypeCatalog } from "@clasp/core";

/**
 * Task Notifier — a workflow with no interface of its own logic path:
 * when a task in another application's collection becomes completed, it sends
 * a notification. It runs on exactly the same runtime as visual applications.
 *
 * Needs two grants from the user: read access to the task collection, and
 * permission to invoke the notification service.
 */
export function buildTaskNotifier(catalog?: TypeCatalog, collectionId?: string): ClaspGraph {
  const b = new GraphBuilder("Task Notifier", { description: "Notifies you when a task is completed." });

  const listener = b.add("workflow.listener", {
    name: "Task changes",
    properties: {
      schema: "clasp.task",
      event: "updated",
      reason: "Notice when tasks are completed.",
      ...(collectionId ? { collectionId } : {}),
    },
  });
  const isDone = b.add("workflow.branch", { name: "Is completed now", properties: { field: "record.completed", operator: "eq", value: true } });
  const wasOpen = b.add("workflow.branch", { name: "Was not completed before", properties: { field: "previous.completed", operator: "neq", value: true } });
  const notify = b.add("workflow.notify", {
    name: "Notify",
    properties: { title: "Task completed", message: "“{record.title}” is done.", level: "success" },
  });
  b.connect(`${listener}.triggered`, `${isDone}.run`);
  b.connect(`${isDone}.then`, `${wasOpen}.run`);
  b.connect(`${wasOpen}.then`, `${notify}.send`);

  // A small status surface so the user can see and unblock the workflow.
  const window = b.add("ui.window", { name: "Window", properties: { title: "Task Notifier", subtitle: "Runs in the background.", width: "narrow" } });
  const status = b.add("ui.text", { name: "Status", parent: window, properties: { text: "Watching for completed tasks: {value}", variant: "body" } });
  b.connect(`${listener}.status`, `${status}.value`);
  const needsAccess = b.add("logic.compare", { name: "Needs access", properties: { operator: "eq", b: "needs-access" } });
  b.connect(`${listener}.status`, `${needsAccess}.a`);
  const request = b.add("ui.button", { name: "Request access button", parent: window, properties: { label: "Allow watching tasks", variant: "primary" } });
  b.connect(`${needsAccess}.result`, `${request}.visible`);
  b.connect(`${request}.click`, `${listener}.requestAccess`);

  return b.build(catalog);
}
