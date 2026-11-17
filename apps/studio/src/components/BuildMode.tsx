import { createId } from "@clasp/core";
import type { AppHandle } from "@clasp/runtime";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useCallback, useRef, type ReactNode } from "react";
import { useStudio, useWorkspace } from "../studio/hooks";
import { GraphCanvas } from "./build/GraphCanvas";
import { Inspector } from "./build/Inspector";
import { LeftPanel } from "./build/LeftPanel";
import { NODE_WIDTH, type Point } from "./build/layout";

function BuildLayout({ app }: { app: AppHandle }): ReactNode {
  const studio = useStudio();
  const registry = useWorkspace().registry;
  const flow = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  const preferred = useRef<Record<string, Point>>({});

  /** Adds a component from the library: one ordinary "create" transaction. */
  const add = useCallback(
    (type: string) => {
      const definition = registry.get(type);
      if (!definition) return;
      const graph = app.store.graph;
      const selected = studio.selectedObjectId ? graph.objects[studio.selectedObjectId] : undefined;

      // Visible elements go into the selected container, next to the selection, or into the window.
      let parentId: string | undefined;
      if (definition.category === "interface" && type !== "ui.window") {
        if (selected && registry.get(selected.type)?.container) parentId = selected.id;
        else if (selected?.parentId) parentId = selected.parentId;
        else parentId = Object.values(graph.objects).find((object) => object.type === "ui.window")?.id;
      }

      const names = new Set(Object.values(graph.objects).map((object) => object.metadata.name));
      let name = definition.title;
      for (let index = 2; names.has(name); index++) name = `${definition.title} ${index}`;

      const id = createId("obj");
      const bounds = canvas.current?.getBoundingClientRect();
      let spot: { x: number; y: number } | undefined;
      if (bounds) {
        // The free spot nearest the middle of the view, so new components never land on top of others.
        const center = flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
        const taken = flow.getNodes().map((node) => ({
          x: node.position.x,
          y: node.position.y,
          width: node.measured?.width ?? NODE_WIDTH,
          height: node.measured?.height ?? 140,
        }));
        const size = { width: NODE_WIDTH, height: 150 };
        const free = (x: number, y: number): boolean =>
          !taken.some((rect) => x < rect.x + rect.width + 24 && rect.x < x + size.width + 24 && y < rect.y + rect.height + 24 && rect.y < y + size.height + 24);
        const origin = { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2) };
        outer: for (let ring = 0; ring <= 8; ring++) {
          for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
              const x = origin.x + dx * (size.width + 40);
              const y = origin.y + dy * (size.height + 30);
              if (free(x, y)) {
                spot = { x, y };
                break outer;
              }
            }
          }
        }
        spot ??= origin;
        preferred.current[id] = spot;
      }
      const created = studio.transact([{ op: "create", object: { id, type, name, ...(parentId ? { parentId } : {}) } }], `Add ${definition.title}`);
      if (created) {
        studio.selectObject(id);
        // Bring the new component into view.
        if (spot) void flow.setCenter(spot.x + NODE_WIDTH / 2, spot.y + 70, { zoom: Math.max(flow.getZoom(), 0.75), duration: 250 });
      } else delete preferred.current[id];
    },
    [app, flow, registry, studio],
  );

  const focus = useCallback(
    (id: string) => {
      studio.selectObject(id);
      const node = flow.getNode(id);
      if (node) {
        void flow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + (node.measured?.height ?? 80) / 2, {
          zoom: Math.max(flow.getZoom(), 0.85),
          duration: 280,
        });
      }
    },
    [flow, studio],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="build-mode">
      <LeftPanel app={app} onAdd={add} onFocus={focus} />
      <div ref={canvas} className="relative min-w-0 flex-1 bg-canvas">
        <GraphCanvas app={app} preferred={preferred} />
      </div>
      {/* The AI panel takes the inspector's place while it is open, so the canvas keeps its room. */}
      {!studio.aiOpen && <Inspector app={app} />}
    </div>
  );
}

/**
 * Build mode: the application's object graph, laid bare. The canvas, outline
 * and inspector all edit the one GraphStore that Use mode is running.
 */
export function BuildMode({ app }: { app: AppHandle }): ReactNode {
  return (
    <ReactFlowProvider>
      <BuildLayout app={app} />
    </ReactFlowProvider>
  );
}
