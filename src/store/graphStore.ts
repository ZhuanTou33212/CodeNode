import { create } from 'zustand';
import {
  Node,
  Edge,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  Connection,
  NodeChange,
  EdgeChange,
} from '@xyflow/react';
import type { FlowResult, Graph } from '../types';
import { computeFlow, childIdsOf, parentIdOf, isDescendantOf } from '../lib/flow';

type GraphLike = { nodes: Node[]; edges: Edge[] };

const snapshot = (s: GraphLike): Graph => ({
  nodes: JSON.parse(JSON.stringify(s.nodes)),
  edges: JSON.parse(JSON.stringify(s.edges)),
});

/** 已废弃的节点类型（agent/user 对话节点），加载时直接剥离并清理其连线 */
const LEGACY_TYPES = new Set(['agent', 'user']);

function stripLegacyTypes(nodes: Node[], edges: Edge[]): Graph {
  const kept = nodes.filter((n) => !LEGACY_TYPES.has(n.type || ''));
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

function withZIndex(n: Node): Node {
  if (n.type === 'scope') return { ...n, zIndex: 0, dragHandle: n.dragHandle || '.wf-scope-title' };
  return { ...n, zIndex: 1 };
}

const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

function uniqueIds(ids: unknown, byId: Map<string, Node>, selfId?: string): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw);
    if (id === selfId || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function setScopeChildren(data: Record<string, unknown>, ids: string[]): void {
  const unique = [...new Set(ids)];
  data.childIds = unique;
  data.members = [...unique];
}

function wouldCreateParentCycle(parents: Map<string, string>, childId: string, parentId: string): boolean {
  const visited = new Set<string>();
  let current: string | undefined = parentId;
  while (current && !visited.has(current)) {
    if (current === childId) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

/** 归一化父子对象集：把旧 members 迁移到 childIds，并补全 parentId/memberBadge。 */
function normalizeParentChild(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const listedByScope = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type !== 'scope') continue;
    const d = n.data as Record<string, unknown> & { childIds?: string[]; members?: string[] };
    const ids = Array.isArray(d.childIds) ? d.childIds : d.members;
    listedByScope.set(n.id, uniqueIds(ids, byId, n.id));
  }
  // 反向补全 parentId
  const parentByChild = new Map<string, string>();
  for (const node of nodes) {
    const parentId = parentIdOf(node);
    if (
      parentId &&
      listedByScope.has(parentId) &&
      parentId !== node.id &&
      !wouldCreateParentCycle(parentByChild, node.id, parentId) &&
      !(node.type === 'scope' && isDescendantOf(parentId, node.id, nodes))
    ) {
      parentByChild.set(node.id, parentId);
    }
  }
  for (const [scopeId, ids] of listedByScope) {
    for (const childId of ids) {
      if (
        !parentByChild.has(childId) &&
        !wouldCreateParentCycle(parentByChild, childId, scopeId) &&
        !isDescendantOf(scopeId, childId, nodes)
      ) {
        parentByChild.set(childId, scopeId);
      }
    }
  }
  return nodes.map((n) => {
    const d = { ...(n.data as Record<string, unknown>) };
    const parentId = parentByChild.get(n.id) || null;
    d.parentId = parentId;
    d.memberBadge = parentId
      ? 'in:' + String((byId.get(parentId)?.data as { label?: string })?.label || parentId)
      : null;
    if (n.type === 'scope') {
      const listed = (listedByScope.get(n.id) || []).filter((id) => parentByChild.get(id) === n.id);
      const explicitChildren = [...parentByChild.entries()].filter(([, parent]) => parent === n.id).map(([id]) => id);
      setScopeChildren(d, [...listed, ...explicitChildren]);
    }
    return { ...n, data: d, ...(n.type === 'scope' ? { dragHandle: n.dragHandle || '.wf-scope-title' } : {}) };
  });
}

/** 收集某 scope 的所有后代 id（含直接成员与嵌套 scope 的成员）。 */
function descendantIds(rootId: string, nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const stack = [rootId];
  const visited = new Set<string>([rootId]);
  while (stack.length) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (!node) continue;
    for (const cid of childIdsOf(node)) {
      if (!visited.has(cid)) {
        visited.add(cid);
        out.push(cid);
        stack.push(cid);
      }
    }
  }
  return out;
}

