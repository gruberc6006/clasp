import {
  ClaspError,
  Emitter,
  connectionsFrom,
  createId,
  deepClone,
  deepEqual,
  descendantsOf,
  executionOrder,
  nowIso,
  toClaspError,
  validateGraph,
  type ClaspGraph,
  type ClaspObject,
  type GraphEvent,
  type GraphStore,
  type JsonObject,
  type JsonValue,
} from "@clasp/core";
import type { ClaspAPI } from "@clasp/universal-api";
import type { ComponentContext, ComponentDefinition, ComponentInstance } from "./component";
import type { ComponentRegistry } from "./registry";

export type RuntimeStatus = "stopped" | "running" | "halted";

export interface RuntimeDiagnostic {
  id: string;
  at: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  objectId?: string;
}

export interface RuntimeLimits {
  /** Scheduler steps allowed in one synchronous burst before the runtime halts. */
  maxStepsPerFlush: number;
  /** Scheduler steps allowed per second across bursts (catches loops that bounce through async work). */
  maxStepsPerSecond: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = { maxStepsPerFlush: 10_000, maxStepsPerSecond: 50_000 };

/** Timer source; injectable so tests can drive time. */
export interface TimerHost {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimers: TimerHost = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface RuntimeEventRecord {
  objectId: string;
  event: string;
  payload: JsonValue | undefined;
}

export interface RuntimeOutputRecord {
  objectId: string;
  port: string;
  value: JsonValue | undefined;
}

/** What a renderer needs to draw one object. */
export interface ObjectView {
  object: ClaspObject;
  definition: ComponentDefinition;
  props: JsonObject;
  /** Effective value of a value input (connection, else property). */
  input(port: string): JsonValue | undefined;
  output(port: string): JsonValue | undefined;
  /** Message of the last failure of this object, if any. */
  error: string | undefined;
}

interface Live {
  definition: ComponentDefinition;
  instance: ComponentInstance;
  alive: boolean;
  disposers: Array<() => void>;
}

export interface RuntimeOptions {
  store: GraphStore;
  registry: ComponentRegistry;
  clasp: ClaspAPI;
  limits?: Partial<RuntimeLimits>;
  timers?: TimerHost;
  now?: () => number;
}

/**
 * Executes one application graph deterministically.
 *
 * The runtime instantiates a registered component for every object, moves
 * values along value connections and triggers actions along event
 * connections. All work goes through one FIFO scheduler, so execution order
 * is reproducible, and the scheduler enforces step limits so a miswired graph
 * halts with a diagnostic instead of hanging. No AI is involved, and
 * interfaces are optional: a headless workflow runs exactly the same way.
 */
export class GraphRuntime {
  private readonly store: GraphStore;
  private readonly registry: ComponentRegistry;
  private readonly clasp: ClaspAPI;
  private readonly limits: RuntimeLimits;
  private readonly timers: TimerHost;
  private readonly now: () => number;

  private state: RuntimeStatus = "stopped";
  private readonly live = new Map<string, Live>();
  private readonly outputs = new Map<string, Map<string, JsonValue>>();
  private readonly memory = new Map<string, Map<string, JsonValue>>();
  private readonly externalInputs = new Map<string, JsonValue>();
  private readonly failures = new Map<string, string>();
  private readonly log: RuntimeDiagnostic[] = [];

  private queue: Array<() => void> = [];
  private flushing = false;
  private holding = false;
  private dirty = false;
  private revision = 0;
  private windowStart = 0;
  private windowSteps = 0;
  private totalSteps = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private unsubscribeStore: (() => void) | undefined;

  private readonly changeEvents = new Emitter<void>();
  private readonly emitted = new Emitter<RuntimeEventRecord>();
  private readonly outputEvents = new Emitter<RuntimeOutputRecord>();
  private readonly diagnosticEvents = new Emitter<RuntimeDiagnostic>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.clasp = options.clasp;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.timers = options.timers ?? systemTimers;
    this.now = options.now ?? (() => Date.now());
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  get status(): RuntimeStatus {
    return this.state;
  }

  /** Changes whenever anything a renderer could show has changed. */
  get version(): number {
    return this.revision;
  }

  get graph(): ClaspGraph {
    return this.store.graph;
  }

