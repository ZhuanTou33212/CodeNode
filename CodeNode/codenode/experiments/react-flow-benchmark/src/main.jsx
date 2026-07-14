import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const requestedCount = Number(params.get('nodes') || 1000);
const nodeCount = Number.isInteger(requestedCount) && requestedCount > 0 && requestedCount <= 5000
  ? requestedCount
  : 1000;

function makeGraph(count) {
  const columns = Math.ceil(Math.sqrt(count));
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    type: index === 0 ? 'input' : index === count - 1 ? 'output' : 'default',
    position: { x: (index % columns) * 190, y: Math.floor(index / columns) * 90 },
    data: { label: `Node ${index + 1}` }
  }));
  const edges = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    id: `edge-${index}`,
    source: `node-${index}`,
    target: `node-${index + 1}`
  }));
  return { nodes, edges };
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function App() {
  const graph = useMemo(() => makeGraph(nodeCount), []);
  const [result, setResult] = useState({ status: 'waiting' });

  const onInit = useCallback(async instance => {
    const startedAt = performance.now();
    await nextFrame();
    await nextFrame();
    const initialRenderMs = performance.now() - startedAt;

    const frames = 30;
    const interactionStartedAt = performance.now();
    for (let index = 0; index < frames; index += 1) {
      instance.setViewport(
        { x: -index * 8, y: -index * 4, zoom: 0.55 + (index % 6) * 0.03 },
        { duration: 0 }
      );
      await nextFrame();
    }
    const interactionMs = performance.now() - interactionStartedAt;
    const benchmark = {
      status: 'complete',
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      renderedDomNodes: document.querySelectorAll('.react-flow__node').length,
      initialRenderMs: Number(initialRenderMs.toFixed(2)),
      interactionFrames: frames,
      averageFrameMs: Number((interactionMs / frames).toFixed(2)),
      measuredAt: new Date().toISOString()
    };
    window.__CODENODE_REACT_FLOW_BENCHMARK__ = benchmark;
    setResult(benchmark);
    await instance.fitView({ padding: 0.1, duration: 0 });
  }, [graph]);

  return (
    <main>
      <header>
        <div>
          <strong>CodeNode React Flow 1000-node benchmark</strong>
          <span>{graph.nodes.length} nodes / {graph.edges.length} edges</span>
        </div>
        <pre id="benchmark-result">{JSON.stringify(result, null, 2)}</pre>
      </header>
      <section aria-label="React Flow 1000-node canvas">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          onInit={onInit}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          fitView
        >
          <Background color="#404040" gap={24} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