function translateDescendants(nodes: Node[], scopeId: string, dx: number, dy: number, skipIds = new Set<string>): Node[] {
  if (dx === 0 && dy === 0) return nodes;
  const ids = new Set(descendantIds(scopeId, nodes));
  return nodes.map((n) =>
    ids.has(n.id) && !skipIds.has(n.id)
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
      : n
  );
}

/** 在给定 nodes 数组中设置某个节点的父容器（同时维护父子两端的 childIds/parentId）。 */
function applyParentChange(nodes: Node[], nodeId: string, parentId: string | null): Node[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || node.id === parentId) return nodes;
  const oldParent = parentIdOf(node);
  if (oldParent === parentId) return nodes;
  const scope = parentId ? nodes.find((n) => n.id === parentId && n.type === 'scope') : null;
  if (parentId && !scope) return nodes;
  if (parentId && node.type === 'scope' && isDescendantOf(parentId, nodeId, nodes)) return nodes;
  return nodes.map((n) => {
    const d = { ...(n.data as Record<string, unknown>) };
    if (n.id === nodeId) {
      d.parentId = parentId;
      d.memberBadge = parentId ? 'in:' + String((scope?.data as { label?: string })?.label || parentId) : null;
      return { ...n, data: d };
    }
    if (n.type === 'scope') {
      const childIds = childIdsOf(n).filter((id) => id !== nodeId);
      if (n.id === parentId) childIds.push(nodeId);
      setScopeChildren(d, childIds);
      return { ...n, data: d };
    }
    return n;
  });
}

interface GraphState extends GraphLike {
  root: Graph;
  past: GraphLike[];
  future: GraphLike[];
  selectedId: string | null;
  selectedIds: string[];
  altDragIds: string[];
  draggingIds: string[];
  resizingIds: string[];
  flow: Record<string, FlowResult>;

  setSelectedId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  setAltDrag: (ids: string[]) => void;
  setDragging: (ids: string[]) => void;
  setResizing: (ids: string[]) => void;
  commitDrop: (nodeId: string, altKey: boolean, targetId?: string | null) => void;
  addToScope: (nodeId: string, scopeId: string) => void;
  removeFromScope: (nodeId: string) => void;
  setNodeParent: (nodeId: string, parentId: string | null) => void;
  updateEdgeData: (edgeId: string, patch: Record<string, unknown>) => void;
  toggleScopeCollapsed: (scopeId: string) => void;
  createScopeFromSelection: () => void;
  commit: () => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (node: Node) => void;
  deleteNodes: (ids: string[]) => void;
  duplicateNode: (id: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  moveNode: (id: string, position: { x: number; y: number }, options?: { moveChildren?: boolean }) => void;
  /** 自动横向整理当前画布节点：全部排在同一行，分支并列 */
  layoutNodes: () => void;
  /** 自动整理（Blender Node Arrange 风格）：按依赖分层、分支并列 */
  arrangeNodes: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  load: (nodes: Node[], edges: Edge[]) => void;
  getGraph: () => Graph;
  getDocument: () => Graph;
  loadDocument: (doc: Graph) => void;
  runFlow: () => void;
}

const withHistory = (s: GraphState): Partial<GraphState> => {
  const snap = snapshot(s);
  const last = s.past[s.past.length - 1];
  if (last) {
    try {
      if (JSON.stringify(last) === JSON.stringify(snap)) return { future: [] };
    } catch {}
  }
  return { past: [...s.past, snap].slice(-100), future: [] };
};

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  root: { nodes: [], edges: [] },
  past: [],
  future: [],
  selectedId: null,
  selectedIds: [],
  altDragIds: [],
  draggingIds: [],
  resizingIds: [],
  flow: {},

