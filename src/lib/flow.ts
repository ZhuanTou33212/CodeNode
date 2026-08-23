import type { Node, Edge } from '@xyflow/react';
import type { FlowItem, FlowResult, ScopeData, FileData, BaseData, Graph, GroupData } from '../types';

const EST_W = 88;
const EST_H = 64;

export function nodeCenter(n: Node): { x: number; y: number } {
  const w = (n.measured?.width as number) || EST_W;
  const h = (n.measured?.height as number) || EST_H;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

export function isContainer(n: Node): boolean {
  return n.type === 'scope' || n.type === 'user';
}

function membersOf(container: Node): string[] {
  const m = (container.data as unknown as { members?: string[] })?.members;
  return Array.isArray(m) ? m : [];
}

/** 成员制：容器的子节点 = 显式登记的成员（拖入即入组，仅 Alt 拖出移除） */
export function computeChildren(container: Node, nodes: Node[]): Node[] {
  const ids = new Set(membersOf(container));
  return nodes.filter((n) => ids.has(n.id));
}

/** 位置判定：中心落在容器边界内的节点（用于拖放入组判定与实时边框包裹） */
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

/** 实时边框包裹目标 = 成员 ∪ 当前在边界内的节点 */
export function liveWrapNodes(container: Node, nodes: Node[]): Node[] {
  const ids = new Set<string>();
  for (const n of computeChildren(container, nodes)) ids.add(n.id);
  for (const n of nodesInsideBounds(container, nodes)) ids.add(n.id);
  return nodes.filter((n) => ids.has(n.id));
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
 * 节点组（Blender 风格）：
 * - 组节点在外部有输入/输出端子（socket）
 * - 外部接入组端子 → 组内「组输入」节点 → 分发给组内节点
 * - 组内节点接入「组输出」节点 → 作为组输出端子内容流出
 * 递归进入子视图计算，depth 限制防嵌套死循环。
 */
function computeView(
  nodes: Node[],
  edges: Edge[],
  groups: Record<string, Graph>,
  depth: number,
  seedFor: Record<string, FlowItem[]>
): Record<string, FlowResult> {
  if (depth > 8) return {};
  const result: Record<string, FlowResult> = {};

  for (const id of topoOrderView(nodes, edges)) {
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    const r: FlowResult = { input: [], output: [] };

    if (node.type === 'group' && groups[id]) {
      const gd = node.data as unknown as GroupData;
      const sub = groups[id];

      // 组输入：外部接入各输入端子的数据
      const seeds: FlowItem[] = [];
      for (const s of gd.sockets.inputs || []) {
        const srcs = edges
          .filter((e) => e.target === id && (e.targetHandle || 'in') === s.id)
          .map((e) => e.source);
        for (const src of srcs) seeds.push(...(result[src] ? result[src].output : []));
      }
      r.input = seeds;

      // 组输出：组内接入「组输出」端子的节点产出（按端子逐项）
      const outItems: FlowItem[] = [];
      const groupInputNode = sub.nodes.find((n) => n.type === 'group-input');
      const seedForSub: Record<string, FlowItem[]> = {};
      if (groupInputNode) seedForSub[groupInputNode.id] = seeds;
      const subFlow = computeView(sub.nodes, sub.edges, groups, depth + 1, seedForSub);

      for (const s of gd.sockets.outputs || []) {
        const feeds = sub.edges
          .filter(
            (e) =>
              sub.nodes.some((n) => n.id === e.target && n.type === 'group-output') &&
              (e.targetHandle || 'out') === s.id
          )
          .map((e) => e.source);
        for (const f of feeds) outItems.push(...(subFlow[f] ? subFlow[f].output : []));
      }
      r.output = outItems;
      result[id] = r;
      continue;
    }

    // 常规节点（含组输入/组输出终端、范围等）
    const incoming = edges.filter((e) => e.target === id).map((e) => e.source);
    r.input = incoming.flatMap((src) => (result[src] ? result[src].output : []));

    if (node.type === 'group-input' && seedFor[id]) {
      r.output = seedFor[id];
    } else if (node.type === 'group-output') {
      r.output = r.input;
    } else {
      r.output = [...r.input, selfPayload(node)];
    }
    result[id] = r;
  }

  return result;
}

export function computeFlow(nodes: Node[], edges: Edge[], groups: Record<string, Graph>): Record<string, FlowResult> {
  return computeView(nodes, edges, groups, 0, {});
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
