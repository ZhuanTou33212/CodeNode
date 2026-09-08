import { useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useReactFlow,
  SelectionMode,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Node,
  type Edge,
  MarkerType,
} from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { nodeTypes } from '../nodes';
import { edgeTypes } from '../edges';
import { childIdsOf, parentIdOf, isDescendantOf } from '../lib/flow';
import ChatSidebar from './ChatSidebar';
import PromptBar from './PromptBar';

function collectHiddenIds(nodes: Node[]): Set<string> {
  const hidden = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visit = (id: string) => {
    const node = byId.get(id);
    if (!node) return;
    for (const cid of childIdsOf(node)) {
      hidden.add(cid);
      visit(cid);
    }
  };
  for (const n of nodes) {
    if (n.type === 'scope' && (n.data as { collapsed?: boolean })?.collapsed) visit(n.id);
  }
  return hidden;
}

type Pt = { x: number; y: number };

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sY - (c.y - a.y) * sX) / denom;
  const u = ((c.x - a.x) * rY - (c.y - a.y) * rX) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rX, y: a.y + t * rY };
}

function edgePoints(edge: Edge, byId: Map<string, Node>): Pt[] {
  const s = byId.get(edge.source);
  const t = byId.get(edge.target);
  if (!s || !t) return [];
  const sw = (s.measured?.width as number) || 88;
  const sh = (s.measured?.height as number) || 64;
  const tw = (t.measured?.width as number) || 88;
  const th = (t.measured?.height as number) || 64;
  const pts: Pt[] = [
    { x: s.position.x + sw, y: s.position.y + sh / 2 },
    { x: t.position.x, y: t.position.y + th / 2 },
  ];
  const wp = ((edge.data as { waypoints?: Pt[] } | undefined)?.waypoints) || [];
  if (wp.length) {
    return [pts[0], ...wp, pts[1]];
  }
  return pts;
}

function lineHitsEdge(dragPts: Pt[], edgePts: Pt[]): Pt | null {
  if (dragPts.length < 2 || edgePts.length < 2) return null;
  for (let i = 0; i + 1 < dragPts.length; i++) {
    for (let j = 0; j + 1 < edgePts.length; j++) {
      const hit = segIntersect(dragPts[i], dragPts[i + 1], edgePts[j], edgePts[j + 1]);
      if (hit) return hit;
    }
  }
  return null;
}