  setSelectedId: (id) => set({ selectedId: id }),

  setSelectedIds: (ids) => set({ selectedIds: ids, selectedId: ids.length === 1 ? ids[0] : null }),

  setAltDrag: (ids) => set({ altDragIds: ids }),

  setDragging: (ids) => set({ draggingIds: ids }),

  setResizing: (ids) => set({ resizingIds: ids }),

  commitDrop: (nodeId, altKey, targetId) => {
    const s = get();
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // Alt 拖出 = 显式移出
    if (altKey) {
      const nodes = applyParentChange(s.nodes, nodeId, null);
      set({ nodes, ...withHistory(s) });
      return;
    }
    // 显式放入：targetId 来自 0.5s 悬停手势；未命中则如果原先是成员且拖出容器外则移出
    const finalTarget = targetId ?? null;
    const oldParent = parentIdOf(node);
    const shouldRemove = !finalTarget && oldParent != null;
    const nodes = shouldRemove ? applyParentChange(s.nodes, nodeId, null) : applyParentChange(s.nodes, nodeId, finalTarget);
    set({ nodes, ...withHistory(s) });
  },

  addToScope: (nodeId, scopeId) => {
    const s = get();
    const nodes = applyParentChange(s.nodes, nodeId, scopeId);
    set({ nodes, ...withHistory(s) });
  },

  removeFromScope: (nodeId) => {
    const s = get();
    const nodes = applyParentChange(s.nodes, nodeId, null);
    set({ nodes, ...withHistory(s) });
  },

  setNodeParent: (nodeId, parentId) => {
    const s = get();
    const nodes = applyParentChange(s.nodes, nodeId, parentId);
    set({ nodes, ...withHistory(s) });
  },

