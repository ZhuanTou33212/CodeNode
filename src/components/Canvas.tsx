import { useEffect } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
  type Connection,
  MarkerType,
} from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { nodeTypes } from '../nodes';

export default function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const commit = useGraphStore((s) => s.commit);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const setSelectedId = useGraphStore((s) => s.setSelectedId);
  const closeAddMenu = useUiStore((s) => s.closeAddMenu);
  const setViewport = useUiStore((s) => s.setViewport);
  const applyPendingViewport = useUiStore((s) => s.applyPendingViewport);
  const { getViewport, setViewport: rfSetViewport } = useReactFlow();

  useEffect(() => {
    const v = applyPendingViewport();
    if (v) rfSetViewport(v, { duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
        onConnect={onConnect as (conn: Connection) => void}
        panOnDrag={[1, 2]}
        selectionOnDrag
        deleteKeyCode={['Delete', 'Backspace']}
        onPaneClick={closeAddMenu}
        onMoveEnd={() => setViewport(getViewport())}
        onNodeDragStart={() => commit()}
        onNodesDelete={(deleted) => deleteNodes(deleted.map((n) => n.id))}
        onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length === 1 ? sel[0].id : null)}
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
