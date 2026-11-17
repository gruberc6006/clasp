import type { ClaspGraph, GraphStore } from "@clasp/core";
import type { GraphRuntime, ObjectView } from "@clasp/runtime";
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

/** A running application, as far as rendering is concerned. */
export interface RenderApp {
  readonly id: string;
  readonly store: GraphStore;
  readonly runtime: GraphRuntime;
}

/** What the surrounding host (e.g. the Studio) provides to rendered applications. */
export interface RenderHost {
  /**
   * Resolves a view another application exposes, for embedding. Must enforce
   * permissions and throw a ClaspError when the host application may not see it.
   */
  resolveView?(hostAppId: string, targetAppId: string, viewName?: string): { app: RenderApp; rootId: string; name: string };
  /** Display name of an application, if it exists in the workspace. */
  appName?(appId: string): string | undefined;
}

export interface RendererProps {
  view: ObjectView;
  app: RenderApp;
  host: RenderHost;
  /** Rendered children, in order. */
  childNodes: ReactNode[];
}

/** Draws one interface primitive. It reads from the runtime and reports gestures through `runtime.interact`. */
export type ComponentRenderer = (props: RendererProps) => ReactNode;

export interface RenderContextValue {
  app: RenderApp;
  host: RenderHost;
  renderers: Record<string, ComponentRenderer>;
}

export const RenderContext = createContext<RenderContextValue | null>(null);

export function useRenderContext(): RenderContextValue {
  const value = useContext(RenderContext);
  if (!value) throw new Error("Clasp renderers must be used inside <AppView>.");
  return value;
}

/**
 * True when the host draws window chrome (title bar, controls) around each
 * top-level window — as the Studio desktop does. Windows then render only
 * their contents.
 */
export const FramedContext = createContext(false);

/** Direction of the enclosing layout, so children can size themselves sensibly. */
export const LayoutContext = createContext<"row" | "column">("column");

/** Re-renders whenever the runtime's observable state changes. */
export function useRuntimeVersion(runtime: GraphRuntime): number {
  const subscribe = useCallback((notify: () => void) => runtime.subscribe(notify), [runtime]);
  const snapshot = useCallback(() => runtime.version, [runtime]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The current revision of a graph; re-renders on every committed change. */
export function useGraph(store: GraphStore): ClaspGraph {
  const subscribe = useCallback((notify: () => void) => store.subscribe(() => notify()), [store]);
  const snapshot = useCallback(() => store.graph, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