  /** Instantiates the graph and starts executing. Problems become diagnostics; valid objects still run. */
  start(): void {
    if (this.state !== "stopped") return;
    this.state = "running";
    this.unsubscribeStore = this.store.subscribe((event) => this.reconcile(event));
    const graph = this.store.graph;

    for (const found of validateGraph(graph, this.registry)) {
      this.diagnose(found.severity, found.code, found.message, found.objectId);
    }
    const { order, cyclic } = executionOrder(graph);
    if (cyclic.length > 0) {
      // A value cycle has no deterministic order; refuse to guess.
      this.state = "halted";
      this.touch();
      this.notify();
      return;
    }
    this.holding = true;
    for (const id of order) this.instantiate(id);
    this.holding = false;
    this.flush();
    this.startInstances(order);
    this.touch();
    this.flush();
  }

  /** Disposes every instance and forgets all runtime state. */
  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    for (const id of [...this.live.keys()]) this.dispose(id);
    this.queue = [];
    this.outputs.clear();
    this.memory.clear();
    this.externalInputs.clear();
    this.failures.clear();
    this.state = "stopped";
    this.touch();
    this.notify();
  }

  restart(): void {
    this.stop();
    this.log.length = 0;
    this.start();
  }

  /** Resolves when no scheduled or asynchronous work remains. */
  async whenIdle(): Promise<void> {
    for (let round = 0; round < 1000; round++) {
      if (this.pending.size === 0 && this.queue.length === 0) return;
      await Promise.allSettled([...this.pending]);
      this.flush();
    }
    throw new ClaspError("EXECUTION_LIMIT_EXCEEDED", "The application never became idle.");
  }

  get busy(): boolean {
    return this.pending.size > 0 || this.queue.length > 0;
  }

  // ── observation ─────────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    return this.changeEvents.subscribe(listener);
  }

  onEvent(listener: (record: RuntimeEventRecord) => void): () => void {
    return this.emitted.subscribe(listener);
  }

  onOutput(listener: (record: RuntimeOutputRecord) => void): () => void {
    return this.outputEvents.subscribe(listener);
  }

  onDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void {
    return this.diagnosticEvents.subscribe(listener);
  }

  diagnostics(): RuntimeDiagnostic[] {
    return [...this.log];
  }

  clearDiagnostics(): void {
    this.log.length = 0;
    this.failures.clear();
    this.touch();
    this.notify();
  }

  getOutput(objectId: string, port: string): JsonValue | undefined {
    return this.outputs.get(objectId)?.get(port);
  }

  /** Effective input: connection, then external override, then same-named property. */
  getInput(objectId: string, port: string): JsonValue | undefined {
    const graph = this.store.graph;
    for (const connection of Object.values(graph.connections)) {
      if (connection.kind === "value" && connection.target.objectId === objectId && connection.target.port === port) {
        return this.getOutput(connection.source.objectId, connection.source.port);
      }
    }
    const external = this.externalInputs.get(`${objectId}.${port}`);
    if (external !== undefined) return external;
    const object = graph.objects[objectId];
    if (!object) return undefined;
    const value = object.properties[port];
    if (value !== undefined && value !== null) return value;
    return this.registry.defaults(object.type)[port];
  }

  view(objectId: string): ObjectView | undefined {
    const object = this.store.graph.objects[objectId];
    const definition = object ? this.registry.get(object.type) : undefined;
    if (!object || !definition) return undefined;
    return {
      object,
      definition,
      props: this.propsOf(object),
      input: (port) => this.getInput(objectId, port),
      output: (port) => this.getOutput(objectId, port),
      error: this.failures.get(objectId),
    };
  }

  // ── stimulation ─────────────────────────────────────────────────────────

  /** A user gesture on an interface object (called by renderers). */
  interact(objectId: string, name: string, payload?: JsonValue): void {
    this.enqueue(() => {
      const handler = this.live.get(objectId)?.instance.interactions?.[name];
      if (handler) this.guard(objectId, () => handler(payload));
    });
    this.flush();
  }

  /** Triggers an action port, as an incoming event connection would. */
  invoke(objectId: string, action: string, payload?: JsonValue): void {
    this.enqueue(() => this.runAction(objectId, action, payload));
    this.flush();
  }

