import type { Node, Edge } from '@xyflow/react';

// Only execution data participates in identity; moving/selecting nodes and the
// runner's status updates do not invalidate an otherwise identical contract.
export function workflowGraph(nodes: Node[], edges: Edge[]) {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => {
      const { status: _status, ...data } = (node.data || {}) as Record<string, unknown>;
      return { id: node.id, type: node.type || 'task', data };
    }),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || '', targetHandle: edge.targetHandle || '', data: edge.data || null })),
  };
}

export function workflowSignature(graph: ReturnType<typeof workflowGraph>): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(graph));
}

export function workflowReviewIds(state: WorkflowStateDto, nodeId: string): string[] {
  return [...new Set([...state.pending.map((item) => item.id), ...(state.reviews[nodeId] ? [state.reviews[nodeId]] : [])])];
}