  updateEdgeData: (edgeId, patch) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId ? { ...e, data: { ...((e.data as Record<string, unknown>) || {}), ...patch } } : e
      ),
      ...withHistory(s),
    })),

  toggleScopeCollapsed: (scopeId) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === scopeId
          ? { ...n, data: { ...(n.data as Record<string, unknown>), collapsed: !((n.data as { collapsed?: boolean }).collapsed) } }
          : n
      ),
      ...withHistory(s),
    })),

  createScopeFromSelection: () => {
    const s = get();
    const ids = s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
    const chosen = s.nodes.filter((n) => ids.includes(n.id) && n.type !== 'scope');
    if (!chosen.length) return;
    const pad = 24;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of chosen) {
      const nd = n.data as { width?: number; height?: number };
      const w = (n.measured?.width as number) || nd.width || 170;
      const h = (n.measured?.height as number) || nd.height || 90;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const scopeId = uid('scope');
    const scopeNode: Node = withZIndex({
      id: scopeId,
      type: 'scope',
      position: { x: minX - pad, y: minY - pad },
      data: {
        label: '范围',
        status: 'pending',
        accent: '#8b5cf6',
        fill: '#3b2f6b',
        opacity: 0.16,
        width: Math.max(220, Math.ceil(maxX - minX + pad * 2)),
        height: Math.max(150, Math.ceil(maxY - minY + pad * 2)),
        childIds: [...ids],
        members: [...ids],
        shrink: false,
      },
    });
    let nodes: Node[] = s.nodes.map((n) => ({ ...n, selected: false }));
    for (const id of ids) nodes = applyParentChange(nodes, id, scopeId);
    nodes.push(scopeNode);
    set({ nodes, selectedId: scopeId, selectedIds: [scopeId], ...withHistory(s) });
  },

  commit: () =>
    set((s) => {
      const h = withHistory(s);
      return h.future !== undefined ? h : { future: [] };
    }),

  onNodesChange: (changes) =>
    set((s) => {
      const hasRemove = changes.some((c) => c.type === 'remove');
      let nodes = applyNodeChanges(changes, s.nodes).map(withZIndex);
      const explicitlyMoved = new Set(
        changes.filter((c) => c.type === 'position' && c.position).map((c) => (c as { id: string }).id)
      );
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const scope = s.nodes.find((n) => n.id === c.id && n.type === 'scope');
          if (scope) {
            const dx = c.position.x - scope.position.x;
            const dy = c.position.y - scope.position.y;
            if (dx !== 0 || dy !== 0) {
              nodes = translateDescendants(nodes, scope.id, dx, dy, explicitlyMoved);
            }
          }
        }
      }
      let selectedId = s.selectedId;
      for (const c of changes) {
        if (c.type === 'select' && 'selected' in c) {
          selectedId = c.selected ? c.id : selectedId === c.id ? null : selectedId;
        }
      }
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      // 删除节点（含 React Flow 的 Delete/Del 键）应记入撤销历史
      return { nodes, selectedId, selectedIds, ...(hasRemove ? withHistory(s) : {}) };
    }),

  onEdgesChange: (changes) =>
    set((s) => {
      const edges = applyEdgeChanges(changes, s.edges);
      const removes = changes.filter((c) => c.type === 'remove');
      if (!removes.length) return { edges };
      // 断连/删除连线记入撤销历史；但若边的端点节点已被删除（随节点删除连带移除），
      // 其历史已由 onNodesChange 记录，这里不再重复记录
      const nodeIds = new Set(s.nodes.map((n) => n.id));
      const orphaned = removes.some((c) => {
        const edge = s.edges.find((e) => e.id === c.id);
        return edge && (!nodeIds.has(edge.source) || !nodeIds.has(edge.target));
      });
      return orphaned ? { edges } : { edges, ...withHistory(s) };
    }),

  onConnect: (conn) => set((s) => ({ edges: addEdge({ ...conn, type: 'waypoint', animated: false }, s.edges), ...withHistory(s) })),

  addNode: (node) =>
    set((s) => ({
      nodes: [...s.nodes, withZIndex({ ...node, selected: true })],
      selectedId: node.id,
      ...withHistory(s),
    })),

  deleteNodes: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const existed = s.nodes.some((n) => idSet.has(n.id));
      const nodes = s.nodes
        .filter((n) => !idSet.has(n.id))
        .map((n) => {
          const d = { ...(n.data as Record<string, unknown>) };
          let changed = false;
          // 被删节点从 scope childIds 中移除；若被删节点是 scope，其后代恢复顶层
          if (n.type === 'scope') {
            const childIds = childIdsOf(n).filter((m) => !idSet.has(m));
            if (childIds.length !== childIdsOf(n).length) {
              setScopeChildren(d, childIds);
              changed = true;
            }
          }
          if (d.parentId && idSet.has(String(d.parentId))) {
            d.parentId = null;
            d.memberBadge = null;
            changed = true;
          }
          return changed ? { ...n, data: d } : n;
        });
      const edges = s.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target));
      const selectedId = s.selectedId && idSet.has(s.selectedId) ? null : s.selectedId;
      const selectedIds = s.selectedIds.filter((id) => !idSet.has(id));
      const altDragIds = s.altDragIds.filter((id) => !idSet.has(id));
      const draggingIds = s.draggingIds.filter((id) => !idSet.has(id));
      const resizingIds = s.resizingIds.filter((id) => !idSet.has(id));
      const flow = { ...s.flow };
      for (const id of ids) delete flow[id];
      return {
        nodes,
        edges,
        selectedId,
        selectedIds,
        altDragIds,
        draggingIds,
        resizingIds,
        flow,
        ...(existed ? withHistory(s) : {}),
      };
    }),

  duplicateNode: (id) =>
    set((s) => {
      const src = s.nodes.find((n) => n.id === id);
      if (!src) return s;
      const copyData = JSON.parse(JSON.stringify((src.data as Record<string, unknown>) || {})) as Record<string, unknown>;
      const copy: Node = withZIndex({
        ...JSON.parse(JSON.stringify(src)),
        id: uid(String(src.type || 'node')),
        position: { x: src.position.x + 48, y: src.position.y + 48 },
        selected: true,
        data: copyData,
      });
      const parentId = parentIdOf(src);
      if (parentId) {
        copyData.parentId = parentId;
        copyData.memberBadge = 'in:' + String((s.nodes.find((n) => n.id === parentId)?.data as { label?: string })?.label || parentId);
      } else {
        copyData.parentId = null;
        copyData.memberBadge = null;
      }
      if (src.type === 'scope') {
        copyData.childIds = [];
        copyData.members = [];
        copyData.shrink = Boolean(copyData.shrink);
      }
      const nodes: Node[] = s.nodes
        .map((n) => {
          if (parentId && n.id === parentId) {
            const childIds = childIdsOf(n);
            if (!childIds.includes(copy.id)) {
              const nextData = { ...(n.data as Record<string, unknown>) };
              setScopeChildren(nextData, [...childIds, copy.id]);
              return { ...n, data: nextData };
            }
          }
          return { ...n, selected: false };
        });
      nodes.push(copy);
      return { nodes: nodes.map(withZIndex), selectedId: copy.id, selectedIds: [copy.id], ...withHistory(s) };
    }),

  updateNodeData: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data as Record<string, unknown>), ...patch } } : n
      ),
    })),

  moveNode: (id, position, options) =>
    set((s) => {
      const current = s.nodes.find((n) => n.id === id);
      if (!current) return s;
      const dx = position.x - current.position.x;
      const dy = position.y - current.position.y;
      let nodes = s.nodes.map((n) => (n.id === id ? { ...n, position } : n));
      if (current.type === 'scope' && options?.moveChildren !== false) nodes = translateDescendants(nodes, id, dx, dy);
      return { nodes };
    }),

  /**
   * Agent 生成节点后的自动排版：所有节点排在同一行（不再因碰到边框换行）。
   * 顺序按图结构 BFS（先依赖前驱、再并列后继分支），使单个节点的多个分支并列相邻。
   */
  layoutNodes: () => {
    const s = get();
    // 只要存在带成员的 scope，就改用分层自动整理，避免“横排”把成员踢出容器
    if (s.nodes.some((n) => n.type === 'scope' && childIdsOf(n).length > 0)) {
      get().arrangeNodes();
      return;
    }
    set(() => {
      const margin = 24;
      const gapX = 32;
      const ordered = graphBreadthOrder(s.nodes, s.edges);
      let x = margin;
      const nodes = ordered.map((n) => {
        const nd = (n.data as Record<string, unknown>) || {};
        const w = (n.measured?.width as number | undefined) || (typeof nd.width === 'number' ? nd.width : 170);
        const pos = { x, y: margin };
        x += w + gapX;
        return { ...n, position: pos };
      });
      return { nodes };
    });
  },

  /**
   * 自动整理（参考 Blender Node Arrange）：先按「连通分量」分块，
   * 每个块内部按依赖分层（列）+ 列内按前驱重心排序（少交叉），
   * 块与块之间并排排布；范围节点(scope)作为成员的外框，按成员实际包围盒
   * 向左/向上扩展，保证即使成员在 scope 左侧也会被正确包裹。
   * 关联的节点按规律排版在一起；互不关联的分量各自成块，不再混排。
   */
  arrangeNodes: () => {
    set((s) => {
      const M = 24; // 外/内边距
      const GAP_X = 36; // 同块列间距
      const GAP_Y = 28; // 同块行间距
      const BLOCK_GAP = 56; // 块间水平间距
      const SCOPE_PAD = 16;

      const wOf = (n: Node): number => {
        const nd = (n.data as Record<string, unknown>) || {};
        return (n.measured?.width as number | undefined) || (typeof nd.width === 'number' ? nd.width : n.type === 'scope' ? 320 : 170);
      };
      const hOf = (n: Node): number => {
        const nd = (n.data as Record<string, unknown>) || {};
        return (n.measured?.height as number | undefined) || (typeof nd.height === 'number' ? nd.height : n.type === 'scope' ? 220 : 90);
      };
      const nodeById = new Map(s.nodes.map((n) => [n.id, n]));

      // 1. 连通分量（无向）
      const comps = connectedComponents(s.nodes, s.edges);
      comps.sort((a, b) => {
        const hasStart = (c: Node[]) => c.some((n) => n.type === 'start');
        const sa = hasStart(a) ? 1 : 0;
        const sb = hasStart(b) ? 1 : 0;
        if (sa !== sb) return sb - sa; // 含 start 的块优先
        return b.length - a.length;
      });

      const allPos = new Map<string, { x: number; y: number }>();
      const scopeSizeUpdates = new Map<string, { width: number; height: number }>();
      let blockX = M;
      const edgesByComp: Edge[][] = [];
      for (let ci = 0; ci < comps.length; ci++) {
        const ids = new Set(comps[ci].map((n) => n.id));
        edgesByComp.push(s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)));
      }

      for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci];
        const cEdges = edgesByComp[ci];
        const ranks = computeRanks(comp, cEdges);
        // 带成员的 scope 是“外框”，不参与普通列排版，最后按成员包围盒包裹；
        // 只有普通节点（以及无成员的 scope）才进入依赖列布局，避免 scope 的宽框把整块撑散
        const compIds = new Set(comp.map((n) => n.id));
        const layoutNodes = comp.filter((n) => {
          if (n.type !== 'scope') return true;
          return !childIdsOf(n).some((m) => compIds.has(m));
        });
        const groups = new Map<number, Node[]>();
        for (const n of layoutNodes) {
          const r = ranks.get(n.id) ?? 0;
          if (!groups.has(r)) groups.set(r, []);
          groups.get(r)!.push(n);
        }
        const rankIndices = [...groups.keys()].sort((a, b) => a - b);

        // 每列只按本列最大宽度推进，避免某个宽节点把整块所有列都撑得很散
        const rankXs = new Map<number, number>();
        let colX = M;
        for (const r of rankIndices) {
          rankXs.set(r, colX);
          const rankW = Math.max(...groups.get(r)!.map((n) => wOf(n)));
          colX += rankW + GAP_X;
        }

        const compPos = new Map<string, { x: number; y: number }>();
        for (const r of rankIndices) {
          const x = rankXs.get(r)!;
          const ordered = orderWithinRank(groups.get(r)!, cEdges, ranks);
          let y = M;
          for (const n of ordered) {
            compPos.set(n.id, { x, y });
            y += hOf(n) + GAP_Y;
          }
        }

        // 2. 让 scope 按成员实际包围盒放置/缩放：成员在左/上时，scope 向左/上扩展
        for (const n of comp) {
          if (n.type !== 'scope') continue;
          const memberIds = childIdsOf(n).filter((m) => compPos.has(m));
          if (!memberIds.length) continue;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const m of memberIds) {
            const mp = compPos.get(m)!;
            const mn = nodeById.get(m)!;
            minX = Math.min(minX, mp.x);
            minY = Math.min(minY, mp.y);
            maxX = Math.max(maxX, mp.x + wOf(mn));
            maxY = Math.max(maxY, mp.y + hOf(mn));
          }
          compPos.set(n.id, { x: minX - SCOPE_PAD, y: minY - SCOPE_PAD });
          scopeSizeUpdates.set(n.id, {
            width: Math.max(220, Math.ceil(maxX - minX + SCOPE_PAD * 2)),
            height: Math.max(150, Math.ceil(maxY - minY + SCOPE_PAD * 2)),
          });
        }

        // 3. 块整体偏移到 blockX（以块内最左位置为基准，避免向左扩展后侵入前一列）
        if (compPos.size === 0) continue;
        let minBlockX = Infinity;
        for (const p of compPos.values()) minBlockX = Math.min(minBlockX, p.x);
        let blockW = 0;
        for (const [id, p] of compPos) {
          const node = nodeById.get(id)!;
          const w = scopeSizeUpdates.get(id)?.width ?? wOf(node);
          allPos.set(id, { x: p.x + blockX - minBlockX, y: p.y });
          blockW = Math.max(blockW, w + p.x - minBlockX + GAP_X);
        }
        blockX += blockW + BLOCK_GAP;
      }

      // 4. 整理后校验：所有显式成员必须落在父包围盒内（含 padding），越界平移回最近合法位置
      for (const scope of s.nodes) {
        if (scope.type !== 'scope') continue;
        const size = scopeSizeUpdates.get(scope.id);
        const sp = allPos.get(scope.id);
        if (!size || !sp) continue;
        for (const m of childIdsOf(scope)) {
          const mp = allPos.get(m);
          const mn = nodeById.get(m);
          if (!mp || !mn) continue;
          const mw = wOf(mn);
          const mh = hOf(mn);
          let x = mp.x;
          let y = mp.y;
          const minX = sp.x + SCOPE_PAD;
          const minY = sp.y + SCOPE_PAD;
          const maxX = sp.x + size.width - SCOPE_PAD - mw;
          const maxY = sp.y + size.height - SCOPE_PAD - mh;
          x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
          y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
          allPos.set(m, { x, y });
        }
      }

      const nodes = s.nodes.map((n) => {
        const pos = allPos.get(n.id);
        if (!pos) return n;
        const size = scopeSizeUpdates.get(n.id);
        if (!size) return { ...n, position: pos };
        return {
          ...n,
          position: pos,
          data: { ...(n.data as Record<string, unknown>), ...size },
        };
      });
      return { nodes };
    });
  },

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1];
      return {
        nodes: prev.nodes.map(withZIndex),
        edges: prev.edges,
        selectedId: null,
        past: s.past.slice(0, -1),
        future: [...s.future, snapshot(s)],
      };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[s.future.length - 1];
      return {
        nodes: next.nodes.map(withZIndex),
        edges: next.edges,
        selectedId: null,
        future: s.future.slice(0, -1),
        past: [...s.past, snapshot(s)],
      };
    }),

  clear: () =>
    set((s) => ({
      nodes: [],
      edges: [],
      root: { nodes: [], edges: [] },
      selectedId: null,
      flow: {},
      ...withHistory(s),
    })),

  load: (nodes, edges) => {
    const clean = stripLegacyTypes(nodes, edges);
    const normalized = normalizeParentChild(clean.nodes).map(withZIndex);
    set({
      nodes: normalized,
      edges: clean.edges,
      root: { nodes: normalized, edges: clean.edges },
      selectedId: null,
      past: [],
      future: [],
      flow: {},
    });
  },

  getGraph: () => snapshot(get()),

  getDocument: () => snapshot(get()),

  loadDocument: (doc) => {
    const nodes = (doc && doc.nodes) || [];
    const edges = (doc && doc.edges) || [];
    const clean = stripLegacyTypes(nodes, edges);
    const normalized = normalizeParentChild(clean.nodes).map(withZIndex);
    set({
      nodes: normalized,
      edges: clean.edges,
      root: { nodes: normalized, edges: clean.edges },
      selectedId: null,
      past: [],
      future: [],
      flow: {},
    });
  },

  runFlow: () => {
    const s = get();
    set({ flow: computeFlow(s.nodes, s.edges) });
  },
}));

