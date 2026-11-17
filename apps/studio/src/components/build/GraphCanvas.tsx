import { resolveConnection, sortObjects, type ClaspGraph, type GraphOperation } from "@clasp/core";
import { useGraph, useRuntimeVersion } from "@clasp/renderer-react";
import type { AppHandle, ComponentCategory, ComponentRegistry } from "@clasp/runtime";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { AlertCircle, Share2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useStudio, useWorkspace } from "../../studio/hooks";
import { cx } from "../ui";
import { layoutMissing, samePositions, type Point } from "./layout";

interface PortRow {
  name: string;
  kind: "value" | "event";
}

interface ObjectNodeData extends Record<string, unknown> {
  name: string;
  type: string;
  category: ComponentCategory | "unknown";
  left: PortRow[];
  right: PortRow[];
  parentName: string | undefined;
  error: string | undefined;
  exposed: boolean;
}

type ObjectFlowNode = Node<ObjectNodeData, "object">;

export const CATEGORY_DOT: Record<ComponentCategory | "unknown", string> = {
  interface: "bg-accent",
  data: "bg-success",
  logic: "bg-warning",
  workflow: "bg-[#0b79d0]",
  network: "bg-[#0e9f8e]",
  game: "bg-[#e0559b]",
  composition: "bg-ink",
  unknown: "bg-danger",
};

