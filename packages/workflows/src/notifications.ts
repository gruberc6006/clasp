import { Emitter, createId, isJsonObject, nowIso, type JsonValue } from "@clasp/core";
import { SYSTEM_PRINCIPAL, type ClaspKernel } from "@clasp/universal-api";

/** Resource id of the workspace notification service. */
export const NOTIFICATION_SERVICE_ID = "clasp.notifications";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface ClaspNotification {
  id: string;
  title?: string;
  message: string;
  level: NotificationLevel;
  /** Principal that sent it. */
  from: string;
  fromName: string;
  at: string;
}

const LEVELS: readonly NotificationLevel[] = ["info", "success", "warning", "error"];

/**
 * The workspace notification service: a system resource applications reach
 * with `clasp.invoke({ target: "clasp.notifications", action: "send" })` once
 * the user has granted them `capability.invoke` on it. Hosts (the Studio, a
 * test, a CLI) subscribe to show or record what was sent.
 */
export class NotificationCenter {
  private readonly items: ClaspNotification[] = [];
  private readonly events = new Emitter<ClaspNotification>();
  private readonly changes = new Emitter<void>();

  constructor(
    private readonly kernel: ClaspKernel,
    private readonly limit = 100,
  ) {
    kernel.addResources(SYSTEM_PRINCIPAL, [
      {
        id: NOTIFICATION_SERVICE_ID,
        kind: "service",
        name: "Notifications",
        description: "Shows a notification to the user.",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        actions: [{ name: "send", description: "Arguments: { message: string, title?: string, level?: info|success|warning|error }" }],
        events: [{ name: "sent", description: "A notification was delivered." }],
        outputs: [{ name: "count", description: "Notifications currently listed." }],
      },
    ]);
    kernel.bindProvider(NOTIFICATION_SERVICE_ID, {
      values: () => ({ count: this.items.length }),
      invoke: (action, args, caller) => {
        if (action !== "send") throw new Error(`Notifications has no action "${action}".`);
        return this.send(args, caller);
      },
    });
  }

  list(): ClaspNotification[] {
    return [...this.items];
  }

  dismiss(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.items.splice(index, 1);
      this.changes.emit();
    }
  }

  clear(): void {
    this.items.length = 0;
    this.changes.emit();
  }

  /** Called for each new notification. */
  onNotify(listener: (notification: ClaspNotification) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Called whenever the list changes. */
  subscribe(listener: () => void): () => void {
    return this.changes.subscribe(listener);
  }

  private send(args: JsonValue | undefined, caller: string): JsonValue {
    const input = isJsonObject(args) ? args : { message: args ?? "" };
    const message = typeof input.message === "string" ? input.message.trim() : String(input.message ?? "").trim();
    if (!message) throw new Error("A notification needs a message.");
    const level = LEVELS.includes(input.level as NotificationLevel) ? (input.level as NotificationLevel) : "info";
    const notification: ClaspNotification = {
      id: createId("note"),
      ...(typeof input.title === "string" && input.title ? { title: input.title } : {}),
      message,
      level,
      from: caller,
      fromName: this.kernel.principalName(caller),
      at: nowIso(),
    };
    this.items.unshift(notification);
    if (this.items.length > this.limit) this.items.length = this.limit;
    this.events.emit(notification);
    this.changes.emit();
    this.kernel.publish(NOTIFICATION_SERVICE_ID, "sent", { id: notification.id, message, level });
    return { id: notification.id };
  }
}
