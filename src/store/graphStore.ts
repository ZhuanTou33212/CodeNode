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
import type { FlowResult, Graph, GroupData } from '../types';
import { computeFlow, nodesInsideBounds } from '../lib/flow';

type GraphLike = { nodes: Node[]; edges: Edge[] };

const snapshot = (s: GraphLike): Graph => ({
  nodes: JSON.parse(JSON.stringify(s.nodes)),
  edges: JSON.parse(JSON.stringify(s.edges)),
});

function withZIndex(n: Node): Node {
  if (n.type === 'user') return { ...n, zIndex: -1 };
  if (n.type === 'scope') return { ...n, zIndex: 0 };
  return { ...n, zIndex: 1 };
}

const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

interface GraphState extends GraphLike {
  root: Graph;
  groups: Record<string, Graph>;
  viewStack: string[];
  past: GraphLike[];
  future: GraphLike[];
  selectedId: string | null;
  selectedIds: string[];
  altDragIds: string[];
  draggingIds: string[];
  flow: Record<string, FlowResult>;

  setSelectedId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  setAltDrag: (ids: string[]) => void;
  setDragging: (ids: string[]) => void;
  commitDrop: (nodeId: string, altKey: boolean) => void;
  commit: () => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (node: Node) => void;
  deleteNodes: (ids: string[]) => void;
  duplicateNode: (id: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  /** 自动横向整理当前画布节点：超宽换行到下一排 */
  layoutNodes: (maxX?: number) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  load: (nodes: Node[], edges: Edge[]) => void;
  getGraph: () => Graph;
  getDocument: () => { root: Graph; groups: Record<string, Graph>; viewStack: string[] };
  loadDocument: (doc: { root: Graph; groups: Record<string, Graph>; viewStack: string[] }) => void;
  runFlow: () => void;

  makeGroup: (ids?: string[]) => void;
  ungroupGroup: () => void;
  enterGroup: (id: string) => void;
  exitGroup: () => void;
  addGroupSocket: (gid: string, dir: 'in' | 'out') => void;
  removeGroupSocket: (gid: string, dir: 'in' | 'out', id: string) => void;
  canEnterGroup: boolean;
}

const withHistory = (s: GraphState): Partial<GraphState> => ({
  past: [...s.past, snapshot(s)].slice(-100),
  future: [],
});

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  root: { nodes: [], edges: [] },
  groups: {},
  viewStack: [],
  past: [],
  future: [],
  selectedId: null,
  selectedIds: [],
  altDragIds: [],
  draggingIds: [],
  flow: {},
  canEnterGroup: false,

  setSelectedId: (id) => set({ selectedId: id }),

  setSelectedIds: (ids) => set({ selectedIds: ids, selectedId: ids.length === 1 ? ids[0] : null }),

  setAltDrag: (ids) => set({ altDragIds: ids }),

  setDragging: (ids) => set({ draggingIds: ids }),

  commitDrop: (nodeId, altKey) => {
    const s = get();
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const containers = s.nodes.filter((n) => n.type === 'user' || n.type === 'scope');
    let targetId: string | null = null;
    if (!altKey) {
      for (const c of containers) {
        if (nodesInsideBounds(c, [node]).length > 0) {
          targetId = c.id;
          break;
        }
      }
    }
    const newNodes = s.nodes.map((n) => {
      if (n.type !== 'user' && n.type !== 'scope') return n;
      const members = [...((n.data as { members?: string[] }).members || [])];
      const has = members.includes(nodeId);
      if (altKey) {
        return has
          ? { ...n, data: { ...(n.data as Record<string, unknown>), members: members.filter((m) => m !== nodeId) } }
          : n;
      }
      if (n.id === targetId) {
        return has
          ? n
          : { ...n, data: { ...(n.data as Record<string, unknown>), members: [...members, nodeId] } };
      }
      return has
        ? { ...n, data: { ...(n.data as Record<string, unknown>), members: members.filter((m) => m !== nodeId) } }
        : n;
    });
    set({ nodes: newNodes });
  },

