import { Check, Copy, GraduationCap, Hand, Sparkles, Target, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { TUTORIALS, type Tutorial, type TutorialStep } from "../studio/tutorials";
import { Button, Dialog, cx } from "./ui";

/** Renders `**bold**` in step text. */
function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <strong key={index} className="font-semibold text-ink">
            {part}
          </strong>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Example({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-line bg-surface p-2">
      <code className="min-w-0 flex-1 break-words font-sans text-xs leading-snug text-ink" data-testid="tutorial-example">
        {text}
      </code>
      <button
        type="button"
        aria-label="Copy"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
          setTimeout(() => setCopied(false), 1500);
        }}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-subtle hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** Choose a tutorial. */
export function TutorialPicker(): ReactNode {
  const studio = useStudio();
  if (!studio.tutorialPickerOpen) return null;
  const icon = (tutorial: Tutorial): ReactNode => (tutorial.id === "with-ai" ? <Sparkles className="size-5" /> : <Hand className="size-5" />);
  return (
    <Dialog
      title="Learn Clasp"
      description="Two short tutorials. Each runs right here in your workspace and ticks itself off as you go."
      onClose={() => studio.setTutorialPicker(false)}
      width="max-w-xl"
      testId="tutorial-picker"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {TUTORIALS.map((tutorial) => (
          <button
            key={tutorial.id}
            type="button"
            data-testid={`start-tutorial-${tutorial.id}`}
            onClick={() => studio.startTutorial(tutorial.id)}
            className="flex flex-col items-start gap-2 rounded-2xl border border-line bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-pop"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-ink">{icon(tutorial)}</span>
            <span className="text-[15px] font-semibold tracking-tight text-ink">{tutorial.title}</span>
            <span className="text-sm leading-relaxed text-ink-soft">{tutorial.summary}</span>
            <span className="mt-auto text-xs text-ink-faint">
              {tutorial.steps.length} steps · about {tutorial.minutes} minutes
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** The running tutorial, docked in the sidebar so it never covers the work. */
export function TutorialCard(): ReactNode {
  const studio = useStudio();
  const tutorial = studio.activeTutorial;
  if (!tutorial || studio.status !== "ready") return null;
  const context = { studio, app: studio.tutorialApp };
  // Steps complete in order: a step only counts once every step before it is done.
  const done: boolean[] = [];
  for (const step of tutorial.steps) {
    let ok = false;
    try {
      ok = step.done(context);
    } catch {
      ok = false;
    }
    done.push(ok && done.every(Boolean));
  }
  const current = done.findIndex((value) => !value);
  const finished = current === -1;
  const count = done.filter(Boolean).length;

  return (
    <section
      className="flex max-h-[42vh] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-accent/30 bg-surface shadow-sm"
      data-testid="tutorial"
      data-tutorial={tutorial.id}
      data-step={finished ? "finished" : tutorial.steps[current]?.id}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <GraduationCap className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{tutorial.title}</span>
        <span className="text-[11px] tabular-nums text-ink-faint" data-testid="tutorial-progress">
          {count}/{tutorial.steps.length}
        </span>
        <button type="button" aria-label="Exit tutorial" title="Exit tutorial" onClick={() => studio.endTutorial()} className="grid size-5 place-items-center rounded text-ink-faint hover:bg-subtle hover:text-ink">
          <X className="size-3.5" />
        </button>
      </header>
      <div className="h-1 bg-subtle">
        <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${(count / tutorial.steps.length) * 100}%` }} />
      </div>
      <ol className="min-h-0 overflow-y-auto px-2 py-2">
        {tutorial.steps.map((step, index) => (
          <StepRow key={step.id} step={step} index={index} done={done[index] === true} current={index === current} />
        ))}
      </ol>
      {finished && (
        <div className="border-t border-line bg-success-soft/60 px-3 py-2.5 text-xs leading-relaxed text-ink" data-testid="tutorial-finished">
          <div className="mb-1 font-semibold text-success">All done!</div>
          {tutorial.finished}
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" tone="primary" onClick={() => studio.endTutorial()}>
              Finish
            </Button>
            <Button size="sm" onClick={() => studio.setTutorialPicker(true)}>
              Another tutorial
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function StepRow(props: { step: TutorialStep; index: number; done: boolean; current: boolean }): ReactNode {
  const studio = useStudio();
  const { step, done, current } = props;
  return (
    <li className={cx("rounded-lg px-1.5 py-1", current && "bg-accent-soft/50")} data-testid="tutorial-step" data-done={done ? "true" : "false"} data-current={current ? "true" : "false"}>
      <div className="flex items-start gap-2">
        <span
          className={cx(
            "mt-px grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-semibold",
            done ? "bg-success text-white" : current ? "bg-accent text-white" : "border border-line-strong text-ink-faint",
          )}
        >
          {done ? <Check className="size-2.5" strokeWidth={3} /> : props.index + 1}
        </span>
        <span className={cx("text-xs leading-snug", done ? "text-ink-faint line-through" : current ? "font-semibold text-ink" : "text-ink-soft")}>{step.title}</span>
      </div>
      {current && (
        <div className="mt-1.5 pl-6 text-xs leading-relaxed text-ink-soft">
          <Rich text={step.body} />
          {step.example && <Example text={step.example} />}
          {step.target && (
            <button
              type="button"
              data-testid="tutorial-show-me"
              onClick={() => studio.showMe(step.target)}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent-ink hover:bg-accent-soft"
            >
              <Target className="size-3" /> Show me
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Draws a pulsing ring around the control a step points at. */
export function Highlighter(): ReactNode {
  const studio = useStudio();
  const selector = studio.highlight;
  const [rect, setRect] = useState<DOMRect | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useLayoutEffect(() => {
    if (!selector) {
      setRect(undefined);
      return;
    }
    const element = document.querySelector(selector);
    if (!element) {
      setMissing(true);
      setRect(undefined);
    } else {
      setMissing(false);
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      setRect(element.getBoundingClientRect());
    }
    const timer = setTimeout(() => studio.showMe(undefined), 3500);
    return () => clearTimeout(timer);
  }, [selector, studio]);

  useEffect(() => {
    if (missing && selector) studio.toast({ tone: "info", message: "That control is not on screen right now — the step's text says where to find it (Build or Use mode, or the AI panel)." });
  }, [missing]);

  if (!rect) return null;
  return (
    <div
      aria-hidden
      data-testid="tutorial-highlight"
      className="pointer-events-none fixed z-[70] animate-pulse rounded-xl ring-4 ring-accent ring-offset-2"
      style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
    />
  );
}
