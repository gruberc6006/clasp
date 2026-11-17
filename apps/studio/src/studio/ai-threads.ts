import type { AssistantProgress, GraphAssistant, Proposal, ProposalTarget } from "@clasp/ai";
import { isClaspError, toClaspError, type ClaspGraph } from "@clasp/core";
import type { AppHandle } from "@clasp/runtime";

export type AiEntry =
  | { id: number; kind: "request"; text: string }
  | {
      id: number;
      kind: "proposal";
      proposal: Proposal;
      /** The graph the proposal was made against, for describing removals. */
      base: ClaspGraph;
      state: "pending" | "applied" | "discarded";
      /** Set when applying created a new application. */
      createdAppId?: string;
    }
  | { id: number; kind: "error"; title: string; message: string; details: string[] };

/** An entry before it is given its id (distributes over the union, so each kind keeps its own fields). */
type NewEntry = AiEntry extends infer Entry ? (Entry extends AiEntry ? Omit<Entry, "id"> : never) : never;

export interface AiThread {
  entries: AiEntry[];
  /** What the assistant is doing right now, while a request runs. */
  busy?: string;
}

interface Host {
  bump(): void;
  assistant(): GraphAssistant;
  app(id: string): AppHandle | undefined;
  /** Called when the provider turned out to be unreachable. */
  onUnavailable(): void;
}

/**
 * The AI conversations, one per application. They live outside the panel so a
 * request keeps running — and its answer is kept — when the panel switches to
 * another application or is closed.
 */
export class AiThreads {
  private readonly threads = new Map<string, AiThread>();
  private readonly controllers = new Map<string, AbortController>();
  private nextId = 1;

  constructor(private readonly host: Host) {}

  get(appId: string): AiThread {
    return this.threads.get(appId) ?? { entries: [] };
  }

  private update(appId: string, change: (thread: AiThread) => AiThread): void {
    this.threads.set(appId, change(this.get(appId)));
    this.host.bump();
  }

  private push(appId: string, entry: NewEntry): void {
    this.update(appId, (thread) => ({ ...thread, entries: [...thread.entries, { ...entry, id: this.nextId++ } as AiEntry] }));
  }

  isBusy(appId: string): boolean {
    return this.controllers.has(appId);
  }

  async ask(appId: string, text: string): Promise<void> {
    const request = text.trim();
    const app = this.host.app(appId);
    if (!request || !app || this.isBusy(appId)) return;
    this.push(appId, { kind: "request", text: request });
    const controller = new AbortController();
    this.controllers.set(appId, controller);
    const setBusy = (busy: string | undefined): void => this.update(appId, (thread) => ({ ...thread, ...(busy ? { busy } : { busy: undefined }) }));
    setBusy("Thinking…");
    const base = app.store.graph;
    try {
      const proposal = await this.host.assistant().propose({
        request,
        graph: base,
        signal: controller.signal,
        onProgress: (progress: AssistantProgress) => {
          if (progress.stage === "asking") setBusy(progress.attempt === 1 ? "Asking the model…" : `Asking again (attempt ${progress.attempt})…`);
          if (progress.stage === "validating") setBusy("Checking the plan…");
          if (progress.stage === "repairing") setBusy(`The plan had ${progress.issues.length} problem${progress.issues.length === 1 ? "" : "s"}; asking for a correction…`);
        },
      });
      this.push(appId, { kind: "proposal", proposal, base, state: "pending" });
    } catch (error) {
      if (controller.signal.aborted) {
        this.push(appId, { kind: "error", title: "Cancelled", message: "The request was cancelled. Nothing changed.", details: [] });
      } else {
        const claspError = toClaspError(error);
        const unavailable = claspError.code === "UNAVAILABLE";
        this.push(appId, {
          kind: "error",
          title: unavailable ? "AI generation is unavailable right now" : "No valid plan was produced",
          message: unavailable
            ? `${claspError.message} Your applications keep running, and you can keep editing by hand in Build mode.`
            : `${claspError.message} Nothing was changed.`,
          details: isClaspError(error) ? claspError.issues.map((entry) => entry.message).slice(0, 6) : [],
        });
        if (unavailable) this.host.onUnavailable();
      }
    } finally {
      this.controllers.delete(appId);
      setBusy(undefined);
    }
  }

  cancel(appId: string): void {
    this.controllers.get(appId)?.abort();
  }

  proposal(appId: string, entryId: number): Extract<AiEntry, { kind: "proposal" }> | undefined {
    const entry = this.get(appId).entries.find((candidate) => candidate.id === entryId);
    return entry?.kind === "proposal" ? entry : undefined;
  }

  replace(appId: string, entryId: number, patch: Partial<Extract<AiEntry, { kind: "proposal" }>>): void {
    this.update(appId, (thread) => ({
      ...thread,
      entries: thread.entries.map((entry) => (entry.id === entryId && entry.kind === "proposal" ? { ...entry, ...patch } : entry)),
    }));
  }

  /** Rebuilds a pending proposal for the other target (no model call). */
  retarget(appId: string, entryId: number, target: ProposalTarget): void {
    const entry = this.proposal(appId, entryId);
    const app = this.host.app(appId);
    if (!entry || !app || entry.state !== "pending") return;
    const proposal = this.host.assistant().retarget(entry.proposal, target, app.store.graph);
    this.replace(appId, entryId, { proposal, base: target.kind === "new" ? proposal.preview : app.store.graph });
  }

  /** Stops everything (e.g. when the workspace closes). */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.threads.clear();
  }
}
