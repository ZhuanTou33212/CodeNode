import { useEffect } from 'react';
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
  MarkerType,
} from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { nodeTypes } from '../nodes';
import ChatSidebar from './ChatSidebar';
import PromptBar from './PromptBar';

function Breadcrumb() {
  const viewStack = useGraphStore((s) => s.viewStack);
  const root = useGraphStore((s) => s.root);
  const groups = useGraphStore((s) => s.groups);
  const exitGroup = useGraphStore((s) => s.exitGroup);

  if (viewStack.length === 0) return null;

  const crumbs: { id: string | null; label: string }[] = [{ id: null, label: '主画布' }];
  for (let i = 0; i < viewStack.length; i++) {
    const gid = viewStack[i];
    const parent = i === 0 ? root : groups[viewStack[i - 1]];
    const gnode = parent.nodes.find((n) => n.id === gid);
    crumbs.push({ id: gid, label: (gnode?.data as { label?: string } | undefined)?.label || '节点组' });
  }

  return (
    <div className="breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span className="crumb-sep">▸</span>}
          {c.id === null ? (
            <span className="crumb-text">{c.label}</span>
          ) : (
            <button className="crumb-btn" onClick={exitGroup} title="返回上一级">
              {c.label}
            </button>
          )}
        </span>
      ))}
      <button className="crumb-exit" onClick={exitGroup} title="返回主画布 (Esc)">
        退出组
      </button>
    </div>
  );
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
  const enterGroup = useGraphStore((s) => s.enterGroup);
  const closeAddMenu = useUiStore((s) => s.closeAddMenu);  const setViewport = useUiStore((s) => s.setViewport);
  const pendingViewport = useUiStore((s) => s.pendingViewport);
  const applyPendingViewport = useUiStore((s) => s.applyPendingViewport);
  const progress = useSessionStore((s) => s.progress);
  const { getViewport, setViewport: rfSetViewport } = useReactFlow();

  useEffect(() => {
    const v = applyPendingViewport();
    if (v) rfSetViewport(v, { duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingViewport]);

  // Agent 进度扫描：沿画布连线逐条推进高亮（多段线连接动画）
  useEffect(() => {
    const p = useSessionStore.getState().progress;
    if (!p || !p.running) return;
    const t = setTimeout(() => useSessionStore.getState().setProgressIndex(p.index + 1), 380);
    return () => clearTimeout(t);
  }, [progress?.index, progress?.running]);

  const displayEdges = edges.map((e) => {
    if (!progress || !progress.edgeIds.length) return e;
    const idx = progress.edgeIds.indexOf(e.id);
    if (idx < 0) return e;
    if (idx === progress.index) return { ...e, animated: true, style: { strokeWidth: 4, stroke: '#38bdf8' } };
    if (idx < progress.index) return { ...e, animated: true };
    return { ...e, animated: false, style: { strokeOpacity: 0.22 } };
  });

  return (
    <div className="canvas-wrap">
      <Breadcrumb />
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
        onConnect={onConnect as (conn: Connection) => void}
        panOnDrag={[1, 2]}
        selectionOnDrag
        selectionMode={SelectionMode.Full}
        multiSelectionKeyCode="Control"
        selectionKeyCode="Shift"
        deleteKeyCode={['Delete', 'Backspace']}
        onPaneClick={closeAddMenu}
        onNodeClick={(_e, node: Node) => {
          if (_e.altKey) {
            useGraphStore
              .getState()
              .onNodesChange([{ id: node.id, type: 'select', selected: false }]);
          }
        }}
        onMoveEnd={() => setViewport(getViewport())}
        onNodeDoubleClick={(_e, node: Node) => {
          if (node.type === 'group') enterGroup(node.id);
        }}
        onNodeDragStart={(e, node) => {
          commit();
          setDragging([node.id]);
        }}
        onNodeDragStop={(e, node) => {
          setDragging([]);
          setAltDrag([]);
          useGraphStore.getState().commitDrop(node.id, e.altKey);
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
      <ChatSidebar />
      <PromptBar />
    </div>
  );
}
