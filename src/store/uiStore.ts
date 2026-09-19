import { create } from 'zustand';
import { formatResumePlanNotice, type ResumePlanLike } from '../lib/resumePlan';

/** 左侧侧栏的标签页：Agent 对话 / 节点属性 / 项目树 / 文件预览 */
export type SideTab = 'agent' | 'node' | 'project' | 'preview';

/** 侧栏宽度边界：下限保证输入控件可用，上限避免把画布挤没 */
export const SIDE_WIDTH_MIN = 260;
export const SIDE_WIDTH_MAX = 520;
export const SIDE_WIDTH_DEFAULT = 300;

interface UiState {
  /** 右侧侧栏（原「检查器」+ 原左侧「项目管理」合并后的唯一面板） */
  sideOpen: boolean;
  sideTab: SideTab;
  sideWidth: number;
  addMenu: { x: number; y: number } | null;
  lastMouse: { x: number; y: number };
  toast: string | null;
  viewport: { x: number; y: number; zoom: number };
  pendingViewport: { x: number; y: number; zoom: number } | null;
  modelManagerOpen: boolean;
  hoverScopeId: string | null;
  dockOpen: boolean;
  dockTab: 'editor' | 'diff' | 'terminal' | 'runs' | 'checkpoints' | 'extensions';
  /** 启动引导是否完成（恢复上次工程结束）。false 时先显示启动占位，避免门禁页闪现 */
  booted: boolean;
  /**
   * 需要人工复核的续跑计划（#21）：后端回传的 `plan` 不再被丢掉，在这里留存，
   * 由 AgentPanel 的确认条与 RunsPanel 一起消费 —— 「要求用户复核」必须同时告诉他复核什么。
   */
  resumePlanNotice: { plan: ResumePlanLike; prompt?: string; at: number } | null;

  toggleSide: () => void;
  setSideOpen: (v: boolean) => void;
  setSideTab: (tab: SideTab) => void;
  setSideWidth: (w: number) => void;
  setHoverScopeId: (id: string | null) => void;
  openAddMenu: (x: number, y: number) => void;
  closeAddMenu: () => void;
  setLastMouse: (x: number, y: number) => void;
  setToast: (msg: string | null) => void;
  setViewport: (v: { x: number; y: number; zoom: number }) => void;
  setPendingViewport: (v: { x: number; y: number; zoom: number }) => void;
  applyPendingViewport: () => { x: number; y: number; zoom: number } | null;
  openModelManager: () => void;
  closeModelManager: () => void;
  openDock: (tab?: UiState['dockTab']) => void;
  closeDock: () => void;
  setDockTab: (tab: UiState['dockTab']) => void;
  setBooted: (v: boolean) => void;
  /** 记录「需要人工复核」的续跑计划（同时给 toast/aria-live 一句含工具名的人话提示） */
  setResumePlanNotice: (plan: ResumePlanLike | null, prompt?: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiState>((set, get) => ({
  sideOpen: false,
  sideTab: 'agent',
  sideWidth: SIDE_WIDTH_DEFAULT,
  addMenu: null,
  lastMouse: { x: 0, y: 0 },
  toast: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  pendingViewport: null,
  modelManagerOpen: false,
  hoverScopeId: null,
  dockOpen: false,
  dockTab: 'editor',
  booted: false,
  resumePlanNotice: null,

  toggleSide: () => set((s) => ({ sideOpen: !s.sideOpen })),
  setSideOpen: (v) => set({ sideOpen: v }),
  setSideTab: (tab) => set({ sideOpen: true, sideTab: tab }),
  setSideWidth: (w) => set({ sideWidth: Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, Math.round(w))) }),  setHoverScopeId: (id) => set({ hoverScopeId: id }),
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
  openModelManager: () => set({ modelManagerOpen: true }),
  closeModelManager: () => set({ modelManagerOpen: false }),
  openDock: (tab) => set({ dockOpen: true, ...(tab ? { dockTab: tab } : {}) }),
  closeDock: () => set({ dockOpen: false }),
  setDockTab: (tab) => set({ dockOpen: true, dockTab: tab }),
  setBooted: (v) => set({ booted: v }),
  setResumePlanNotice: (plan, prompt) => {
    if (!plan) {
      set({ resumePlanNotice: null });
      return;
    }
    // `plan` 原样留存 —— 界面要显示 reason / warning / unknownEffects / pendingSteps（#21）
    const notice = { plan, prompt, at: Date.now() };
    set({ resumePlanNotice: notice });
    // 提示里必须带未知副作用的**工具名**，否则「需要人工复核」这句话没有任何可执行信息
    useUiStore.getState().setToast(formatResumePlanNotice(notice.plan));
  },
}));
