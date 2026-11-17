import type { ProviderStatus } from "@clasp/ai";
import type { ClaspGraph, GraphOperation } from "@clasp/core";
import { useGraph } from "@clasp/renderer-react";
import type { AppHandle } from "@clasp/runtime";
import { AppWindow, ArrowRight, Check, CircleSlash, Link2, Minus, Pencil, Plus, RefreshCw, Sparkles, Unlink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { Badge, Button, CommitInput, Field, INPUT, IconButton, cx } from "./ui";

const NEW_APP_SUGGESTIONS = [
  "A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and filter to vegetarian ones.",
  "A calendar for my events, with a month view and a form to add events.",
  "Create a simple task manager with a title field, an Add Task button, and a list of tasks.",
];
const CHANGE_SUGGESTIONS = ["Add a filter to show only incomplete tasks.", "Let me search by title.", "Make a calendar app."];

function nameOf(graph: ClaspGraph | undefined, id: string): string {
  const object = graph?.objects[id];
  return object?.metadata.name ?? object?.type ?? "object";
}

/** One graph operation, in words. */
function OperationLine({ operation, preview, base }: { operation: GraphOperation; preview: ClaspGraph; base: ClaspGraph }): ReactNode {
  const row = (icon: ReactNode, tone: string, content: ReactNode): ReactNode => (
    <li className="flex items-start gap-2 py-1 text-xs leading-snug text-ink">
      <span className={cx("mt-px grid size-4 shrink-0 place-items-center rounded", tone)}>{icon}</span>
      <span className="min-w-0 break-words">{content}</span>
    </li>
  );
  switch (operation.op) {
    case "create": {
      const parent = operation.object.parentId ? nameOf(preview, operation.object.parentId) : undefined;
      return row(
        <Plus className="size-3" />,
        "bg-success-soft text-success",
        <>
          Add <span className="font-medium">{operation.object.name ?? operation.object.type}</span>{" "}
          <code className="text-[10px] text-ink-faint">{operation.object.type}</code>
          {parent && <span className="text-ink-soft"> in {parent}</span>}
        </>,
      );
    }
    case "update":
      return row(
        <Pencil className="size-3" />,
        "bg-warning-soft text-warning",
        <>
          Change <span className="font-medium">{nameOf(preview, operation.objectId)}</span>
          {operation.properties && <span className="text-ink-soft"> — {Object.keys(operation.properties).join(", ")}</span>}
        </>,
      );
    case "delete":
      return row(<Minus className="size-3" />, "bg-danger-soft text-danger", <>Remove <span className="font-medium">{nameOf(base, operation.objectId)}</span></>);
    case "connect": {
      const { source, target } = operation.connection;
      return row(
        <Link2 className="size-3" />,
        "bg-accent-soft text-accent-ink",
        <>
          <span className="font-medium">{nameOf(preview, source.objectId)}</span>.{source.port} <ArrowRight className="inline size-3 text-ink-faint" />{" "}
          <span className="font-medium">{nameOf(preview, target.objectId)}</span>.{target.port}
        </>,
      );
    }
    case "disconnect": {
      const connection = base.connections[operation.connectionId];
      return row(
        <Unlink className="size-3" />,
        "bg-subtle text-ink-soft",
        connection ? (
          <>
            Disconnect <span className="font-medium">{nameOf(base, connection.source.objectId)}</span>.{connection.source.port} from{" "}
            <span className="font-medium">{nameOf(base, connection.target.objectId)}</span>.{connection.target.port}
          </>
        ) : (
          "Disconnect a wire"
        ),
      );
    }
    default:
      return row(<Pencil className="size-3" />, "bg-subtle text-ink-soft", "Change the application's settings");
  }
}

function ProviderBar({ status, checking, onRefresh }: { status: ProviderStatus | undefined; checking: boolean; onRefresh: () => void }): ReactNode {
  const studio = useStudio();
  const [open, setOpen] = useState(false);
  const scripted = studio.ai.provider === "scripted";
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={cx(
            "size-2 shrink-0 rounded-full",
            checking ? "animate-pulse bg-line-strong" : status?.available ? (scripted ? "bg-warning" : "bg-success") : "bg-danger",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" data-testid="ai-status">
          {checking
            ? "Checking for a local model…"
            : scripted
              ? "Scripted demo provider — not an AI"
              : status?.available
                ? `Local model ready · ${status.model ?? ""}`
                : "No local model available"}
        </span>
        <button type="button" className="text-xs font-medium text-ink-soft hover:text-ink" onClick={() => setOpen((value) => !value)}>
          {open ? "Done" : "Settings"}
        </button>
        <IconButton label="Check again" onClick={onRefresh} className="size-6">
          <RefreshCw className={cx("size-3.5", checking && "animate-spin")} />
        </IconButton>
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <Field label="Provider" htmlFor="ai-provider">
            <select
              id="ai-provider"
              className={INPUT}
              data-testid="ai-provider"
              value={studio.ai.provider}
              onChange={(event) => studio.setAi({ provider: event.target.value === "scripted" ? "scripted" : "ollama" })}
            >
              <option value="ollama">Ollama (local model)</option>
              <option value="scripted">Scripted demo provider (not an AI)</option>
            </select>
          </Field>
          {scripted ? (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
              This provider performs no inference. It replays predefined plans for two fixed requests so the propose → validate → approve flow can be tried without a
              model. Use Ollama for real generation.
            </p>
          ) : (
            <>
              <Field label="Server" hint="Any Ollama-compatible endpoint. Nothing leaves your machine unless you point this elsewhere." htmlFor="ai-url">
                <CommitInput id="ai-url" label="Server URL" value={studio.ai.baseUrl} onCommit={(baseUrl) => studio.setAi({ baseUrl: baseUrl.trim() || "http://localhost:11434" })} />
              </Field>
              <Field label="Model" htmlFor="ai-model">
                <select
                  id="ai-model"
                  className={INPUT}
                  value={studio.ai.model ?? ""}
                  onChange={(event) => studio.setAi(event.target.value ? { model: event.target.value } : { model: undefined })}
                >
                  <option value="">Automatic{status?.model ? ` (${status.model})` : ""}</option>
                  {(status?.models ?? []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The AI creation panel. The model only ever *proposes* graph operations;
 * they are validated against the real graph and component registry, shown
 * here, and applied — as one undoable transaction — only when approved.
 */
export function AiPanel({ app }: { app: AppHandle }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(app.store);
  // The conversation lives in the session: requests keep running if this panel switches app or closes.
  const thread = studio.aiThreads.get(app.id);
  const entries = thread.entries;
  const busy = thread.busy;
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ProviderStatus | undefined>(undefined);
  const [checking, setChecking] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    setChecking(true);
    void studio
      .provider()
      .status()
      .then((next) => {
        setStatus(next);
        setChecking(false);
      });
  }, [studio, studio.ai.provider, studio.ai.baseUrl, studio.ai.model]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [entries.length, busy]);
  const submit = (text: string): void => {
    if (!text.trim() || busy) return;
    setDraft("");
    void studio.aiThreads.ask(app.id, text).then(() => {
      if (studio.aiThreads.get(app.id).entries.at(-1)?.kind === "error") refresh();
    });
  };

  const unavailable = !checking && status !== undefined && !status.available;
  const empty = Object.keys(graph.objects).length === 0;

  return (
    <aside className="flex w-[400px] shrink-0 animate-fade flex-col border-l border-line bg-surface" data-testid="ai-panel">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight text-ink">Build with AI</div>
          <div className="truncate text-xs text-ink-faint">Proposes changes to “{graph.metadata.name}”. You approve them.</div>
        </div>
        <IconButton label="Close AI panel" onClick={() => studio.setAiOpen(false)}>
          <X className="size-4" />
        </IconButton>
      </header>
      <ProviderBar status={status} checking={checking} onRefresh={refresh} />

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {unavailable && (
          <div className="rounded-xl border border-line bg-canvas/70 p-4 text-sm" data-testid="ai-unavailable">
            <div className="flex items-center gap-2 font-medium text-ink">
              <CircleSlash className="size-4 text-ink-soft" />
              AI generation is temporarily unavailable
            </div>
            <p className="mt-1.5 leading-relaxed text-ink-soft">{status?.reason}</p>
            <p className="mt-2 leading-relaxed text-ink-soft">Existing applications keep working, saved graphs stay accessible, and Build mode lets you edit by hand.</p>
          </div>
        )}
        {entries.length === 0 && !unavailable && (
          <div className="flex flex-col gap-2">
            <p className="text-sm leading-relaxed text-ink-soft">
              {empty ? "Describe the application you want — what it keeps track of and what you want to do with it." : "Describe what to add or change."} You
              talk about features; Clasp works out the components and wiring. Nothing runs generated code.
            </p>
            {(empty ? NEW_APP_SUGGESTIONS : CHANGE_SUGGESTIONS).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setDraft(suggestion)}
                className="rounded-xl border border-line px-3 py-2.5 text-left text-sm leading-snug text-ink transition-colors hover:border-accent hover:bg-accent-soft/40"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {entries.map((entry) => {
          if (entry.kind === "request") {
            return (
              <div key={entry.id} className="ml-8 self-end rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm leading-snug text-white">
                {entry.text}
              </div>
            );
          }
          if (entry.kind === "error") {
            return (
              <div key={entry.id} className="rounded-xl border border-danger/25 bg-danger-soft p-3.5 text-sm" data-testid="ai-error">
                <div className="font-medium text-danger">{entry.title}</div>
                <p className="mt-1 leading-relaxed text-danger/90">{entry.message}</p>
                {entry.details.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-danger/85">
                    {entry.details.map((detail, index) => (
                      <li key={index}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          }
          const { proposal } = entry;
          const isNew = proposal.target.kind === "new";
          const canSwitch = entry.state === "pending" && Object.keys(graph.objects).length > 0;
          const created = entry.createdAppId ? studio.workspace?.app(entry.createdAppId) : undefined;
          return (
            <div key={entry.id} className="rounded-xl border border-line bg-surface" data-testid="ai-proposal" data-state={entry.state} data-target={proposal.target.kind}>
              <div
                className={cx("flex items-center gap-2 border-b border-line px-3.5 py-2 text-xs", isNew ? "bg-accent-soft/60 text-accent-ink" : "bg-subtle/60 text-ink-soft")}
                data-testid="ai-target"
              >
                <AppWindow className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {isNew ? (
                    <>
                      Creates a new application <span className="font-semibold">“{proposal.target.kind === "new" ? proposal.target.name : ""}”</span>
                    </>
                  ) : (
                    <>
                      Changes <span className="font-semibold">“{graph.metadata.name}”</span>
                    </>
                  )}
                </span>
                {canSwitch && (
                  <button
                    type="button"
                    data-testid="ai-switch-target"
                    className="shrink-0 font-medium underline-offset-2 hover:underline"
                    onClick={() =>
                      studio.retargetProposal(
                        app.id,
                        entry.id,
                        isNew ? { kind: "current" } : { kind: "new", name: proposal.plan.title ?? "New app" },
                      )
                    }
                  >
                    {isNew ? `Add to “${graph.metadata.name}” instead` : "Make it a new app instead"}
                  </button>
                )}
              </div>
              <div className="border-b border-line px-3.5 py-3">
                <div className="text-sm font-medium leading-snug text-ink">{proposal.summary}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Badge tone={proposal.provider.kind === "llm" ? "accent" : "warning"}>
                    {proposal.provider.kind === "llm" ? (proposal.provider.model ?? "local model") : "scripted — not an AI"}
                  </Badge>
                  <Badge>{proposal.operations.length} changes</Badge>
                  {proposal.attempts > 1 && <Badge title="Invalid plans were sent back for correction">valid after {proposal.attempts} attempts</Badge>}
                </div>
              </div>
              {proposal.features.length > 0 && (
                <ul className="flex flex-col gap-1.5 px-3.5 py-3" data-testid="ai-features">
                  {proposal.features.map((line, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm leading-snug text-ink">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-accent" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              <details className={cx("group px-3.5", proposal.features.length > 0 ? "border-t border-line py-2" : "py-2")} open={proposal.features.length === 0}>
                <summary className="cursor-pointer list-none text-xs font-medium text-ink-soft hover:text-ink">
                  {proposal.features.length > 0 ? `Show the ${proposal.operations.length} underlying changes` : "Changes"}
                </summary>
                <ul className="max-h-64 overflow-y-auto pt-1.5">
                  {proposal.operations.map((operation, index) => (
                    <OperationLine key={index} operation={operation} preview={proposal.preview} base={entry.base} />
                  ))}
                </ul>
              </details>
              <div className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-2.5">
                {entry.state === "pending" ? (
                  <>
                    <Button size="sm" onClick={() => void studio.decideProposal(app.id, entry.id, false)} data-testid="ai-discard">
                      Discard
                    </Button>
                    <Button size="sm" tone="primary" icon={<Check className="size-3.5" />} onClick={() => void studio.decideProposal(app.id, entry.id, true)} data-testid="ai-apply">
                      {isNew ? "Create app" : "Apply changes"}
                    </Button>
                  </>
                ) : entry.state === "applied" && entry.createdAppId ? (
                  <>
                    <span className="mr-auto flex items-center gap-1.5 text-xs font-medium text-success">
                      <Check className="size-3.5" /> Created{created ? ` “${created.store.graph.metadata.name}”` : ""}
                    </span>
                    {created && (
                      <Button size="sm" tone="ghost" onClick={() => studio.selectApp(created.id)}>
                        Open
                      </Button>
                    )}
                  </>
                ) : entry.state === "applied" ? (
                  <>
                    <span className="mr-auto flex items-center gap-1.5 text-xs font-medium text-success">
                      <Check className="size-3.5" /> Applied
                    </span>
                    <Button size="sm" tone="ghost" disabled={!app.store.canUndo} onClick={() => app.store.undo()}>
                      Undo
                    </Button>
                  </>
                ) : (
                  <span className="mr-auto text-xs text-ink-faint">Discarded — nothing changed</span>
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-2.5 rounded-xl border border-line px-3.5 py-3 text-sm text-ink-soft" data-testid="ai-busy">
            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            <span className="min-w-0 flex-1">{busy}</span>
            <button type="button" className="text-xs font-medium text-ink-soft hover:text-ink" onClick={() => studio.aiThreads.cancel(app.id)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <div className="rounded-xl border border-line-strong bg-surface transition-shadow focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
          <textarea
            value={draft}
            rows={3}
            data-testid="ai-input"
            aria-label="Describe what to build or change"
            placeholder={empty ? "Describe an application…" : "Describe a change…"}
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit(draft);
              }
            }}
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="px-1 text-[11px] text-ink-faint">Enter to send · Shift+Enter for a new line</span>
            <Button type="submit" size="sm" tone="primary" disabled={!draft.trim() || busy !== undefined} data-testid="ai-send">
              Propose
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
