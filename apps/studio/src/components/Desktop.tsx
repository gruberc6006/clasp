import { childrenOf, type JsonValue } from "@clasp/core";
import { AppView, defaultRenderers, useGraph, useRuntimeVersion } from "@clasp/renderer-react";
import type { AppHandle } from "@clasp/runtime";
import { AlertTriangle, Blocks, Maximize2, Minimize2, Minus, RotateCcw, Sparkles, Workflow, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useStudio, useWorkspace } from "../studio/hooks";
import { desktopBackground } from "../studio/appearance";
import { windowKey, type WindowState } from "../studio/session";
import { Button, cx } from "./ui";

/** One window on the desktop: a top-level ui.window, or an app's loose top-level elements. */
interface DesktopEntry {
  key: string;
  app: AppHandle;
  /** The ui.window object, or undefined for the loose-elements window. */
  objectId: string | undefined;
  rootIds: string[];
  /** Width the window asks for when it first opens. */
  preferredWidth: number;
}

interface Size {
  width: number;
  height: number;
}

const MARGIN = 20;
const BAR_SPACE = 76;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 180;
const ESTIMATED_HEIGHT = 420;
const WIDTHS: Record<string, number> = { narrow: 400, regular: 520, wide: 860 };

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Every window the workspace's applications want on screen, in a stable order. */
function collectEntries(apps: AppHandle[]): DesktopEntry[] {
  const entries: DesktopEntry[] = [];
  for (const app of apps) {
    const roots = childrenOf(app.store.graph, undefined).filter((object) => defaultRenderers[object.type] !== undefined);
    const loose: string[] = [];
    for (const root of roots) {
      if (root.type === "ui.window") {
        entries.push({
          key: windowKey(app.id, root.id),
          app,
          objectId: root.id,
          rootIds: [root.id],
          preferredWidth: WIDTHS[text(root.properties.width)] ?? WIDTHS.regular!,
        });
      } else {
        loose.push(root.id);
      }
    }
    // Visible elements outside any window still get a window, titled after their app.
    if (loose.length > 0) entries.push({ key: windowKey(app.id, "loose"), app, objectId: undefined, rootIds: loose, preferredWidth: WIDTHS.regular! });
  }
  return entries;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * First position for a new window: beside the open windows if there is room
 * (narrowing it a little if that makes it fit), otherwise cascaded from the
 * front-most window.
 */
function placeNew(width: number, desk: Size, taken: Array<Rect & { z: number }>): Omit<WindowState, "z"> {
  const right = desk.width - MARGIN;
  const candidates = [{ x: MARGIN, y: MARGIN }, ...taken.map((rect) => ({ x: rect.x + rect.width + MARGIN, y: rect.y }))];
  for (const candidate of candidates) {
    const fitted = Math.min(width, right - candidate.x);
    if (fitted < Math.min(width, 440)) continue;
    const rect = { x: candidate.x, y: candidate.y, width: fitted, height: ESTIMATED_HEIGHT };
    if (!taken.some((other) => overlaps(rect, other))) return { x: rect.x, y: rect.y, width: fitted };
  }
  // No room beside the others: open near the top, centred, at the width the window asks for,
  // stepping down and across a little per open window so title bars stay visible.
  const fitted = Math.max(MIN_WIDTH, Math.min(width, desk.width - 2 * MARGIN));
  const centred = Math.round((desk.width - fitted) / 2);
  const at = (step: number): { x: number; y: number } => ({
    x: Math.min(Math.max(MARGIN, centred - 64 + step * 32), Math.max(MARGIN, right - fitted)),
    y: MARGIN + step * 32,
  });
  // The first slot whose title bar is not already covered by another window's.
  let step = 0;
  while (step < 8 && taken.some((rect) => Math.abs(rect.x - at(step).x) < 24 && Math.abs(rect.y - at(step).y) < 24)) step++;
  return { ...at(step), width: fitted };
}

function useDeskSize(ref: RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

type Gesture =
  | { kind: "move"; pointerX: number; pointerY: number; start: Rect }
  | { kind: "resize"; edge: "e" | "s" | "se"; pointerX: number; pointerY: number; start: Rect };

/** Full class strings, so Tailwind can see them: coloured when the window is focused or the lights are hovered. */
const LIGHTS = {
  close: { on: "bg-[#ff5f57]", off: "bg-line-strong group-hover:bg-[#ff5f57]" },
  minimize: { on: "bg-[#febc2e]", off: "bg-line-strong group-hover:bg-[#febc2e]" },
  maximize: { on: "bg-[#28c840]", off: "bg-line-strong group-hover:bg-[#28c840]" },
} as const;

function TrafficLights(props: { focused: boolean; maximized: boolean; onClose: () => void; onMinimize: () => void; onMaximize: () => void }): ReactNode {
  const light = (label: string, color: (typeof LIGHTS)[keyof typeof LIGHTS], glyph: ReactNode, onClick: () => void, testId: string): ReactNode => (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cx(
        "grid size-3 place-items-center rounded-full text-black/60 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        props.focused ? color.on : color.off,
      )}
    >
      <span className="opacity-0 transition-opacity group-hover:opacity-100">{glyph}</span>
    </button>
  );
  return (
    <div className="group flex items-center gap-2">
      {light("Close window", LIGHTS.close, <X className="size-2" strokeWidth={3} />, props.onClose, "window-close")}
      {light("Minimize window", LIGHTS.minimize, <Minus className="size-2" strokeWidth={3} />, props.onMinimize, "window-minimize")}
      {light(
        props.maximized ? "Restore window" : "Maximize window",
        LIGHTS.maximize,
        props.maximized ? <Minimize2 className="size-2" strokeWidth={3} /> : <Maximize2 className="size-2" strokeWidth={3} />,
        props.onMaximize,
        "window-maximize",
      )}
    </div>
  );
}

function DesktopWindow(props: { entry: DesktopEntry; state: WindowState; layer: number; desk: Size; focused: boolean }): ReactNode {
  const { entry, state, desk, focused } = props;
  const studio = useStudio();
  useRuntimeVersion(entry.app.runtime);
  const graph = useGraph(entry.app.store);
  const frame = useRef<HTMLElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const [live, setLive] = useState<Rect | undefined>(undefined);

  const appName = graph.metadata.name;
  const view = entry.objectId ? entry.app.runtime.view(entry.objectId) : undefined;
  const title = text(view?.input("title")) || (entry.objectId ? graph.objects[entry.objectId]?.metadata.name : undefined) || appName;
  const halted = entry.app.runtime.status === "halted";
  const errors = entry.app.runtime.diagnostics().filter((diagnostic) => diagnostic.severity === "error");

  // Keep windows reachable when the desktop shrinks (e.g. the AI panel opens).
  const clampX = (x: number, width: number): number => Math.min(Math.max(x, -(width - 140)), Math.max(0, desk.width - 140));
  const clampY = (y: number): number => Math.min(Math.max(y, 0), Math.max(0, desk.height - 44));

  const rect: Rect = live ?? {
    x: clampX(state.x, state.width),
    y: clampY(state.y),
    width: state.width,
    height: state.height ?? 0,
  };

  const focus = useCallback(() => studio.focusWindow(entry.key, entry.app.id), [studio, entry.key, entry.app.id]);

  const begin = (event: ReactPointerEvent<HTMLElement>, make: (start: Rect) => Gesture): void => {
    if (event.button !== 0 || state.maximized) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const element = frame.current;
    if (!element) return;
    const start: Rect = { x: rect.x, y: rect.y, width: rect.width, height: state.height ?? element.offsetHeight };
    gesture.current = make(start);
    setLive(start);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.pointerX;
    const dy = event.clientY - current.pointerY;
    if (current.kind === "move") {
      setLive({ ...current.start, x: clampX(current.start.x + dx, current.start.width), y: clampY(current.start.y + dy) });
    } else {
      const width = current.edge === "s" ? current.start.width : Math.max(MIN_WIDTH, current.start.width + dx);
      const height = current.edge === "e" ? current.start.height : Math.max(MIN_HEIGHT, current.start.height + dy);
      setLive({ ...current.start, width, height });
    }
  };

  const end = (): void => {
    const current = gesture.current;
    gesture.current = undefined;
    if (!current || !live) {
      setLive(undefined);
      return;
    }
    if (current.kind === "move") studio.updateWindow(entry.key, { x: Math.round(live.x), y: Math.round(live.y) });
    else
      studio.updateWindow(entry.key, {
        width: Math.round(live.width),
        ...(current.edge !== "e" || state.height !== undefined ? { height: Math.round(live.height) } : {}),
      });
    setLive(undefined);
  };

  const style: CSSProperties = state.maximized
    ? { left: 8, top: 8, right: 8, bottom: BAR_SPACE - 8, zIndex: props.layer }
    : {
        left: rect.x,
        top: rect.y,
        width: rect.width,
        ...(live && gesture.current?.kind === "resize" ? { height: rect.height } : state.height !== undefined ? { height: state.height } : {}),
        maxHeight: Math.max(MIN_HEIGHT, desk.height - rect.y - BAR_SPACE + 12),
        zIndex: props.layer,
      };

  return (
    <section
      ref={frame}
      role="region"
      aria-label={`${title} window`}
      data-testid="window"
      data-app-name={appName}
      data-window-title={title}
      data-focused={focused ? "true" : "false"}
      onPointerDownCapture={focus}
      style={style}
      className={cx(
        "absolute flex animate-rise flex-col overflow-hidden rounded-xl border bg-surface",
        live ? "" : "transition-[left,top,width,height,box-shadow] duration-200 ease-out",
        focused ? "border-line-strong shadow-[0_2px_6px_rgb(28_27_25/0.06),0_24px_64px_-24px_rgb(28_27_25/0.45)]" : "border-line shadow-window",
        live?.x !== undefined && gesture.current?.kind === "move" && "cursor-grabbing select-none",
      )}
    >
      <header
        onPointerDown={(event) =>
          begin(event, (start) => ({ kind: "move", pointerX: event.clientX, pointerY: event.clientY, start }))
        }
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => studio.toggleMaximize(entry.key)}
        className={cx(
          "relative flex h-10 shrink-0 select-none items-center gap-3 border-b px-3.5",
          state.maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          focused ? "border-line bg-[color-mix(in_oklab,var(--color-subtle)_80%,var(--color-line))]" : "border-line/70 bg-subtle/80",
        )}
        data-testid="window-titlebar"
      >
        <TrafficLights
          focused={focused}
          maximized={state.maximized === true}
          onClose={() => studio.closeWindow(entry.key)}
          onMinimize={() => studio.minimizeWindow(entry.key)}
          onMaximize={() => studio.toggleMaximize(entry.key)}
        />
        <h2
          className={cx(
            "pointer-events-none absolute inset-x-24 truncate text-center text-[13px] font-semibold tracking-tight",
            focused ? "text-ink" : "text-ink-soft",
          )}
          data-testid="window-title"
        >
          {title}
        </h2>
        {title !== appName && <span className="pointer-events-none ml-auto max-w-36 truncate text-[11px] text-ink-faint">{appName}</span>}
      </header>

      {halted && (
        <div className="flex shrink-0 items-center gap-3 border-b border-danger/20 bg-danger-soft px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{errors.at(-1)?.message ?? "This application was stopped."}</span>
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => entry.app.runtime.restart()}>
            Restart
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entry.objectId ? (
          <AppView app={entry.app} host={studio.host} rootIds={entry.rootIds} framed />
        ) : (
          <div className="p-5">
            <AppView app={entry.app} host={studio.host} rootIds={entry.rootIds} framed />
          </div>
        )}
      </div>

      {!state.maximized && (
        <>
          <div
            aria-hidden
            className="absolute inset-y-3 right-0 w-1.5 cursor-ew-resize"
            onPointerDown={(event) => begin(event, (start) => ({ kind: "resize", edge: "e", pointerX: event.clientX, pointerY: event.clientY, start }))}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
          <div
            aria-hidden
            className="absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize"
            onPointerDown={(event) => begin(event, (start) => ({ kind: "resize", edge: "s", pointerX: event.clientX, pointerY: event.clientY, start }))}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
          <div
            aria-label="Resize window"
            data-testid="window-resize"
            className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
            onPointerDown={(event) => begin(event, (start) => ({ kind: "resize", edge: "se", pointerX: event.clientX, pointerY: event.clientY, start }))}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <svg viewBox="0 0 16 16" className="size-4 text-ink-faint/70">
              <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}
    </section>
  );
}

function WindowBar(props: { entries: DesktopEntry[]; focusedKey: string | undefined }): ReactNode {
  const studio = useStudio();
  // Closed windows stay in the bar (dimmed) so a window never disappears without a way back.
  const shown = props.entries.filter((entry) => studio.windows[entry.key] !== undefined);
  if (shown.length === 0) return null;
  return (
    <nav
      aria-label="Windows"
      data-testid="window-bar"
      className="absolute bottom-3 left-1/2 z-[5000] flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl border border-line bg-surface/85 p-1.5 shadow-pop backdrop-blur-md"
    >
      {shown.map((entry) => {
        const state = studio.windows[entry.key];
        const closed = state?.closed === true;
        const minimized = state?.minimized === true || closed;
        const focused = props.focusedKey === entry.key && !minimized;
        const graph = entry.app.store.graph;
        const title = (entry.objectId && (text(entry.app.runtime.view(entry.objectId)?.input("title")) || graph.objects[entry.objectId]?.metadata.name)) || graph.metadata.name;
        return (
          <button
            key={entry.key}
            type="button"
            data-testid="window-bar-item"
            data-window-title={title}
            data-minimized={minimized ? "true" : "false"}
            data-closed={closed ? "true" : "false"}
            aria-pressed={focused}
            title={`${title === graph.metadata.name ? title : `${title} — ${graph.metadata.name}`}${closed ? " (closed — click to open)" : minimized ? " (minimized)" : ""}`}
            onClick={() => {
              if (minimized || !focused) studio.focusWindow(entry.key, entry.app.id);
              else studio.minimizeWindow(entry.key);
            }}
            className={cx(
              "relative flex h-9 max-w-48 shrink-0 items-center gap-2 rounded-xl px-2.5 text-sm transition-colors",
              focused ? "bg-ink text-canvas" : "text-ink hover:bg-subtle",
              minimized && "text-ink-faint",
              closed && "opacity-70",
            )}
          >
            <span
              className={cx(
                "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-semibold",
                focused ? "bg-white/15 text-white" : "bg-accent-soft text-accent-ink",
                minimized && "opacity-60",
              )}
            >
              {graph.metadata.name.charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{title}</span>
            {!minimized && !focused && <span className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-ink-faint" />}
          </button>
        );
      })}
    </nav>
  );
}

/** Shown when the selected application has no window at all: it is empty, or it runs in the background. */
function Placeholder(props: { app: AppHandle; entries: DesktopEntry[] }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(props.app.store);
  if (props.entries.some((entry) => entry.app.id === props.app.id)) return null;
  const name = graph.metadata.name;
  const empty = Object.keys(graph.objects).length === 0;
  let title: string;
  let body: string;
  let actions: ReactNode;
  if (empty) {
    title = `“${name}” is empty`;
    body = "Add components in Build mode, or describe what you want and let a local model assemble it.";
    actions = (
      <>
        <Button tone="primary" icon={<Blocks className="size-3.5" />} onClick={() => studio.setMode("build")}>
          Open Build mode
        </Button>
        <Button icon={<Sparkles className="size-3.5" />} onClick={() => studio.setAiOpen(true)}>
          Describe it to AI
        </Button>
      </>
    );
  } else {
    title = `“${name}” runs in the background`;
    body = "It has no window. It is running right now; open Build mode to see what it does.";
    actions = (
      <Button icon={<Workflow className="size-3.5" />} onClick={() => studio.setMode("build")}>
        Open Build mode
      </Button>
    );
  }
  return (
    <div
      className="absolute left-1/2 top-8 z-[4000] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 animate-rise rounded-2xl border border-line bg-surface/95 p-5 shadow-pop backdrop-blur"
      data-testid="desktop-placeholder"
    >
      <h3 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">{body}</p>
      <div className="mt-4 flex gap-2">{actions}</div>
    </div>
  );
}

/**
 * Use mode: a desktop where every application in the workspace runs in its
 * own windows. Windows are drawn by the renderer; their placement is
 * presentation state kept by the Studio, never part of any graph.
 */
export function Desktop(): ReactNode {
  const studio = useStudio();
  const background = desktopBackground(studio.appearance);
  const workspace = useWorkspace();
  const desk = useRef<HTMLDivElement>(null);
  const size = useDeskSize(desk);
  const apps = workspace.apps();
  // Recompute when any application is added, removed or edited.
  const revision = apps.map((app) => `${app.id}@${app.store.graph.version}`).join("|");
  const entries = useMemo(() => collectEntries(apps), [revision]);

  // Give windows without a saved position a place, once the desktop has a size.
  const unplaced = entries.filter((entry) => !studio.windows[entry.key]);
  const unplacedKey = unplaced.map((entry) => entry.key).join("|");
  useEffect(() => {
    if (size.width === 0) return;
    const missing = entries.filter((entry) => !studio.windows[entry.key]);
    if (missing.length === 0) return;
    const taken = Object.entries(studio.windows)
      .filter(([key, state]) => !state.closed && !state.minimized && entries.some((entry) => entry.key === key))
      .map(([, state]) => ({ x: state.x, y: state.y, width: state.width, height: state.height ?? ESTIMATED_HEIGHT, z: state.z }));
    const placed: Record<string, Omit<WindowState, "z">> = {};
    let z = Math.max(0, ...taken.map((rect) => rect.z));
    for (const entry of missing) {
      const state = placeNew(entry.preferredWidth, size, taken);
      placed[entry.key] = state;
      taken.push({ x: state.x, y: state.y, width: state.width, height: ESTIMATED_HEIGHT, z: ++z });
    }
    // Positions follow the natural order; the selected application's windows are stacked in front.
    const selectedId = studio.app?.id;
    const stacked = Object.fromEntries(
      Object.entries(placed).sort(([a], [b]) => Number(a.startsWith(`${selectedId}:`)) - Number(b.startsWith(`${selectedId}:`))),
    );
    studio.placeWindows(stacked);
  }, [entries, unplacedKey, size.width, size.height, studio]);

  // Windows render in a stable DOM order (so focusing one never moves elements mid-click);
  // stacking comes from z-index alone, kept small and dense.
  const visible = entries
    .map((entry) => ({ entry, state: studio.windows[entry.key] }))
    .filter((item): item is { entry: DesktopEntry; state: WindowState } => item.state !== undefined && !item.state.closed && !item.state.minimized);
  const ordered = [...visible].sort((a, b) => a.state.z - b.state.z);
  const layers = new Map(ordered.map((item, index) => [item.entry.key, 10 + index]));
  const selected = studio.app;
  // The focused window is the one last clicked; failing that, the front-most window of the selected app.
  const focusedKey =
    studio.focusedWindow && ordered.some((item) => item.entry.key === studio.focusedWindow)
      ? studio.focusedWindow
      : ordered.filter((item) => item.entry.app.id === selected?.id).at(-1)?.entry.key;

  return (
    <div
      ref={desk}
      className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden"
      style={background.style}
      data-testid="desktop"
      data-background={studio.appearance.background}
    >
      {size.width > 0 &&
        visible.map(({ entry, state }) => (
          <DesktopWindow key={entry.key} entry={entry} state={state} layer={layers.get(entry.key) ?? 10} desk={size} focused={entry.key === focusedKey} />
        ))}
      {selected && <Placeholder app={selected} entries={entries} />}
      <WindowBar entries={entries} focusedKey={focusedKey} />
    </div>
  );
}