const ObjectNode = memo(function ObjectNode({ data, selected }: NodeProps<ObjectFlowNode>): ReactNode {
  const rows = Math.max(data.left.length, data.right.length);
  return (
    <div
      data-testid="graph-node"
      data-name={data.name}
      data-type={data.type}
      className={cx(
        "w-56 rounded-xl border bg-surface transition-shadow",
        selected ? "border-accent shadow-[0_0_0_3px_rgb(108_71_255/0.18)]" : "border-line-strong shadow-sm hover:shadow-md",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className={cx("size-2 shrink-0 rounded-full", CATEGORY_DOT[data.category])} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-ink">{data.name}</div>
          <div className="truncate text-[11px] leading-tight text-ink-faint">
            {data.type}
            {data.parentName ? ` · in ${data.parentName}` : ""}
          </div>
        </div>
        {data.exposed && (
          <span title="Part of the public interface">
            <Share2 className="size-3.5 shrink-0 text-accent" />
          </span>
        )}
        {data.error && (
          <span title={data.error}>
            <AlertCircle className="size-3.5 shrink-0 text-danger" />
          </span>
        )}
      </header>
      {rows > 0 && (
        <div className="border-t border-line py-1.5">
          {Array.from({ length: rows }, (_unused, index) => {
            const left = data.left[index];
            const right = data.right[index];
            return (
              <div key={index} className="relative flex h-[22px] items-center justify-between gap-2 px-3 text-[11px]">
                <span className={cx("truncate", left?.kind === "event" ? "font-medium text-accent-ink" : "text-ink-soft")}>{left?.name}</span>
                <span className={cx("truncate text-right", right?.kind === "event" ? "font-medium text-accent-ink" : "text-ink-soft")}>{right?.name}</span>
                {left && <Handle type="target" position={Position.Left} id={left.name} className={left.kind === "event" ? "clasp-event" : ""} />}
                {right && <Handle type="source" position={Position.Right} id={right.name} className={right.kind === "event" ? "clasp-event" : ""} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const nodeTypes = { object: ObjectNode };

function describeNode(graph: ClaspGraph, registry: ComponentRegistry, id: string, error: string | undefined): ObjectNodeData {
  const object = graph.objects[id]!;
  const definition = registry.get(object.type);
  const ports = registry.portsOf(object);
  const face = graph.interface;
  const exposed =
    face.actions.some((entry) => entry.target.objectId === id) ||
    face.events.some((entry) => entry.source.objectId === id) ||
    face.outputs.some((entry) => entry.source.objectId === id) ||
    face.inputs.some((entry) => entry.target.objectId === id) ||
    face.views.some((entry) => entry.root === id);
  return {
    name: object.metadata.name ?? definition?.title ?? object.type,
    type: object.type,
    category: definition?.category ?? "unknown",
    left: [
      ...(ports?.inputs ?? []).map((port) => ({ name: port.name, kind: "value" as const })),
      ...(ports?.actions ?? []).map((port) => ({ name: port.name, kind: "event" as const })),
    ],
    right: [
      ...(ports?.outputs ?? []).map((port) => ({ name: port.name, kind: "value" as const })),
      ...(ports?.events ?? []).map((port) => ({ name: port.name, kind: "event" as const })),
    ],
    parentName: object.parentId ? graph.objects[object.parentId]?.metadata.name : undefined,
    error: error ?? (definition ? undefined : `No component is registered for "${object.type}".`),
    exposed,
  };
}

export interface GraphCanvasProps {
  app: AppHandle;
  /** Positions requested for objects about to be created (e.g. dropped from the library). */
  preferred: MutableRefObject<Record<string, Point>>;
}

/**
 * The Build-mode canvas. It draws the application's graph and turns gestures
 * into graph operations on the same GraphStore the runtime executes — there
 * is no second model. Node positions are presentation state, stored apart
 * from the definition.
 */
export function GraphCanvas({ app, preferred }: GraphCanvasProps): ReactNode {
  const studio = useStudio();
  const workspace = useWorkspace();
  const registry = workspace.registry;
  const graph = useGraph(app.store);
  const runtimeVersion = useRuntimeVersion(app.runtime);
  const [positions, setPositions] = useState<Record<string, Point> | null>(null);
  const [nodes, setNodes] = useState<ObjectFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Load stored positions once per application.
  useEffect(() => {
    let alive = true;
    void workspace.storage.loadPresentation(app.id).then((stored) => {
      if (alive) setPositions(layoutMissing(app.store.graph, registry, stored?.nodes ?? {}));
    });
    return () => {
      alive = false;
    };
  }, [app, workspace, registry]);

  const persist = useCallback(
    (next: Record<string, Point>) => {
      void workspace.storage.savePresentation({ graphId: app.id, nodes: next }).catch((error: unknown) => studio.reportError("Could not save the layout", error));
    },
    [app.id, workspace, studio],
  );

  // Keep positions in step with the graph: place new objects, forget removed ones.
  useEffect(() => {
    if (!positions) return;
    const next = layoutMissing(graph, registry, { ...positions, ...preferred.current });
    preferred.current = {};
    if (!samePositions(next, positions)) {
      setPositions(next);
      persist(next);
    }
  }, [graph, positions, registry, persist, preferred]);

  // Derive nodes and edges from the graph, preserving React Flow's own bookkeeping (measurements).
  useEffect(() => {
    if (!positions) return;
    setNodes((previous) => {
      const known = new Map(previous.map((node) => [node.id, node]));
      return sortObjects(Object.values(graph.objects)).map((object) => {
        const existing = known.get(object.id);
        return {
          ...existing,
          id: object.id,
          type: "object" as const,
          position: positions[object.id] ?? existing?.position ?? { x: 0, y: 0 },
          data: describeNode(graph, registry, object.id, app.runtime.view(object.id)?.error),
          selected: object.id === studio.selectedObjectId,
        };
      });
    });
    setEdges((previous) => {
      const selected = new Set(previous.filter((edge) => edge.selected).map((edge) => edge.id));
      return Object.values(graph.connections).map((connection) => {
        // Wires that validate but will misbehave (e.g. a text payload into an action expecting an object) are flagged.
        const warning = resolveConnection(graph, registry, connection.source, connection.target, connection.id).issues.find(
          (entry) => entry.severity === "warning",
        );
        return {
          id: connection.id,
          source: connection.source.objectId,
          sourceHandle: connection.source.port,
          target: connection.target.objectId,
          targetHandle: connection.target.port,
          className: warning ? "clasp-warning-edge" : connection.kind === "event" ? "clasp-event-edge" : "",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: warning ? "#b54708" : connection.kind === "event" ? "#6c47ff" : "#b9b4a9",
          },
          ...(warning ? { label: "⚠ payload mismatch", ariaLabel: warning.message, data: { warning: warning.message } } : {}),
          selected: selected.has(connection.id),
        };
      });
    });
  }, [graph, positions, registry, app, studio.selectedObjectId, runtimeVersion]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ObjectFlowNode>[]) => {
      // Removal is handled in onDelete as a graph transaction; everything else is view state.
      setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== "remove"), current));
      const moved = changes.filter((change) => change.type === "position" && change.dragging === false);
      if (moved.length > 0) {
        setPositions((current) => {
          if (!current) return current;
          const next = { ...current };
          for (const change of moved) {
            if (change.type === "position" && change.position) next[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) };
          }
          persist(next);
          return next;
        });
      }
    },
    [persist],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes.filter((change) => change.type !== "remove"), current));
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      if (selected.length <= 1) studio.selectObject(selected[0]?.id);
    },
    [studio],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return;
      const current = graphRef.current;
      const target = { objectId: connection.target, port: connection.targetHandle };
      const operations: GraphOperation[] = [];
      const targetObject = current.objects[target.objectId];
      const isValueInput = targetObject ? (registry.portsOf(targetObject)?.inputs.some((port) => port.name === target.port) ?? false) : false;
      if (isValueInput) {
        // An input holds one connection; a new wire replaces the old one.
        for (const existing of Object.values(current.connections)) {
          if (existing.target.objectId === target.objectId && existing.target.port === target.port) {
            operations.push({ op: "disconnect", connectionId: existing.id });
          }
        }
      }
      operations.push({ op: "connect", connection: { source: { objectId: connection.source, port: connection.sourceHandle }, target } });
      studio.transact(operations, "Connect");
    },
    [registry, studio],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.sourceHandle || !connection.targetHandle) return false;
      const { issues } = resolveConnection(
        graphRef.current,
        registry,
        { objectId: connection.source, port: connection.sourceHandle },
        { objectId: connection.target, port: connection.targetHandle },
      );
      return !issues.some((entry) => entry.severity === "error");
    },
    [registry],
  );

  const onDelete = useCallback(
    ({ nodes: removedNodes, edges: removedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const current = graphRef.current;
      const doomed = new Set(removedNodes.map((node) => node.id));
      const coveredByAncestor = (id: string): boolean => {
        let parent = current.objects[id]?.parentId;
        while (parent) {
          if (doomed.has(parent)) return true;
          parent = current.objects[parent]?.parentId;
        }
        return false;
      };
      const operations: GraphOperation[] = [];
      for (const edge of removedEdges) {
        const connection = current.connections[edge.id];
        if (connection && !doomed.has(connection.source.objectId) && !doomed.has(connection.target.objectId)) {
          operations.push({ op: "disconnect", connectionId: edge.id });
        }
      }
      for (const id of doomed) {
        if (current.objects[id] && !coveredByAncestor(id)) operations.push({ op: "delete", objectId: id });
      }
      if (operations.length === 0) return;
      const label = doomed.size > 0 ? (doomed.size === 1 ? "Delete object" : `Delete ${doomed.size} objects`) : "Disconnect";
      if (studio.transact(operations, label) && doomed.size > 0) studio.selectObject(undefined);
    },
    [studio],
  );

  const empty = useMemo(() => Object.keys(graph.objects).length === 0, [graph]);

  if (!positions) return <div className="grid h-full place-items-center text-sm text-ink-faint">Loading graph…</div>;
  return (
    <div className="relative h-full w-full" data-testid="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDelete={onDelete}
        onSelectionChange={onSelectionChange}
        isValidConnection={isValidConnection}
        onPaneClick={() => studio.selectObject(undefined)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.5 }}
        minZoom={0.15}
        maxZoom={1.6}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#d2cec5" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-xs text-center">
            <div className="text-base font-semibold tracking-tight text-ink">An empty graph</div>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">Pick components from the library on the left — start with a Window — or ask the AI to assemble something.</p>
          </div>
        </div>
      )}
    </div>
  );
}
