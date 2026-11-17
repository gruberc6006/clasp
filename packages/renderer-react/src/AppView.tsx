import { childrenOf } from "@clasp/core";
import { useMemo, type ReactNode } from "react";
import {
  FramedContext,
  RenderContext,
  useGraph,
  useRenderContext,
  useRuntimeVersion,
  type ComponentRenderer,
  type RenderApp,
  type RenderContextValue,
  type RenderHost,
} from "./context";
import { defaultRenderers } from "./renderers";

function RenderNode({ id }: { id: string }): ReactNode {
  const { app, host, renderers } = useRenderContext();
  const view = app.runtime.view(id);
  if (!view) return null;
  const Renderer = renderers[view.object.type];
  if (!Renderer) return null; // not a visual component
  if (view.input("visible") === false) return null;
  const children = childrenOf(app.store.graph, id).filter((child) => renderers[child.type] !== undefined);
  return (
    <Renderer
      view={view}
      app={app}
      host={host}
      childNodes={children.map((child) => (
        <RenderNode key={child.id} id={child.id} />
      ))}
    />
  );
}

export interface AppViewProps {
  app: RenderApp;
  host?: RenderHost;
  /** Render only this object's subtree (used when embedding an exposed view). */
  rootId?: string;
  /** Render only these objects' subtrees, in this order. */
  rootIds?: string[];
  /** The host draws window chrome; windows render only their contents. */
  framed?: boolean;
  renderers?: Record<string, ComponentRenderer>;
  /** Shown when the application has nothing visible. */
  fallback?: ReactNode;
}

const NO_HOST: RenderHost = {};

/**
 * Draws a running application.
 *
 * The view holds no application state of its own: it reads the graph (for
 * structure) and the runtime (for values) and re-renders when either changes.
 * User gestures go back through `runtime.interact`. That is the whole
 * contract between rendering and execution.
 */
export function AppView({ app, host = NO_HOST, rootId, rootIds, framed = false, renderers = defaultRenderers, fallback }: AppViewProps): ReactNode {
  useRuntimeVersion(app.runtime);
  const graph = useGraph(app.store);
  const context = useMemo<RenderContextValue>(() => ({ app, host, renderers }), [app, host, renderers]);
  const requested = rootIds ?? (rootId ? [rootId] : undefined);
  const roots = requested
    ? requested.filter((id) => graph.objects[id] !== undefined)
    : childrenOf(graph, undefined)
        .filter((object) => renderers[object.type] !== undefined)
        .map((object) => object.id);

  if (roots.length === 0) return fallback ?? null;
  return (
    <RenderContext.Provider value={context}>
      <FramedContext.Provider value={framed}>
        <div className="flex w-full flex-col gap-5" data-clasp-app={app.id}>
          {roots.map((id) => (
            <RenderNode key={id} id={id} />
          ))}
        </div>
      </FramedContext.Provider>
    </RenderContext.Provider>
  );
}
