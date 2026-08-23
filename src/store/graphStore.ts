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

type Graph = { nodes: Node[]; edges: Edge[] };

const snapshot = (s: { nodes: Node[]; edges: Edge[] }): Graph => ({
  nodes: JSON.parse(JSON.stringify(s.nodes)),
  edges: JSON.parse(JSON.stringify(s.edges)),
});

interface GraphState extends Graph {
  past: Graph[];
  future: Graph[];
  selectedId: string | null;

  setSelectedId: (id: string | null) => void;
  commit: () => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (node: Node) => void;
  deleteNodes: (ids: string[]) => void;
  duplicateNode: (id: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  load: (nodes: Node[], edges: Edge[]) => void;
  getGraph: () => Graph;
}

const withHistory = (s: GraphState): Partial<GraphState> => ({
  past: [...s.past, snapshot(s)].slice(-100),
  future: [],
});

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  past: [],
  future: [],
  selectedId: null,

  setSelectedId: (id) => set({ selectedId: id }),

  commit: () =>
    set((s) => {
      const past = [...s.past, snapshot(s)].slice(-100);
      return { past, future: [] };
    }),

  onNodesChange: (changes) =>
    set((s) => {
      const nodes = applyNodeChanges(changes, s.nodes);
      let selectedId = s.selectedId;
      for (const c of changes) {
        if (c.type === 'select' && 'selected' in c) {
          selectedId = c.selected ? c.id : selectedId === c.id ? null : selectedId;
        }
      }
      return { nodes, selectedId };
    }),

  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

  onConnect: (conn) =>
    set((s) => ({ edges: addEdge({ ...conn, animated: true }, s.edges), ...withHistory(s) })),

  addNode: (node) =>
    set((s) => ({
      nodes: [...s.nodes, { ...node, selected: true }],
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
      const copy: Node = {
        ...JSON.parse(JSON.stringify(src)),
        id: `${src.type || 'node'}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
        position: { x: src.position.x + 48, y: src.position.y + 48 },
        selected: true,
      };
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

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1];
      return {
        nodes: prev.nodes,
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
        nodes: next.nodes,
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
      selectedId: null,
      ...withHistory(s),
    })),

  load: (nodes, edges) => set({ nodes, edges, selectedId: null, past: [], future: [] }),

  getGraph: () => snapshot(get()),
}));
