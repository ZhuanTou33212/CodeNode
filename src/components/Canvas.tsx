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
import { nodeTypes } from '../nodes';

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
  const applyPendingViewport = useUiStore((s) => s.applyPendingViewport);
  const { getViewport, setViewport: rfSetViewport } = useReactFlow();

  useEffect(() => {
    const v = applyPendingViewport();
    if (v) rfSetViewport(v, { duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap">
      <Breadcrumb />
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
    </div>
  );
}
