import type { Node, Edge } from '@xyflow/react';
import type { FlowItem, FlowResult, ScopeData, FileData, BaseData } from '../types';

const EST_W = 88;
const EST_H = 64;

export function nodeCenter(n: Node): { x: number; y: number } {
  const w = (n.measured?.width as number) || EST_W;
  const h = (n.measured?.height as number) || EST_H;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

export function isContainer(n: Node): boolean {
  return n.type === 'scope';
}

/** scope 的显式成员 id 列表：优先 childIds，兼容旧 members */
export function childIdsOf(container: Node): string[] {
  const d = container.data as unknown as { childIds?: string[]; members?: string[] };
  if (Array.isArray(d?.childIds)) return d.childIds;
  if (Array.isArray(d?.members)) return d.members;
  return [];
}

/** 节点所属 scope id（唯一父，null=顶层） */
export function parentIdOf(node: Node): string | null {
  const d = node.data as unknown as { parentId?: string | null };
  return d?.parentId ?? null;
}

/** 成员制：容器的子节点 = 显式登记的成员（childIds / 兼容 members） */
export function computeChildren(container: Node, nodes: Node[]): Node[] {
  const ids = new Set(childIdsOf(container));
  return nodes.filter((n) => ids.has(n.id) || parentIdOf(n) === container.id);
}

/** 位置判定：中心落在容器边界内的节点（仅用于候选提示/迁移，不自动成为成员） */
export function nodesInsideBounds(container: Node, nodes: Node[]): Node[] {
  const d = container.data as unknown as { width?: number; height?: number };
  const w = d.width || 320;
  const h = d.height || 220;
  const { x, y } = container.position;
  return nodes.filter((n) => {
    if (n.id === container.id) return false;
    const c = nodeCenter(n);
    return c.x >= x && c.x <= x + w && c.y >= y && c.y <= y + h;
  });
}

/** 自适应边界只由显式成员决定，几何路过/重叠不算成员 */
export function liveWrapNodes(container: Node, nodes: Node[]): Node[] {
  return computeChildren(container, nodes);
}

function selfPayload(node: Node): FlowItem {
  const d = node.data as unknown as BaseData & ScopeData & FileData;
  const base = { nodeId: node.id, label: d.label || String(node.type) };
  switch (node.type) {
    case 'start':
      return { ...base, kind: 'start', label: d.goal || '开始' };
    case 'end':
      return { ...base, kind: 'end', label: '结束' };
    case 'task':
      return { ...base, kind: 'task', label: d.goal || d.label, payload: d.prompt };
    case 'tool':
      return { ...base, kind: 'tool', label: d.label, payload: d.prompt };
    case 'file':
      return { ...base, kind: 'file', label: d.filePath || d.label, payload: d.content };
    case 'object':
      return { ...base, kind: 'object', label: (d as unknown as { objectName?: string }).objectName || d.label };
    default:
      return { ...base, kind: String(node.type || 'node') };
  }
}

function topoOrderView(nodes: Node[], edges: Edge[]): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (indeg.has(e.source) && indeg.has(e.target) && e.source !== e.target) {
      adj.get(e.source)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of adj.get(id)!) {
      const nd = indeg.get(t)! - 1;
      indeg.set(t, nd);
      if (nd === 0) queue.push(t);
    }
  }
  for (const [id, d] of indeg) if (d > 0) order.push(id);
  return order;
}

/**
 * 数据流计算：按拓扑顺序逐节点累计输入（来源节点的输出）并产生自身输出。
 * depth 限制防嵌套死循环（保留给未来子图扩展，当前仅一层）。
 */
function computeView(nodes: Node[], edges: Edge[]): Record<string, FlowResult> {
  const result: Record<string, FlowResult> = {};

  for (const id of topoOrderView(nodes, edges)) {
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    const r: FlowResult = { input: [], output: [] };

    const incoming = edges.filter((e) => e.target === id).map((e) => e.source);
    r.input = incoming.flatMap((src) => (result[src] ? result[src].output : []));

    r.output = [...r.input, selfPayload(node)];
    result[id] = r;
  }

  return result;
}

export function computeFlow(nodes: Node[], edges: Edge[]): Record<string, FlowResult> {
  return computeView(nodes, edges);
}

export function flattenFilePaths(tree: { name: string; relPath: string; type: string }[]): string[] {
  const out: string[] = [];
  const walk = (items: { name: string; relPath: string; type: string; children?: unknown[] }[]) => {
    for (const it of items) {
      if (it.type === 'dir' && it.children) walk(it.children as never[]);
      else if (it.type === 'file') out.push(it.relPath);
    }
  };
  walk(tree);
  return out;
}