  /** Overrides an unconnected input from outside the graph (used for exposed interface inputs). */
  setExternalInput(objectId: string, port: string, value: JsonValue | undefined): void {
    const key = `${objectId}.${port}`;
    if (value === undefined) this.externalInputs.delete(key);
    else this.externalInputs.set(key, deepClone(value));
    this.enqueue(() => this.deliverInput(objectId, port));
    this.touch();
    this.flush();
  }

  // ── public interface (composition) ──────────────────────────────────────

  /** Current values of the outputs the application exposes. */
  interfaceValues(): JsonObject {
    const values: JsonObject = {};
    for (const entry of this.store.graph.interface.outputs) {
      const value = this.getOutput(entry.source.objectId, entry.source.port);
      if (value !== undefined) values[entry.name] = deepClone(value);
    }
    return values;
  }

  setInterfaceInputs(patch: JsonObject): void {
    for (const [name, value] of Object.entries(patch)) {
      const entry = this.store.graph.interface.inputs.find((candidate) => candidate.name === name);
      if (!entry) throw new ClaspError("NOT_FOUND", `This application exposes no input named "${name}".`);
      this.setExternalInput(entry.target.objectId, entry.target.port, value);
    }
  }

  invokeInterfaceAction(name: string, payload?: JsonValue): void {
    const entry = this.store.graph.interface.actions.find((candidate) => candidate.name === name);
    if (!entry) throw new ClaspError("NOT_FOUND", `This application exposes no action named "${name}".`);
    if (this.state !== "running") throw new ClaspError("UNAVAILABLE", "The application is not running.");
    this.invoke(entry.target.objectId, entry.target.port, payload);
  }

  // ── scheduler ───────────────────────────────────────────────────────────

  private enqueue(task: () => void): void {
    if (this.state !== "running") return;
    this.queue.push(task);
  }

  private flush(): void {
    if (this.flushing || this.holding) return;
    this.flushing = true;
    let steps = 0;
    try {
      while (this.queue.length > 0 && this.state === "running") {
        steps++;
        if (steps > this.limits.maxStepsPerFlush) {
          this.halt(
            `Stopped after ${this.limits.maxStepsPerFlush} steps without settling. An event is probably triggering itself in a loop.`,
          );
          break;
        }
        const task = this.queue.shift() as () => void;
        task();
      }
    } finally {
      this.flushing = false;
    }
    this.account(steps);
    this.notify();
  }

  /** Steps executed since the runtime started (for activity monitors). */
  get steps(): number {
    return this.totalSteps;
  }

  private account(steps: number): void {
    if (steps === 0 || this.state !== "running") return;
    this.totalSteps += steps;
    const time = this.now();
    if (time - this.windowStart >= 1000) {
      this.windowStart = time;
      this.windowSteps = 0;
    }
    this.windowSteps += steps;
    if (this.windowSteps > this.limits.maxStepsPerSecond) {
      this.halt(`Stopped after more than ${this.limits.maxStepsPerSecond} steps in one second. Something is reacting to its own changes.`);
      this.notify();
    }
  }

  private halt(message: string): void {
    this.queue = [];
    this.state = "halted";
    for (const entry of this.live.values()) {
      for (const disposer of entry.disposers.splice(0)) disposer();
    }
    this.diagnose("error", "EXECUTION_LIMIT_EXCEEDED", message);
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
  }

  private notify(): void {
    if (!this.dirty || this.flushing) return;
    this.dirty = false;
    this.revision++;
    this.changeEvents.emit();
  }

  // ── execution ───────────────────────────────────────────────────────────

  private propsOf(object: ClaspObject): JsonObject {
    const props: JsonObject = { ...this.registry.defaults(object.type) };
    for (const [key, value] of Object.entries(object.properties)) {
      if (value !== null) props[key] = value;
    }
    return props;
  }

