import { create } from 'zustand';
import type { SessionDoc } from '../types';
import { useGraphStore } from './graphStore';
import { useSessionStore } from './sessionStore';

export type Checkpoint = {
  id: string;
  label: string;
  createdAt: number;
  projectRoot?: string | null;
  doc: SessionDoc;
};

const STORAGE_KEY = 'codenode.checkpoints.v1';

function readInitial(): Checkpoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(items: Checkpoint[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30))); } catch {}
}

function visible(items: Checkpoint[], root: string | null) {
  return root ? items.filter((item) => !item.projectRoot || item.projectRoot === root) : items;
}

export const useCheckpointStore = create<{
  items: Checkpoint[];
  projectRoot: string | null;
  setProjectRoot: (root: string | null, imported?: Checkpoint[]) => void;
  create: (label?: string) => Checkpoint | null;
  restore: (id: string) => boolean;
  remove: (id: string) => void;
}>((set, get) => ({
  items: readInitial(),
  projectRoot: null,
  setProjectRoot: (root, imported) => {
    const all = readInitial();
    const normalized = (imported || []).map((item) => ({ ...item, projectRoot: root }));
    const next = imported ? [...all.filter((item) => item.projectRoot !== root), ...normalized] : all;
    persist(next);
    set({ projectRoot: root, items: visible(next, root) });
  },
  create: (label) => {
    const doc = useGraphStore.getState().getDocument();
    const root = get().projectRoot;
    const item: Checkpoint = {
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: label?.trim() || '手动检查点',
      createdAt: Date.now(),
      projectRoot: root,
      doc: { root: JSON.parse(JSON.stringify(doc)) },
    };
    const items = [item, ...get().items].slice(0, 30);
    const all = readInitial().filter((x) => x.projectRoot !== root);
    set({ items });
    persist([...items, ...all.filter((x) => !items.some((y) => y.id === x.id))]);
    return item;
  },
  restore: (id) => {
    const item = get().items.find((x) => x.id === id);
    if (!item) return false;
    useGraphStore.getState().loadDocument(item.doc.root);
    useSessionStore.getState().syncActiveGraph();
    return true;
  },
  remove: (id) => {
    const all = readInitial().filter((x) => x.id !== id);
    const items = get().items.filter((x) => x.id !== id);
    set({ items });
    persist(all);
  },
}));