/**
 * 无向连通分量：用于自动整理时分块（Blender Node Arrange 思路——关联节点成块排版）。
 * 返回按节点数从大到小排序的分量；含 start 的分量排最前。
 */
function connectedComponents(nodes: Node[], edges: Edge[]): Node[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  const link = (a: string, b: string) => {
    if (!adj.has(a) || !adj.has(b) || a === b) return;
    if (!adj.get(a)!.includes(b)) adj.get(a)!.push(b);
    if (!adj.get(b)!.includes(a)) adj.get(b)!.push(a);
  };
  for (const e of edges) link(e.source, e.target);
  // 范围节点与其成员视为同一分量（容器关系也属于关联），保证自动整理时成员与 scope 同块
  for (const n of nodes) {
    if (n.type === 'scope') {
      for (const m of childIdsOf(n)) link(n.id, m);
    }
  }
  const visited = new Set<string>();
  const comps: Node[][] = [];
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    const comp: Node[] = [];
    const stack = [n.id];
    visited.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      const node = nodes.find((x) => x.id === id);
      if (node) comp.push(node);
      for (const nb of adj.get(id) || []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => {
    const sa = a.some((n) => n.type === 'start') ? 1 : 0;
    const sb = b.some((n) => n.type === 'start') ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return b.length - a.length;
  });
  return comps;
}

