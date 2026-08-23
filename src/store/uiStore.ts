import { create } from 'zustand';

interface UiState {
  leftOpen: boolean;
  leftWidth: number;
  inspectorOpen: boolean;
  addMenu: { x: number; y: number } | null;
  lastMouse: { x: number; y: number };
  toast: string | null;
  viewport: { x: number; y: number; zoom: number };
  pendingViewport: { x: number; y: number; zoom: number } | null;

  toggleLeft: () => void;
  setLeftWidth: (w: number) => void;
  toggleInspector: () => void;
  setInspectorOpen: (v: boolean) => void;
  openAddMenu: (x: number, y: number) => void;
  closeAddMenu: () => void;
  setLastMouse: (x: number, y: number) => void;
  setToast: (msg: string | null) => void;
  setViewport: (v: { x: number; y: number; zoom: number }) => void;
  setPendingViewport: (v: { x: number; y: number; zoom: number }) => void;
  applyPendingViewport: () => { x: number; y: number; zoom: number } | null;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiState>((set, get) => ({
  leftOpen: true,
  leftWidth: 268,
  inspectorOpen: false,
  addMenu: null,
  lastMouse: { x: 0, y: 0 },
  toast: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  pendingViewport: null,

  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  setLeftWidth: (w) => set({ leftWidth: Math.min(540, Math.max(180, w)) }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (v) => set({ inspectorOpen: v }),
  openAddMenu: (x, y) => set({ addMenu: { x, y } }),
  closeAddMenu: () => set({ addMenu: null }),
  setLastMouse: (x, y) => set({ lastMouse: { x, y } }),
  setToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    if (msg) toastTimer = setTimeout(() => set({ toast: null }), 3500);
  },
  setViewport: (v) => set({ viewport: v }),
  setPendingViewport: (v) => set({ pendingViewport: v }),
  applyPendingViewport: () => {
    const v = get().pendingViewport;
    if (v) set({ pendingViewport: null });
    return v;
  },
}));