export default function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const commit = useGraphStore((s) => s.commit);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const setSelectedIds = useGraphStore((s) => s.setSelectedIds);
  const setAltDrag = useGraphStore((s) => s.setAltDrag);
  const setDragging = useGraphStore((s) => s.setDragging);
  const closeAddMenu = useUiStore((s) => s.closeAddMenu);
  const leftOpen = useUiStore((s) => s.leftOpen);
  const leftWidth = useUiStore((s) => s.leftWidth);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const dockOpen = useUiStore((s) => s.dockOpen);
  const setViewport = useUiStore((s) => s.setViewport);
  const pendingViewport = useUiStore((s) => s.pendingViewport);
  const applyPendingViewport = useUiStore((s) => s.applyPendingViewport);
  const progress = useSessionStore((s) => s.progress);
  const { fitView, getViewport, setViewport: rfSetViewport, screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const dragState = useRef<{
    id: string;
    startTime: number;
    startX: number;
    startY: number;
    parentId: string | null;
    ids: string[];
  } | null>(null);
  const hoverScope = useRef<string | null>(null);
  const lineEdit = useRef<{ mode: 'cut' | 'waypoint'; points: Pt[]; screenPts: Pt[]; hits: Map<string, Pt> } | null>(null);
  const [cutLine, setCutLine] = useState<Pt[]>([]);

  useEffect(() => {
    const v = applyPendingViewport();
    if (v) rfSetViewport(v, { duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingViewport]);

  // 面板开合或窗口尺寸变化后，让 React Flow 重新计算可视区域。
  // 这里做轻微防抖，避免拖动左侧分隔条时不断跳动视口。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: number | null = null;
    const refit = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (useGraphStore.getState().nodes.length > 0) {
          fitView({ padding: 0.2, duration: 220 });
        }
      }, 180);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [fitView, leftOpen, leftWidth, inspectorOpen, dockOpen]);

  // Agent 进度扫描：沿画布连线逐条推进高亮（多段线连接动画）
  useEffect(() => {
    const p = useSessionStore.getState().progress;
    if (!p || !p.running) return;
    const t = setTimeout(() => useSessionStore.getState().setProgressIndex(p.index + 1), 380);
    return () => clearTimeout(t);
  }, [progress?.index, progress?.running]);

  const hiddenIds = collectHiddenIds(nodes);
  const visibleNodes = nodes.filter((n) => !hiddenIds.has(n.id));
  const visibleEdges = edges.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target));

  const displayEdges = visibleEdges.map((e) => {
    const wp = (e.data as { waypoints?: unknown[] } | undefined)?.waypoints;
    const base = wp && wp.length ? { ...e, type: 'waypoint' } : e;
    if (!progress || !progress.edgeIds.length) return base;
    const idx = progress.edgeIds.indexOf(e.id);
    if (idx < 0) return base;
    if (idx === progress.index) return { ...base, animated: true, style: { strokeWidth: 4, stroke: '#38bdf8' } };
    if (idx < progress.index) return { ...base, animated: true };
    return { ...base, animated: false, style: { strokeOpacity: 0.22 } };
  });

  const findHoverScope = (node: Node): string | null => {
    const st = useGraphStore.getState();
    const w = (node.measured?.width as number) || 88;
    const h = (node.measured?.height as number) || 64;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const candidates: { id: string; area: number }[] = [];
    for (const sc of st.nodes) {
      if (sc.type !== 'scope' || sc.id === node.id) continue;
      if ((sc.data as { collapsed?: boolean })?.collapsed) continue;
      if (node.type === 'scope' && isDescendantOf(sc.id, node.id, st.nodes)) continue;
      const d = sc.data as { width?: number; height?: number };
      const sw = d.width || 320;
      const sh = d.height || 220;
      const sx0 = sc.position.x;
      const sy0 = sc.position.y;
      const sx1 = sc.position.x + sw;
      const sy1 = sc.position.y + sh;
      // 用“包围盒相交/接近”判定，而不是只取中心点，避免快速拖放时来不及包裹就松手
      if (cx >= sx0 && cx <= sx1 && cy >= sy0 && cy <= sy1) candidates.push({ id: sc.id, area: sw * sh });
    }
    candidates.sort((a, b) => a.area - b.area);
    return candidates[0]?.id || null;
  };

  return (
    <div
      ref={canvasRef}
      className="canvas-wrap"
      onMouseDown={(e) => {
        if (e.button === 2 && e.ctrlKey) {
          const rect = e.currentTarget.getBoundingClientRect();
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          lineEdit.current = {
            mode: e.shiftKey ? 'waypoint' : 'cut',
            points: [flowPos],
            screenPts: [screenPos],
            hits: new Map(),
          };
          setCutLine([screenPos]);
        }
      }}
      onMouseMove={(e) => {
        const le = lineEdit.current;
        if (!le) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        le.points.push(flowPos);
        le.screenPts.push(screenPos);
        setCutLine([...le.screenPts]);
        const st = useGraphStore.getState();
        const byId = new Map(st.nodes.map((n) => [n.id, n]));
        for (const edge of visibleEdges) {
          if (le.hits.has(edge.id)) continue;
          const hit = lineHitsEdge(le.points, edgePoints(edge, byId));
          if (hit) le.hits.set(edge.id, hit);
        }
      }}
      onMouseUp={(e) => {
        const le = lineEdit.current;
        if (!le) return;
        const st = useGraphStore.getState();
        if (le.mode === 'cut') {
          const ids = [...le.hits.keys()];
          if (ids.length) {
            st.onEdgesChange(ids.map((id) => ({ id, type: 'remove' })));
          }
        } else {
          for (const [edgeId, pt] of le.hits) {
            const edge = st.edges.find((x) => x.id === edgeId);
            if (!edge) continue;
            const wp = ((edge.data as { waypoints?: Pt[] })?.waypoints) || [];
            st.updateEdgeData(edgeId, { waypoints: [...wp, { x: Math.round(pt.x), y: Math.round(pt.y) }] });
          }
        }
        lineEdit.current = null;
        setCutLine([]);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ReactFlow
        nodes={visibleNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
        onConnect={onConnect as (conn: Connection) => void}
        panOnDrag={[1]}
        selectionOnDrag
        selectionMode={SelectionMode.Full}
        multiSelectionKeyCode="Control"
        selectionKeyCode="Shift"
        deleteKeyCode={['Delete', 'Backspace']}
        onPaneClick={closeAddMenu}
        onNodeClick={(_e, node: Node) => {
          if (_e.altKey) {
            // Alt+左键仅取消选中，不再用于移出范围
            useGraphStore
              .getState()
              .onNodesChange([{ id: node.id, type: 'select', selected: false }]);
          }
        }}
        onMoveEnd={() => setViewport(getViewport())}
        onNodeDragStart={(e, node) => {
          commit();
          const st = useGraphStore.getState();
          const ids = node.type === 'scope'
            ? [node.id]
            : st.selectedIds.includes(node.id)
              ? st.selectedIds
              : [node.id];
          dragState.current = {
            id: node.id,
            startTime: Date.now(),
            startX: node.position.x,
            startY: node.position.y,
            parentId: parentIdOf(node),
            ids,
          };
          const initialHover = findHoverScope(node);
          hoverScope.current = initialHover;
          useUiStore.getState().setHoverScopeId(initialHover);
          setDragging(ids);
        }}
        onNodeDrag={(e, node) => {
          if (!dragState.current || dragState.current.id !== node.id) return;
          const next = findHoverScope(node);
          if (next !== hoverScope.current) {
            hoverScope.current = next;
            useUiStore.getState().setHoverScopeId(next);
          }
        }}
        onNodeDragStop={(e, node) => {
          const ds = dragState.current;
          const st = useGraphStore.getState();
          const target = findHoverScope(node) ?? hoverScope.current;
          const oldParent = ds?.parentId ?? null;
          // 状态机：松手时根据“是否处于 scope 候选区/是否已有父级”决定放入/移出，
          // 不再依赖按住时长，避免快速操作时来不及包裹导致节点脱离范围。
          if (ds?.ids && ds.ids.length > 0) {
            // Ctrl + 拖出范围：从原 scope 中移出
            for (const id of ds.ids) {
              const current = st.nodes.find((n) => n.id === id);
              if (current && (e.altKey || !target)) st.removeFromScope(id);
              else if (current && target && target !== parentIdOf(current) && target !== id) st.addToScope(id, target);
            }
          } else if (target && target !== oldParent) {
            st.addToScope(node.id, target);
          } else if (!target && oldParent) {
            st.removeFromScope(node.id);
          }
          setDragging([]);
          setAltDrag([]);
          useUiStore.getState().setHoverScopeId(null);
          dragState.current = null;
          hoverScope.current = null;
        }}
        onEdgeContextMenu={(e, edge: Edge) => {
          e.preventDefault();
          const st = useGraphStore.getState();
          if (e.ctrlKey && e.shiftKey) {
            // Ctrl+Shift+右键：在连线上创建纯几何中转点
            const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            const wp = ((edge.data as { waypoints?: { x: number; y: number }[] })?.waypoints) || [];
            st.updateEdgeData(edge.id, { waypoints: [...wp, { x: Math.round(pos.x), y: Math.round(pos.y) }] });
          } else if (e.ctrlKey) {
            // Ctrl+右键：断开当前连线
            st.onEdgesChange([{ id: edge.id, type: 'remove' }]);
          }
        }}
        onEdgeClick={(e, edge: Edge) => {
          // Ctrl+Shift 点击连线：新增纯几何中转点
          if (e.ctrlKey && e.shiftKey) {
            const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            const wp = ((edge.data as { waypoints?: { x: number; y: number }[] })?.waypoints) || [];
            useGraphStore.getState().updateEdgeData(edge.id, { waypoints: [...wp, { x: Math.round(pos.x), y: Math.round(pos.y) }] });
          }
        }}
        onNodesDelete={(deleted) => deleteNodes(deleted.map((n) => n.id))}
        onSelectionChange={({ nodes: sel }) => setSelectedIds(sel.map((n) => n.id))}
        fitView
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#2a2f3a" />
      </ReactFlow>
      {cutLine.length > 1 ? (
        <svg
          className="wf-cut-line"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <polyline
            points={cutLine.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="#f43f5e"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        </svg>
      ) : null}
      <ChatSidebar />
      <PromptBar />
    </div>
  );
}