/**
 * 图结构的广度优先顺序：从入度为 0 的根出发，逐层展开后继，
 * 使单个节点的多个分支（后继）并列相邻。孤立节点按原顺序补在末尾。
 */
function graphBreadthOrder(nodes: Node[], edges: Edge[]): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (byId.has(e.source) && byId.has(e.target) && e.source !== e.target) {
      if (!adj.get(e.source)!.includes(e.target)) adj.get(e.source)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  }
  const roots = nodes.filter((n) => indeg.get(n.id) === 0);
  roots.sort((a, b) => a.position.x - b.position.x);
  const order: Node[] = [];
  const visited = new Set<string>();
  const queue: string[] = roots.map((n) => n.id);
  for (const id of queue) visited.add(id);
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) order.push(node);
    const succ = adj.get(id) || [];
    succ.sort((a, b) => {
      const na = byId.get(a);
      const nb = byId.get(b);
      return (na && nb ? na.position.x - nb.position.x : 0);
    });
    for (const t of succ) {
      if (!visited.has(t)) {
        visited.add(t);
        queue.push(t);
      }
    }
  }
  for (const n of nodes) if (!visited.has(n.id)) order.push(n);
  return order;
}

/** 计算每列（rank）内的节点顺序：按前驱列的平均位置（barycenter）排序，减少连线交叉 */
function orderWithinRank(list: Node[], edges: Edge[], ranks: Map<string, number>): Node[] {
  const byId = new Map(list.map((n) => [n.id, n]));
  const pred = new Map<string, Node[]>();
  for (const n of list) pred.set(n.id, []);
  for (const e of edges) {
    if (pred.has(e.target) && byId.has(e.source)) {
      const p = byId.get(e.source)!;
      if (!pred.get(e.target)!.includes(p)) pred.get(e.target)!.push(p);
    }
  }
  return [...list].sort((a, b) => {
    const avgA = avgPredX(a, pred, ranks);
    const avgB = avgPredX(b, pred, ranks);
    if (avgA !== avgB) return avgA - avgB;
    return a.position.x - b.position.x;
  });
}