  private guard(objectId: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.reportFailure(objectId, error);
    }
  }

  private reportFailure(objectId: string, error: unknown): void {
    const claspError = toClaspError(error);
    this.failures.set(objectId, claspError.message);
    this.diagnose("error", claspError.code, claspError.message, objectId);
    this.touch();
  }

  private diagnose(severity: "error" | "warning", code: string, message: string, objectId?: string): void {
    const duplicate = this.log.find((entry) => entry.code === code && entry.message === message && entry.objectId === objectId);
    if (duplicate) {
      duplicate.at = nowIso();
      return;
    }
    const diagnostic: RuntimeDiagnostic = {
      id: createId("diag"),
      at: nowIso(),
      severity,
      code,
      message,
      ...(objectId !== undefined ? { objectId } : {}),
    };
    this.log.push(diagnostic);
    if (this.log.length > 200) this.log.shift();
    this.diagnosticEvents.emit(diagnostic);
  }

  private instantiate(objectId: string): void {
    const object = this.store.graph.objects[objectId];
    if (!object) return;
    const definition = this.registry.get(object.type);
    if (!definition) return; // already reported by validation as UNKNOWN_TYPE
    const entry: Live = { definition, instance: {}, alive: true, disposers: [] };
    this.live.set(objectId, entry);
    this.failures.delete(objectId);
    this.guard(objectId, () => {
      entry.instance = definition.create(this.contextFor(objectId, entry)) ?? {};
    });
  }

  private startInstances(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.live.get(id);
      if (entry?.instance.start) this.enqueue(() => this.guard(id, () => entry.instance.start?.()));
    }
  }

  private dispose(objectId: string): void {
    const entry = this.live.get(objectId);
    if (!entry) return;
    entry.alive = false;
    for (const disposer of entry.disposers.splice(0)) disposer();
    this.guard(objectId, () => entry.instance.dispose?.());
    this.live.delete(objectId);
  }

  private runAction(objectId: string, action: string, payload: JsonValue | undefined): void {
    const entry = this.live.get(objectId);
    const handler = entry?.instance.actions?.[action];
    if (!entry || !handler) return;
    this.guard(objectId, () => handler(payload === undefined ? undefined : deepClone(payload)));
  }

  private deliverInput(objectId: string, port: string): void {
    const entry = this.live.get(objectId);
    if (!entry?.instance.onInput) return;
    const handler = entry.instance.onInput;
    this.guard(objectId, () => handler.call(entry.instance, port, this.getInput(objectId, port)));
    this.touch();
  }

  private writeOutput(objectId: string, port: string, value: JsonValue | undefined): void {
    let ports = this.outputs.get(objectId);
    const previous = ports?.get(port);
    if (deepEqual(previous, value)) return; // unchanged values never propagate
    if (!ports) {
      ports = new Map();
      this.outputs.set(objectId, ports);
    }
    if (value === undefined) ports.delete(port);
    else ports.set(port, deepClone(value));
    this.touch();
    for (const connection of connectionsFrom(this.store.graph, objectId, port)) {
      if (connection.kind !== "value") continue;
      const target = connection.target;
      this.enqueue(() => this.deliverInput(target.objectId, target.port));
    }
    this.outputEvents.emit({ objectId, port, value });
  }

  private emitEvent(objectId: string, event: string, payload: JsonValue | undefined): void {
    for (const connection of connectionsFrom(this.store.graph, objectId, event)) {
      if (connection.kind !== "event") continue;
      const target = connection.target;
      this.enqueue(() => this.runAction(target.objectId, target.port, payload));
    }
    this.emitted.emit({ objectId, event, payload });
  }

  private contextFor(objectId: string, entry: Live): ComponentContext {
    const runtime = this;
    const mine = (targetId: string): boolean =>
      descendantsOf(runtime.store.graph, objectId).some((object) => object.id === targetId);
    return {
      get object() {
        return runtime.store.graph.objects[objectId] as ClaspObject;
      },
      get props() {
        const object = runtime.store.graph.objects[objectId];
        return object ? runtime.propsOf(object) : {};
      },
      clasp: this.clasp,
      get alive() {
        return entry.alive && runtime.state === "running";
      },
      input: (port) => this.getInput(objectId, port),
      isConnected: (port) =>
        Object.values(this.store.graph.connections).some(
          (connection) => connection.kind === "value" && connection.target.objectId === objectId && connection.target.port === port,
        ),
      output: (port) => this.getOutput(objectId, port),
      setOutput: (port, value) => {
        if (!entry.alive || this.state !== "running") return;
        this.writeOutput(objectId, port, value);
        this.flush();
      },
      emit: (event, payload) => {
        if (!entry.alive || this.state !== "running") return;
        this.emitEvent(objectId, event, payload === undefined ? undefined : deepClone(payload));
        this.flush();
      },
      getState: <T extends JsonValue>(key: string) => this.memory.get(objectId)?.get(key) as T | undefined,
      setState: (key, value) => {
        let slots = this.memory.get(objectId);
        if (!slots) {
          slots = new Map();
          this.memory.set(objectId, slots);
        }
        if (value === undefined) slots.delete(key);
        else slots.set(key, deepClone(value));
        this.touch();
      },
      descendants: () => descendantsOf(this.store.graph, objectId),
      peek: (targetId, port) => (mine(targetId) ? this.getOutput(targetId, port) : undefined),
      call: (targetId, action, payload) => {
        if (!mine(targetId)) return;
        this.enqueue(() => this.runAction(targetId, action, payload));
        this.flush();
      },
      configure: (patch) => {
        this.store.transact([{ op: "update", objectId, properties: patch }], {
          origin: "runtime",
          label: `Configure ${this.store.graph.objects[objectId]?.metadata.name ?? "object"}`,
        });
      },
      run: (task, onError, options) => {
        const work = (async () => {
          try {
            await task();
          } catch (error) {
            const claspError = toClaspError(error);
            if (onError && entry.alive) {
              try {
                onError(claspError);
              } catch (handlerError) {
                this.reportFailure(objectId, handlerError);
              }
            } else if (entry.alive) {
              this.reportFailure(objectId, claspError);
            }
          }
        })();
        if (!options?.background) this.pending.add(work);
        void work.finally(() => {
          this.pending.delete(work);
          this.flush();
          this.notify();
        });
      },
      fail: (error) => {
        this.reportFailure(objectId, error);
        this.notify();
      },
      setInterval: (callback, ms) => {
        const handle = this.timers.setInterval(
          () => {
            if (!entry.alive || this.state !== "running") return;
            this.guard(objectId, callback);
            this.flush();
          },
          Math.max(10, ms),
        );
        const cancel = (): void => this.timers.clearInterval(handle);
        entry.disposers.push(cancel);
        return cancel;
      },
    };
  }

  // ── live reconciliation with graph edits ────────────────────────────────

  private reconcile(event: GraphEvent): void {
    if (this.state !== "running") return;
    const { previous, graph } = event;
    const { order, cyclic } = executionOrder(graph);
    if (cyclic.length > 0) {
      this.halt("The graph now contains a value-dependency cycle and cannot be executed.");
      this.notify();
      return;
    }

    for (const id of Object.keys(previous.objects)) {
      if (graph.objects[id]) continue;
      this.dispose(id);
      this.outputs.delete(id);
      this.memory.delete(id);
      this.failures.delete(id);
      for (const key of [...this.externalInputs.keys()]) {
        if (key.startsWith(`${id}.`)) this.externalInputs.delete(key);
      }
    }

    const refresh = new Map<string, { objectId: string; port: string }>();
    const markInput = (objectId: string, port: string): void => {
      if (graph.objects[objectId]) refresh.set(`${objectId}.${port}`, { objectId, port });
    };
    for (const [id, connection] of Object.entries(previous.connections)) {
      if (graph.connections[id] !== connection && connection.kind === "value") {
        markInput(connection.target.objectId, connection.target.port);
      }
    }
    for (const [id, connection] of Object.entries(graph.connections)) {
      if (previous.connections[id] !== connection && connection.kind === "value") {
        markInput(connection.target.objectId, connection.target.port);
      }
    }

    const rebuilt: string[] = [];
    const wasHolding = this.holding;
    this.holding = true;
    for (const id of order) {
      const before = previous.objects[id];
      const after = graph.objects[id] as ClaspObject;
      const changed = !before || before.type !== after.type || !deepEqual(before.properties, after.properties);
      if (!changed && this.live.has(id)) continue;
      if (!changed && !this.registry.has(after.type)) continue;
      this.dispose(id);
      this.outputs.delete(id); // stale outputs must not outlive the configuration that produced them
      this.instantiate(id);
      rebuilt.push(id);
      for (const connection of connectionsFrom(graph, id)) {
        if (connection.kind === "value") markInput(connection.target.objectId, connection.target.port);
      }
    }
    this.holding = wasHolding;

    for (const { objectId, port } of refresh.values()) {
      if (!rebuilt.includes(objectId)) this.enqueue(() => this.deliverInput(objectId, port));
    }
    this.startInstances(rebuilt);
    this.touch();
    this.flush();
  }
}
