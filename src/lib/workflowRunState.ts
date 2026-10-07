import workflowUiConfig from '../../config/ui.workflow.json';
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

export function workflowReadiness(nodes:Node[],edges:Edge[]) {
  const tasks=nodes.filter(node=>workflowUiConfig.executionNodeTypes.includes(node.type||'task'));
  const missing=tasks.find(node=>!workflowUiConfig.instructionFields.some(field=>String(node.data?.[field]||'').trim()));
  const ids=new Set(nodes.map(node=>node.id));
  const badEdge=edges.some(edge=>!ids.has(edge.source)||!ids.has(edge.target));
  const indegree=new Map(nodes.map(node=>[node.id,0]));for(const edge of edges)if(ids.has(edge.target))indegree.set(edge.target,(indegree.get(edge.target)||0)+1);
  const queue=nodes.filter(node=>!indegree.get(node.id)).map(node=>node.id);let visited=0;
  while(queue.length){const id=queue.shift();visited++;for(const edge of edges.filter(edge=>edge.source===id)){const degree=(indegree.get(edge.target)||0)-1;indegree.set(edge.target,degree);if(!degree)queue.push(edge.target);}}
  const cycle=!badEdge&&visited<nodes.length;
  const reason=cycle?'工作流存在循环连线，请先调整为可执行的依赖顺序':!tasks.length?'请先添加配置了任务指令的节点':missing?'请为「'+(missing.data.label||missing.id)+'」填写任务指令':badEdge?'画布存在无效连线':'';
  return {ready:!reason,reason,tasks};
}