  commit: () =>
    set((s) => {
      const past = [...s.past, snapshot(s)].slice(-100);
      return { past, future: [] };
    }),

  onNodesChange: (changes) =>
    set((s) => {
      let nodes = applyNodeChanges(changes, s.nodes).map(withZIndex);
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const scope = s.nodes.find(
            (n) => n.id === c.id && (n.type === 'scope' || n.type === 'user')
          );
          if (scope) {
            const dx = c.position.x - scope.position.x;
            const dy = c.position.y - scope.position.y;
            if (dx !== 0 || dy !== 0) {
              const memberIds = new Set((scope.data as { members?: string[] })?.members || []);
              nodes = nodes.map((n) =>
                memberIds.has(n.id)
                  ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
                  : n
              );
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
      return { nodes, selectedId, selectedIds };
    }),

  onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

  onConnect: (conn) => set((s) => ({ edges: addEdge({ ...conn, animated: true }, s.edges), ...withHistory(s) })),

  addNode: (node) =>
    set((s) => ({
      nodes: [...s.nodes, withZIndex({ ...node, selected: true })],
      selectedId: node.id,
      ...withHistory(s),
    })),

  deleteNodes: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const nodes = s.nodes.filter((n) => !idSet.has(n.id));
      const edges = s.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target));
      const selectedId = s.selectedId && idSet.has(s.selectedId) ? null : s.selectedId;
      return { nodes, edges, selectedId, ...withHistory(s) };
    }),

  duplicateNode: (id) =>
    set((s) => {
      const src = s.nodes.find((n) => n.id === id);
      if (!src) return s;
      const copy: Node = withZIndex({
        ...JSON.parse(JSON.stringify(src)),
        id: uid(String(src.type || 'node')),
        position: { x: src.position.x + 48, y: src.position.y + 48 },
        selected: true,
      });
      const nodes: Node[] = s.nodes.map((n) => ({ ...n, selected: false }));
      nodes.push(copy);
      return { nodes, selectedId: copy.id, ...withHistory(s) };
    }),

  updateNodeData: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data as Record<string, unknown>), ...patch } } : n
      ),
    })),

  moveNode: (id, position) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, position } : n)) })),

  layoutNodes: (maxX) => {
    set((s) => {
      const view = document.querySelector('.canvas-wrap');
      const W = maxX || (view ? (view as HTMLElement).clientWidth : 0) || 1200;
      const margin = 40;
      const gapX = 44;
      const gapY = 56;
      let x = margin;
      let y = margin;
      let rowBottom = margin;
      const nodes = s.nodes.map((n) => {
        const nd = (n.data as Record<string, unknown>) || {};
        const w = (n.measured?.width as number | undefined) || (typeof nd.width === 'number' ? nd.width : 170);
        const h = (n.measured?.height as number | undefined) || (typeof nd.height === 'number' ? nd.height : 90);
        if (x + w > W - margin) {
          x = margin;
          y = rowBottom + gapY;
        }
        rowBottom = Math.max(rowBottom, y + h);
        const pos = { x, y };
        x += w + gapX;
        return { ...n, position: pos };
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
      groups: {},
      viewStack: [],
      selectedId: null,
      flow: {},
      ...withHistory(s),
    })),

  load: (nodes, edges) =>
    set({
      nodes: nodes.map(withZIndex),
      edges,
      root: { nodes: nodes.map(withZIndex), edges },
      groups: {},
      viewStack: [],
      selectedId: null,
      past: [],
      future: [],
      flow: {},
    }),

  getGraph: () => snapshot(get()),

  getDocument: () => {
    const s = get();
    const groups = { ...s.groups };
    let root = s.root;
    if (s.viewStack.length === 0) {
      root = snapshot({ nodes: s.nodes, edges: s.edges });
    } else {
      const top = s.viewStack[s.viewStack.length - 1];
      groups[top] = snapshot({ nodes: s.nodes, edges: s.edges });
    }
    return { root, groups, viewStack: s.viewStack };
  },

  loadDocument: (doc) => {
    const stack = doc.viewStack || [];
    const groups = doc.groups || {};
    const root = doc.root || { nodes: [], edges: [] };
    let nodes: Node[], edges: Edge[];
    if (stack.length === 0) {
      nodes = root.nodes;
      edges = root.edges;
    } else {
      const top = stack[stack.length - 1];
      const g = groups[top];
      nodes = g ? g.nodes : [];
      edges = g ? g.edges : [];
    }
    set({
      nodes: nodes.map(withZIndex),
      edges,
      root,
      groups,
      viewStack: stack,
      selectedId: null,
      past: [],
      future: [],
      flow: {},
      canEnterGroup: stack.length > 0,
    });
  },

  runFlow: () => {
    const s = get();
    set({ flow: computeFlow(s.nodes, s.edges, s.groups) });
  },

  // ---------- 节点组（Blender 风格） ----------
  makeGroup: (ids) => {
    const s = get();
    const sel =
      ids && ids.length
        ? ids
        : s.selectedIds && s.selectedIds.length
          ? s.selectedIds
          : s.selectedId
            ? [s.selectedId]
            : [];
    const chosen = s.nodes.filter((n) => sel.includes(n.id));
    if (chosen.length === 0) return;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of chosen) {
      const w = (n.measured?.width as number) || 88;
      const h = (n.measured?.height as number) || 64;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const pad = 24;
    const originX = minX - pad;
    const originY = minY - pad;
    const gid = uid('group');

    const subNodes = chosen.map((n) => ({
      ...JSON.parse(JSON.stringify(n)),
      position: { x: n.position.x - originX, y: n.position.y - originY },
      selected: false,
    }));
    const selSet = new Set(chosen.map((n) => n.id));

    const inputs: { id: string; toId: string }[] = [];
    const outputs: { id: string; fromId: string }[] = [];
    const keepEdges: Edge[] = [];
    for (const e of s.edges) {
      const sIn = selSet.has(e.source);
      const tIn = selSet.has(e.target);
      if (sIn && tIn) {
        continue; // 内部边进入子图
      } else if (!sIn && tIn) {
        const sid = 'in-' + (inputs.length + 1);
        inputs.push({ id: sid, toId: e.target });
        keepEdges.push({ ...e, target: gid, targetHandle: sid });
      } else if (sIn && !tIn) {
        const sid = 'out-' + (outputs.length + 1);
        outputs.push({ id: sid, fromId: e.source });
        keepEdges.push({ ...e, source: gid, sourceHandle: sid });
      } else {
        keepEdges.push(e);
      }
    }
    // 始终保证至少各有一个端子，便于组内/组外接线
    if (inputs.length === 0) inputs.push({ id: 'in-1', toId: '' });
    if (outputs.length === 0) outputs.push({ id: 'out-1', fromId: '' });

    const subEdges = s.edges
      .filter((e) => selSet.has(e.source) && selSet.has(e.target))
      .map((e) => ({ ...e }));

    const giId = gid + '-gi';
    subNodes.push({
      id: giId,
      type: 'group-input',
      position: { x: 0, y: 40 },
      data: { label: '组输入', socketIds: inputs.map((i) => i.id), status: 'pending', accent: '#22c55e' },
    });
    for (const i of inputs) {
      if (i.toId) subEdges.push({ id: eid(), source: giId, sourceHandle: i.id, target: i.toId, animated: true });
    }
    const goId = gid + '-go';
    subNodes.push({
      id: goId,
      type: 'group-output',
      position: { x: 300, y: 40 },
      data: { label: '组输出', socketIds: outputs.map((o) => o.id), status: 'pending', accent: '#ef4444' },
    });
    for (const o of outputs) {
      if (o.fromId) subEdges.push({ id: eid(), source: o.fromId, target: goId, targetHandle: o.id, animated: true });
    }

    const parentNodes = s.nodes.filter((n) => !selSet.has(n.id));
    const groupNode: Node = {
      id: gid,
      type: 'group',
      position: { x: originX, y: originY },
      data: {
        label: '节点组',
        status: 'pending',
        accent: '#06b6d4',
        width: maxX - originX,
        height: maxY - originY,
        sockets: { inputs, outputs },
      } as GroupData,
    };
    parentNodes.push(groupNode);

    set({
      nodes: parentNodes.map(withZIndex),
      edges: keepEdges,
      selectedId: gid,
      past: [...s.past, snapshot(s)].slice(-100),
      future: [],
      groups: { ...s.groups, [gid]: { nodes: subNodes, edges: subEdges } },
    });
    get().enterGroup(gid);
  },

  enterGroup: (id) => {
    const s = get();
    const groups = { ...s.groups };
    if (s.viewStack.length === 0) {
      set({ root: snapshot({ nodes: s.nodes, edges: s.edges }) });
    } else {
      const top = s.viewStack[s.viewStack.length - 1];
      groups[top] = snapshot({ nodes: s.nodes, edges: s.edges });
    }
    const sub = groups[id] || { nodes: [], edges: [] };
    set({
      nodes: sub.nodes.map(withZIndex),
      edges: sub.edges,
      groups,
      viewStack: [...s.viewStack, id],
      selectedId: null,
      past: [],
      future: [],
      flow: {},
      canEnterGroup: true,
    });
  },

  exitGroup: () => {
    const s = get();
    if (s.viewStack.length === 0) return;
    const top = s.viewStack[s.viewStack.length - 1];
    const groups = { ...s.groups, [top]: snapshot({ nodes: s.nodes, edges: s.edges }) };
    const stack = s.viewStack.slice(0, -1);
    let nodes: Node[], edges: Edge[];
    if (stack.length === 0) {
      nodes = s.root.nodes;
      edges = s.root.edges;
    } else {
      const p = groups[stack[stack.length - 1]];
      nodes = p.nodes;
      edges = p.edges;
    }
    set({
      nodes: nodes.map(withZIndex),
      edges,
      groups,
      viewStack: stack,
      selectedId: null,
      past: [],
      future: [],
      flow: {},
      canEnterGroup: stack.length > 0,
    });
  },

  ungroupGroup: () => {
    const s = get();
    const top = s.viewStack[s.viewStack.length - 1];
    if (!top) return;
    const parentGraph = s.viewStack.length > 1 ? s.groups[s.viewStack[s.viewStack.length - 2]] : s.root;
    const gNode = parentGraph.nodes.find((n) => n.id === top);
    if (!gNode) return;
    const gData = gNode.data as unknown as GroupData;
    const gx = gNode.position.x;
    const gy = gNode.position.y;

    const expanded = s.nodes
      .filter((n) => n.type !== 'group-input' && n.type !== 'group-output')
      .map((n) => ({
        ...JSON.parse(JSON.stringify(n)),
        position: { x: n.position.x + gx, y: n.position.y + gy },
      }));
    const expandedEdges = s.edges.filter((e) => {
      const sn = s.nodes.find((n) => n.id === e.source);
      const tn = s.nodes.find((n) => n.id === e.target);
      return sn && tn && sn.type !== 'group-input' && sn.type !== 'group-output';
    }).map((e) => ({ ...e }));

    const parentEdges = parentGraph.edges.filter((e) => e.source !== top && e.target !== top);
    for (const e of parentGraph.edges) {
      if (e.target === top) {
        const def = gData.sockets.inputs.find((i) => i.id === (e.targetHandle || 'in'));
        if (def && def.toId) parentEdges.push({ ...e, target: def.toId, targetHandle: null });
      } else if (e.source === top) {
        const def = gData.sockets.outputs.find((o) => o.id === (e.sourceHandle || 'out'));
        if (def && def.fromId) parentEdges.push({ ...e, source: def.fromId, sourceHandle: null });
      }
    }
    const parentNodes = parentGraph.nodes.filter((n) => n.id !== top).concat(expanded);

    const groups = { ...s.groups };
    delete groups[top];
    const stack = s.viewStack.slice(0, -1);
    const patch: Partial<GraphState> = {
      nodes: parentNodes.map(withZIndex),
      edges: parentEdges,
      groups,
      viewStack: stack,
      selectedId: null,
      past: [],
      future: [],
      flow: {},
      canEnterGroup: stack.length > 0,
    };
    if (stack.length === 0) {
      patch.root = { nodes: parentNodes, edges: parentEdges };
    } else {
      groups[stack[stack.length - 1]] = { nodes: parentNodes, edges: parentEdges };
    }
    set(patch);
  },

  addGroupSocket: (gid, dir) => {
    const s = get();
    const groupNode = s.nodes.find((n) => n.id === gid && n.type === 'group');
    const sub = s.groups[gid];
    if (!groupNode || !sub) return;
    const gd = groupNode.data as unknown as GroupData;
    const sockets = { ...gd.sockets };
    const list = dir === 'in' ? sockets.inputs : sockets.outputs;
    const next = (dir === 'in' ? 'in-' : 'out-') + (list.length + 1);
    if (dir === 'in') sockets.inputs = [...list, { id: next, toId: '' }];
    else sockets.outputs = [...list, { id: next, fromId: '' }];
    const termType = dir === 'in' ? 'group-input' : 'group-output';
    const subNodes = sub.nodes.map((n) =>
      n.type === termType
        ? {
            ...n,
            data: {
              ...(n.data as object),
              socketIds: [...((n.data as { socketIds?: string[] }).socketIds || []), next],
            },
          }
        : n
    );
    set({ groups: { ...s.groups, [gid]: { nodes: subNodes, edges: sub.edges } } });
    get().updateNodeData(gid, { sockets });
  },

  removeGroupSocket: (gid, dir, id) => {
    const s = get();
    const groupNode = s.nodes.find((n) => n.id === gid && n.type === 'group');
    const sub = s.groups[gid];
    if (!groupNode || !sub) return;
    const gd = groupNode.data as unknown as GroupData;
    const sockets = { ...gd.sockets };
    const list = dir === 'in' ? sockets.inputs : sockets.outputs;
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (dir === 'in') sockets.inputs = list;
    else sockets.outputs = list;

    let subEdges = sub.edges;
    const termType = dir === 'in' ? 'group-input' : 'group-output';
    const term = sub.nodes.find((n) => n.type === termType);
    if (term) {
      subEdges =
        dir === 'in'
          ? subEdges.filter((e) => !(e.source === term.id && (e.sourceHandle || 'in') === id))
          : subEdges.filter((e) => !(e.target === term.id && (e.targetHandle || 'out') === id));
    }
    const subNodes = sub.nodes.map((n) =>
      n.type === termType
        ? {
            ...n,
            data: {
              ...(n.data as object),
              socketIds: ((n.data as { socketIds?: string[] }).socketIds || []).filter((x) => x !== id),
            },
          }
        : n
    );
    const edges = s.edges.filter(
      (e) =>
        !(dir === 'in' && e.target === gid && (e.targetHandle || 'in') === id) &&
        !(dir === 'out' && e.source === gid && (e.sourceHandle || 'out') === id)
    );
    set({ groups: { ...s.groups, [gid]: { nodes: subNodes, edges: subEdges } }, edges });
    get().updateNodeData(gid, { sockets });
  },
}));