function avgPredX(node: Node, pred: Map<string, Node[]>, ranks: Map<string, number>): number {
  const ps = pred.get(node.id) || [];
  if (!ps.length) return node.position.x;
  return ps.reduce((sum, p) => sum + (ranks.get(p.id) ?? 0) * 1000 + p.position.y, 0) / ps.length;
}

/**
 * 分层（Sugiyama 最长路径）：rank = 从任意根出发到该节点的最长路径长度。
 * 含环时对未定级节点递增补级，避免死循环。
 */
function computeRanks(nodes: Node[], edges: Edge[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
    rev.set(n.id, []);
  }
  for (const e of edges) {
    if (byId.has(e.source) && byId.has(e.target) && e.source !== e.target) {
      if (!adj.get(e.source)!.includes(e.target)) {
        adj.get(e.source)!.push(e.target);
        rev.get(e.target)!.push(e.source);
        indeg.set(e.target, indeg.get(e.target)! + 1);
      }
    }
  }
  const rank = new Map<string, number>();
  const queue: string[] = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of adj.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  // 剩余未定级（环）节点：沿用入边最大 rank + 1 或按原顺序递增
  for (const n of nodes) {
    if (rank.has(n.id)) continue;
    let r = 0;
    for (const p of rev.get(n.id)!) r = Math.max(r, (rank.get(p) ?? 0) + 1);
    rank.set(n.id, r);
  }
  return rank;
}
