import "fake-indexeddb/auto";
import { ClaspError, ancestorsOf, createId, findObject, type ClaspErrorCode, type JsonObject, type JsonValue } from "@clasp/core";
import { createStandardRegistry } from "@clasp/examples";
import { IndexedDbStorage, MemoryStorage, WorkspaceStorage, type StorageAdapter } from "@clasp/persistence";
import { Workspace, type AppHandle, type RuntimeLimits, type TimerHost } from "@clasp/runtime";
import { DesktopService, FileService, type FileDialogs, type FileEntry, type SaveChoice } from "@clasp/files";
import { NetworkService, type NetworkLimits, type SocketFactory, type SocketHandlers } from "@clasp/network";
import { NotificationCenter, SystemMetrics } from "@clasp/workflows";

interface FakeConnection {
  url: string;
  handlers: SocketHandlers;
  sent: string[];
  open: boolean;
}

/**
 * Stand-in servers for tests: no real network is touched. Servers echo what
 * they receive as "echo: <text>" unless `echo` is off; hosts in `refuse` never
 * accept a connection.
 */
export class FakeServers {
  readonly connections: FakeConnection[] = [];
  readonly refuse = new Set<string>();
  echo = true;

  readonly factory: SocketFactory = (url, handlers) => {
    const connection: FakeConnection = { url, handlers, sent: [], open: false };
    this.connections.push(connection);
    const host = new URL(url).host;
    setTimeout(() => {
      if (this.refuse.has(host)) handlers.closed(1006, "");
      else {
        connection.open = true;
        handlers.opened();
      }
    }, 0);
    return {
      send: (text) => {
        connection.sent.push(text);
        if (this.echo) setTimeout(() => connection.open && handlers.received(`echo: ${text}`), 0);
      },
      close: () => {
        if (!connection.open) return;
        connection.open = false;
        setTimeout(() => handlers.closed(1000, ""), 0);
      },
    };
  };

  open(): FakeConnection[] {
    return this.connections.filter((connection) => connection.open);
  }

  /** The server sends a message on every open connection. */
  push(text: string): void {
    for (const connection of this.open()) connection.handlers.received(text);
  }

  /** The server hangs up on everyone. */
  hangUp(reason = "Server going away"): void {
    for (const connection of this.open()) {
      connection.open = false;
      connection.handlers.closed(1001, reason);
    }
  }
}

/** File dialogs a test answers ahead of time, as the user would. */
export class ScriptedDialogs implements FileDialogs {
  readonly opens: Array<string | undefined> = [];
  readonly saves: Array<SaveChoice | undefined> = [];
  readonly asked: Array<{ mode: "open" | "save"; appName: string; kind: string; suggestedName?: string }> = [];

  async open(request: { appName: string; kind: string }): Promise<string | undefined> {
    this.asked.push({ mode: "open", appName: request.appName, kind: request.kind });
    return this.opens.shift();
  }

  async save(request: { appName: string; kind: string; suggestedName: string }): Promise<SaveChoice | undefined> {
    this.asked.push({ mode: "save", appName: request.appName, kind: request.kind, suggestedName: request.suggestedName });
    return this.saves.shift();
  }
}

export interface TestWorkspace {
  workspace: Workspace;
  notifications: NotificationCenter;
  files: FileService;
  dialogs: ScriptedDialogs;
  network: NetworkService;
  servers: FakeServers;
  /** Files the desktop service was asked to open, in order. */
  launched: FileEntry[];
  /** Closes the workspace and opens it again on the same storage — a "reload". */
  reload(): Promise<TestWorkspace>;
}

export interface OpenOptions {
  /** Workspace id for IndexedDB-backed storage; omit for a fresh one. */
  id?: string;
  backend?: "indexeddb" | "memory";
  adapter?: StorageAdapter;
  limits?: Partial<RuntimeLimits>;
  timers?: TimerHost;
  /** A real socket implementation instead of fake servers. */
  sockets?: SocketFactory;
  networkLimits?: Partial<NetworkLimits>;
}

