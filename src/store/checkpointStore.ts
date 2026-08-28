import { create } from 'zustand';
import type { SessionDoc } from '../types';
import { useGraphStore } from './graphStore';
import { useSessionStore } from './sessionStore';

export type Checkpoint = {
  id: string;
  label: string;
  createdAt: number;
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

export const useCheckpointStore = create<{
  items: Checkpoint[];
  create: (label?: string) => Checkpoint | null;
  restore: (id: string) => boolean;
  remove: (id: string) => void;
}>((set, get) => ({
  items: readInitial(),
  create: (label) => {
    const doc = useGraphStore.getState().getDocument();
    const item: Checkpoint = {
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: label?.trim() || '手动检查点',
      createdAt: Date.now(),
      doc: { root: JSON.parse(JSON.stringify(doc)) },
    };
    const items = [item, ...get().items].slice(0, 30);
    set({ items });
    persist(items);
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
    const items = get().items.filter((x) => x.id !== id);
    set({ items });
    persist(items);
  },
}));