/** Opens a workspace with the standard components, like the Studio does. */
export async function openWorkspace(options: OpenOptions = {}): Promise<TestWorkspace> {
  const id = options.id ?? createId("ws");
  const adapter =
    options.adapter ?? (options.backend === "memory" ? new MemoryStorage() : await IndexedDbStorage.open(id));
  const dialogs = new ScriptedDialogs();
  let notifications!: NotificationCenter;
  let files!: FileService;
  let network!: NetworkService;
  const servers = new FakeServers();
  const launched: FileEntry[] = [];
  const workspace = await Workspace.open({
    storage: new WorkspaceStorage(adapter),
    registry: createStandardRegistry(),
    // System services exist before any application starts, as in the Studio.
    setup: (opened) => {
      notifications = new NotificationCenter(opened.kernel);
      files = new FileService(opened.kernel, opened.schemas, dialogs);
      network = new NetworkService(opened.kernel, options.sockets ?? servers.factory, options.networkLimits);
      new SystemMetrics(opened.kernel, () => ({ busy: 12, fps: 60, apps: opened.apps().length, cores: 8 }));
      new DesktopService(opened.kernel, files, async (file) => {
        launched.push(file);
        return "Test launcher";
      });
    },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  await workspace.settle();
  return {
    workspace,
    notifications,
    files,
    dialogs,
    network,
    servers,
    launched,
    reload: async () => {
      await workspace.close();
      return openWorkspace({
        ...options,
        id,
        ...(adapter.kind === "memory" ? { adapter } : {}),
      });
    },
  };
}

/** Drives a running application the way a renderer would: through interactions only. */
export class AppDriver {
  constructor(
    readonly workspace: Workspace,
    readonly app: AppHandle,
  ) {}

  id(name: string): string {
    const object = findObject(this.app.store.graph, { name });
    if (!object) throw new Error(`No object named "${name}" in ${this.app.store.graph.metadata.name}`);
    return object.id;
  }

  output(name: string, port: string): JsonValue | undefined {
    return this.app.runtime.getOutput(this.id(name), port);
  }

  input(name: string, port: string): JsonValue | undefined {
    return this.app.runtime.getInput(this.id(name), port);
  }

  rows(name: string, port = "items"): JsonObject[] {
    return (this.input(name, port) as JsonObject[] | undefined) ?? [];
  }

  titles(name: string, port = "items"): string[] {
    return this.rows(name, port).map((row) => String(row.title));
  }

  /** Whether an element and all of its ancestors are visible. */
  visible(name: string): boolean {
    const id = this.id(name);
    const chain = [id, ...ancestorsOf(this.app.store.graph, id).map((object) => object.id)];
    return chain.every((objectId) => this.app.runtime.getInput(objectId, "visible") !== false);
  }

  async interact(name: string, interaction: string, payload?: JsonValue): Promise<void> {
    this.app.runtime.interact(this.id(name), interaction, payload);
    await this.workspace.settle();
  }

  type(name: string, value: string): Promise<void> {
    return this.interact(name, "input", value);
  }

  press(name: string): Promise<void> {
    return this.interact(name, "press");
  }

  async addTask(title: string): Promise<void> {
    await this.type("Title input", title);
    await this.press("Add button");
  }
}

export async function expectCode(run: Promise<unknown> | (() => unknown), code: ClaspErrorCode): Promise<ClaspError> {
  try {
    await (typeof run === "function" ? run() : run);
  } catch (error) {
    if (!(error instanceof ClaspError)) throw error;
    if (error.code !== code) throw new Error(`Expected ${code} but got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`Expected rejection with ${code}`);
}

/** Answers the oldest pending access request, as the user would in the permission prompt. */
export async function answerAccessRequest(workspace: Workspace, approve: boolean): Promise<void> {
  const [request] = workspace.kernel.permissions.pendingRequests();
  if (!request) throw new Error("No access request is pending");
  workspace.kernel.permissions.resolveRequest(request.id, approve);
  await workspace.settle();
}
