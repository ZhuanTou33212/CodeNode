/** 矢量设计工作室 —— 全局状态（zustand），与 Agent 工作台 store 完全隔离 */
import { create } from 'zustand';
import type {
  Anchor,
  DraftPoint,
  LogicOp,
  ProjectFile,
  Snapshot,
  VecGroup,
  VecMode,
  VecObject,
  VecShapeKind,
  VecTool,
} from './types';
import {
  buildDemoProject,
  buildPreset,
  clone,
  SHAPE_TITLES,
  uid,
  validateProject,
} from './model';

const STORAGE_KEY = 'codenode.vector.project.v2';
const HISTORY_LIMIT = 60;

type Point = { x: number; y: number };

export interface VectorState {
  ready: boolean;
  mode: VecMode;
  tool: VecTool;
  objects: VecObject[];
  groups: VecGroup[];
  selectedIds: string[];
  activeAnchor: { id: string; index: number } | null;
  editingId: string | null;
  zoom: number;
  pan: Point;
  dark: boolean;
  gridOn: boolean;
  guidesOn: boolean;
  snapOn: boolean;
  guides: { v: number[]; h: number[] };
  logicIds: string[];
  logicOp: LogicOp;
  penPts: DraftPoint[] | null;
  toast: string | null;
  status: string;
  past: Snapshot[];
  future: Snapshot[];
  clipLen: number;
  /** 右栏当前页（图像模式） */
  tab: 'properties' | 'layers';
  /** 画布指针世界坐标（状态栏/标尺实时显示） */
  pointer: Point | null;
  // 内部
  _busy: boolean;
  _dirty: boolean;
  _clip: VecObject[];
  _toastTimer: ReturnType<typeof setTimeout> | null;

  // —— 生命周期 / 项目 ——
  init: () => void;
  saveProject: () => void;
  exportJson: () => string;
  importJson: (text: string) => boolean;
  resetDemo: () => void;
  clearAll: () => void;
  notify: (msg: string, status?: string) => void;

  // —— 视图与偏好 ——
  setMode: (m: VecMode) => void;
  setTool: (t: VecTool) => void;
  setViewport: (zoom: number, pan: Point) => void;
  setDark: (v: boolean) => void;
  toggleGrid: () => void;
  toggleGuides: () => void;
  toggleSnap: () => void;
  addGuide: (axis: 'v' | 'h', pos: number) => void;
  removeGuide: (axis: 'v' | 'h', pos: number) => void;
  moveGuide: (axis: 'v' | 'h', from: number, to: number) => void;

  // —— 历史 ——
  canUndo: () => boolean;
  canRedo: () => boolean;
  beginGesture: () => void;
  endGesture: (msg?: string) => void;
  applyLive: (next: VecObject[]) => void;
  commitObjects: (next: VecObject[], msg?: string) => void;
  undo: () => void;
  redo: () => void;

  // —— 选择 / 编辑状态 ——
  selectOne: (id: string, opts?: { additive?: boolean; shift?: boolean }) => void;
  selectIds: (ids: string[]) => void;
  clearSelection: () => void;
  selectAll: () => void;
  setActiveAnchor: (a: { id: string; index: number } | null) => void;
  setEditing: (id: string | null) => void;

  // —— 对象操作 ——
  addFromPreset: (kind: VecShapeKind, at: Point, size?: { w: number; h: number }) => string;
  updateSelection: (patch: Partial<VecObject>, msg?: string) => void;
  updateOne: (id: string, patch: Partial<VecObject>, msg?: string) => void;
  rotateSelected: (delta: number) => void;
  nudgeSelection: (dx: number, dy: number) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  copySelection: (cut?: boolean) => void;
  pasteClipboard: () => void;
  reorderObjects: (orderIds: string[], msg: string) => void;
  groupSelected: (name?: string) => void;
  ungroupSelected: () => void;
  toggleVisible: (ids: string[]) => void;
  toggleLocked: (ids: string[]) => void;
  renameLayer: (id: string, name: string) => void;
  setGroupExpanded: (gid: string, collapsed: boolean) => void;

  // —— 钢笔绘制 ——
  penBegin: (p: Point) => void;
  penAddPoint: (p: Point) => void;
  penUpdateLast: (p: Point, handle: boolean) => void;
  penFinish: (closed: boolean) => void;
  penCancel: () => void;

  // —— 逻辑分析 ——
  toggleLogicId: (id: string) => void;
  setLogicOp: (op: LogicOp) => void;
  // —— 右栏 / 指针 ——
  setTab: (t: 'properties' | 'layers') => void;
  setPointer: (p: Point | null) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function snapshotOf(state: Pick<VectorState, 'objects' | 'groups' | 'selectedIds'>): Snapshot {
  return {
    objects: clone(state.objects),
    groups: clone(state.groups),
    selectedIds: [...state.selectedIds],
  };
}

function applySnapshot(set: (p: Partial<VectorState>) => void, snap: Snapshot) {
  set({
    objects: snap.objects,
    groups: snap.groups,
    selectedIds: snap.selectedIds,
    activeAnchor: null,
    editingId: null,
  });
}

function primaryId(state: Pick<VectorState, 'selectedIds'>): string | null {
  return state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : null;
}

export const useVectorStore = create<VectorState>((set, get) => {
  const pushHistory = () => {
    const s = get();
    const snap = snapshotOf(s);
    const past = [...s.past.slice(-(HISTORY_LIMIT - 1)), snap];
    set({ past, future: [], _busy: false, _dirty: false });
  };
  const persist = () => {
    const s = get();
    const file: ProjectFile = {
      kind: 'codenode-vector-project',
      version: 2,
      objects: s.objects,
      groups: s.groups,
      zoom: s.zoom,
      pan: s.pan,
      mode: s.mode,
      dark: s.dark,
      gridOn: s.gridOn,
      guidesOn: s.guidesOn,
      snapOn: s.snapOn,
      guides: s.guides,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    } catch {
      /* 存储不可用时静默 */
    }
  };
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 500);
  };

  const loadFromStorage = (): ProjectFile | null => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return validateProject(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const applyProject = (file: ProjectFile, setState: (p: Partial<VectorState>) => void) => {
    setState({
      objects: file.objects,
      groups: file.groups,
      zoom: file.zoom,
      pan: file.pan,
      mode: file.mode,
      dark: file.dark,
      gridOn: file.gridOn,
      guidesOn: file.guidesOn,
      snapOn: file.snapOn,
      guides: file.guides,
      selectedIds: [],
      activeAnchor: null,
      editingId: null,
      past: [],
      future: [],
      penPts: null,
      _busy: false,
      _dirty: false,
      ready: true,
    });
  };

  return {
    ready: false,
    mode: 'design',
    tool: 'select',
    objects: [],
    groups: [],
    selectedIds: [],
    activeAnchor: null,
    editingId: null,
    zoom: 0.9,
    pan: { x: 0, y: 0 },
    dark: true,
    gridOn: true,
    guidesOn: true,
    snapOn: true,
    guides: { v: [], h: [] },
    logicIds: [],
    logicOp: 'intersection',
    penPts: null,
    toast: null,
    status: '就绪 · 图像模式',
    past: [],
    future: [],
    clipLen: 0,
    tab: 'properties',
    pointer: null,
    _busy: false,
    _dirty: false,
    _clip: [],
    _toastTimer: null,

    init: () => {
      if (get().ready) return;
      const file = loadFromStorage();
      if (file) {
        applyProject(file, set);
        set({ status: `已恢复上次项目（${new Date(file.savedAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` });
        return;
      }
      const demo = buildDemoProject();
      set({
        objects: demo.objects,
        groups: demo.groups,
        zoom: demo.zoom,
        pan: demo.pan,
        guides: demo.guides,
        logicIds: demo.objects.slice(0, 3).map((o) => o.id),
        ready: true,
      });
      persist();
    },

    saveProject: () => {
      persist();
      get().notify('项目已保存', '已保存 · 刚刚');
    },

    exportJson: () => {
      const s = get();
      return JSON.stringify(
        {
          kind: 'codenode-vector-project',
          version: 2,
          objects: s.objects,
          groups: s.groups,
          guides: s.guides,
          savedAt: Date.now(),
        } as ProjectFile,
        null,
        2
      );
    },

    importJson: (text) => {
      try {
        const file = validateProject(JSON.parse(text));
        if (!file) return false;
        file.zoom = 0.9;
        file.pan = { x: 0, y: 0 };
        applyProject(file, set);
        get().notify('项目已导入', '已导入项目');
        persist();
        return true;
      } catch {
        return false;
      }
    },

    resetDemo: () => {
      const demo = buildDemoProject();
      set({
        objects: demo.objects,
        groups: demo.groups,
        zoom: demo.zoom,
        pan: demo.pan,
        guides: demo.guides,
        logicIds: demo.objects.slice(0, 3).map((o) => o.id),
        selectedIds: [],
        past: [],
        future: [],
        status: '已载入示例工程',
      });
      get().notify('已载入示例工程');
      persist();
    },

    clearAll: () => {
      set({
        objects: [],
        groups: [],
        selectedIds: [],
        logicIds: [],
        past: [],
        future: [],
        penPts: null,
        activeAnchor: null,
        status: '已新建空白画布',
      });
      get().notify('已新建空白画布');
      persist();
    },

    notify: (msg, status) => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: msg, ...(status ? { status } : {}) });
      toastTimer = setTimeout(() => set({ toast: null }), 2400);
    },

    setMode: (m) => {
      const s = get();
      set({
        mode: m,
        tool: 'select',
        penPts: null,
        status: m === 'logic' ? '就绪 · 逻辑分析模式' : '就绪 · 图像模式',
      });
      if (m === 'logic' && s.logicIds.length === 0) {
        const ids = s.objects.filter((o) => ['bezier', 'rectangle', 'rounded', 'ellipse'].includes(o.type)).slice(0, 3).map((o) => o.id);
        set({ logicIds: ids });
      }
      persist();
    },

    setTool: (t) => {
      const s = get();
      set({
        tool: t,
        penPts: t === 'pen' ? s.penPts : null,
        editingId: null,
        activeAnchor: t === 'select' ? s.activeAnchor : null,
      });
    },

    setViewport: (zoom, pan) => set({ zoom, pan }),

    setDark: (v) => {
      set({ dark: v });
      persist();
    },
    toggleGrid: () => {
      set((s) => ({ gridOn: !s.gridOn }));
      persist();
    },
    toggleGuides: () => {
      set((s) => ({ guidesOn: !s.guidesOn }));
      persist();
    },
    toggleSnap: () => {
      set((s) => ({ snapOn: !s.snapOn }));
      persist();
    },
    addGuide: (axis, pos) => {
      set((s) => ({
        guides: {
          v: axis === 'v' ? [...s.guides.v.filter((g) => Math.abs(g - pos) > 4), pos] : s.guides.v,
          h: axis === 'h' ? [...s.guides.h.filter((g) => Math.abs(g - pos) > 4), pos] : s.guides.h,
        },
      }));
      persist();
    },
    removeGuide: (axis, pos) => {
      set((s) => ({
        guides: {
          v: axis === 'v' ? s.guides.v.filter((g) => Math.abs(g - pos) > 2) : s.guides.v,
          h: axis === 'h' ? s.guides.h.filter((g) => Math.abs(g - pos) > 2) : s.guides.h,
        },
      }));
      persist();
    },
    moveGuide: (axis, from, to) => {
      set((s) => ({
        guides: {
          v: axis === 'v' ? s.guides.v.map((g) => (Math.abs(g - from) < 3 ? to : g)) : s.guides.v,
          h: axis === 'h' ? s.guides.h.map((g) => (Math.abs(g - from) < 3 ? to : g)) : s.guides.h,
        },
      }));
      persist();
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    beginGesture: () => {
      const s = get();
      if (s._busy) return;
      const snap = snapshotOf(s);
      set({ past: [...s.past.slice(-(HISTORY_LIMIT - 1)), snap], future: [], _busy: true, _dirty: false });
    },

    endGesture: (msg) => {
      const s = get();
      if (!s._busy) return;
      if (!s._dirty) {
        // 纯点击无变化：丢弃 begin 时压入的空白历史条目
        set({ past: s.past.slice(0, -1), _busy: false, _dirty: false });
        return;
      }
      set({ _busy: false, _dirty: false });
      if (msg) get().notify(msg);
      schedulePersist();
    },

    applyLive: (next) => {
      set({ objects: next, _dirty: true });
    },

    commitObjects: (next, msg) => {
      const s = get();
      if (!s._busy) pushHistory();
      set({ objects: next, _busy: false, _dirty: false });
      if (msg) get().notify(msg);
      schedulePersist();
    },

    undo: () => {
      const s = get();
      if (s.past.length === 0) return;
      const past = [...s.past];
      const snap = past.pop()!;
      const cur = snapshotOf(s);
      set({ future: [...s.future, cur], past, _busy: false, _dirty: false });
      applySnapshot(set, snap);
      schedulePersist();
    },

    redo: () => {
      const s = get();
      if (s.future.length === 0) return;
      const future = [...s.future];
      const snap = future.pop()!;
      const cur = snapshotOf(s);
      set({ past: [...s.past, cur], future, _busy: false, _dirty: false });
      applySnapshot(set, snap);
      schedulePersist();
    },

    selectOne: (id, opts) => {
      const s = get();
      const { additive = false, shift = false } = opts || {};
      if (additive || shift) {
        const has = s.selectedIds.includes(id);
        set({ selectedIds: has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] });
      } else {
        set({ selectedIds: [id] });
      }
      set({ editingId: null });
    },

    selectIds: (ids) => set({ selectedIds: [...ids] }),
    clearSelection: () => set({ selectedIds: [], activeAnchor: null }),
    selectAll: () => {
      const s = get();
      set({ selectedIds: s.objects.filter((o) => o.visible && !o.locked).map((o) => o.id) });
    },
    setActiveAnchor: (a) => set({ activeAnchor: a }),
    setEditing: (id) => set({ editingId: id, selectedIds: id ? [id] : get().selectedIds }),

    addFromPreset: (kind, at, size) => {
      const s = get();
      const obj = buildPreset(kind, `${SHAPE_TITLES[kind]} ${s.objects.filter((o) => o.type === kind).length + 1}`);
      obj.x = Math.round(at.x - (size ? size.w : obj.width) / 2);
      obj.y = Math.round(at.y - (size ? size.h : obj.height) / 2);
      if (size) {
        obj.width = Math.max(24, size.w);
        obj.height = Math.max(24, size.h);
        if (kind === 'bezier' && obj.anchors) {
          const sx = obj.width / 260;
          const sy = obj.height / 200;
          obj.anchors = obj.anchors.map((a) => ({
            ...a,
            x: Math.round(a.x * sx),
            y: Math.round(a.y * sy),
            hIn: a.hIn ? { x: Math.round(a.hIn.x * sx), y: Math.round(a.hIn.y * sy) } : undefined,
            hOut: a.hOut ? { x: Math.round(a.hOut.x * sx), y: Math.round(a.hOut.y * sy) } : undefined,
          }));
        }
      }
      pushHistory();
      set({
        objects: [...s.objects, obj],
        selectedIds: [obj.id],
        activeAnchor: null,
        _busy: false,
        _dirty: false,
      });
      get().notify(`已创建${SHAPE_TITLES[kind]}`);
      schedulePersist();
      return obj.id;
    },

    updateSelection: (patch, msg) => {
      const s = get();
      if (!s.selectedIds.length) return;
      const lockable = ['x', 'y', 'width', 'height', 'rotation', 'anchors', 'closed'].includes(
        Object.keys(patch)[0]
      );
      const next = s.objects.map((o) =>
        s.selectedIds.includes(o.id) && (!lockable || !o.locked)
          ? { ...o, ...clone(patch) }
          : o
      );
      get().commitObjects(next, msg);
    },

    updateOne: (id, patch, msg) => {
      const s = get();
      const next = s.objects.map((o) => (o.id === id ? { ...o, ...clone(patch) } : o));
      get().commitObjects(next, msg);
    },

    rotateSelected: (delta) => {
      const s = get();
      const next = s.objects.map((o) =>
        s.selectedIds.includes(o.id) && !o.locked ? { ...o, rotation: Math.round((o.rotation + delta) * 10) / 10 } : o
      );
      get().commitObjects(next, delta > 0 ? `已旋转 ${delta}°` : `已旋转 ${delta}°`);
    },

    nudgeSelection: (dx, dy) => {
      const s = get();
      if (!s.selectedIds.length) return;
      const next = s.objects.map((o) =>
        s.selectedIds.includes(o.id) && !o.locked ? { ...o, x: o.x + dx, y: o.y + dy } : o
      );
      pushHistory();
      set({ objects: next, _busy: false, _dirty: false });
      schedulePersist();
    },

    deleteSelected: () => {
      const s = get();
      if (!s.selectedIds.length) return;
      const ids = s.selectedIds;
      pushHistory();
      set({
        objects: s.objects.filter((o) => !ids.includes(o.id) || o.locked),
        groups: s.groups.map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => !ids.includes(m) || s.objects.find((o) => o.id === m)?.locked) })),
        selectedIds: [],
        activeAnchor: null,
        _busy: false,
        _dirty: false,
      });
      get().notify(`已删除 ${ids.length} 个图形`);
      schedulePersist();
    },

    duplicateSelected: () => {
      const s = get();
      const src = s.objects.filter((o) => s.selectedIds.includes(o.id));
      if (!src.length) return;
      const copies = src.map((o) => {
        const c = clone(o);
        c.id = uid(o.type);
        c.name = `${o.name} copy`;
        c.x += 26;
        c.y += 26;
        c.groupId = null;
        return c;
      });
      pushHistory();
      set({
        objects: [...s.objects, ...copies],
        selectedIds: copies.map((c) => c.id),
        _busy: false,
        _dirty: false,
      });
      get().notify(`已复制 ${copies.length} 个图形`);
      schedulePersist();
    },

    copySelection: (cut) => {
      const s = get();
      const src = s.objects.filter((o) => s.selectedIds.includes(o.id));
      if (!src.length) return;
      set({ _clip: clone(src), clipLen: src.length });
      if (cut) get().deleteSelected();
      else get().notify(`已复制 ${src.length} 个图形`);
    },

    pasteClipboard: () => {
      const s = get();
      const src = s._clip;
      if (!src.length) return;
      const copies = src.map((o) => {
        const c = clone(o);
        c.id = uid(o.type);
        c.name = `${o.name} copy`;
        c.x += 34;
        c.y += 34;
        c.groupId = null;
        return c;
      });
      pushHistory();
      set({
        objects: [...s.objects, ...copies],
        selectedIds: copies.map((c) => c.id),
        _busy: false,
        _dirty: false,
      });
      get().notify(`已粘贴 ${copies.length} 个图形`);
      schedulePersist();
    },

    reorderObjects: (orderIds, msg) => {
      const s = get();
      if (orderIds.length !== s.objects.length) return;
      const map = new Map(s.objects.map((o) => [o.id, o]));
      const next = orderIds.map((id) => map.get(id)).filter((o): o is VecObject => Boolean(o));
      // 同步组：memberIds 与对象顺序保持一致（保证渲染与 z 序不脱节）
      const groups = s.groups.map((g) => ({
        ...g,
        memberIds: next.filter((o) => o.groupId === g.id).map((o) => o.id),
      }));
      if (!s._busy) pushHistory();
      set({ objects: next, groups, _busy: false, _dirty: false });
      if (msg) get().notify(msg);
      schedulePersist();
    },

    groupSelected: (name) => {
      const s = get();
      if (s.selectedIds.length < 2) return;
      const members = s.objects.filter((o) => s.selectedIds.includes(o.id) && !o.locked);
      if (members.length < 2) return;
      // 保证组内成员 z 序连续（把成员抽出并按原顺序插回最低成员所在位置）
      const gid = `group-${uid('g')}`;
      const memberIds = members.map((m) => m.id);
      const keep = s.objects.filter((o) => !memberIds.includes(o.id));
      const minIndex = Math.min(...s.objects.map((o, i) => (memberIds.includes(o.id) ? i : Infinity)));
      const block = members.map((m) => ({ ...m, groupId: gid }));
      keep.splice(minIndex, 0, ...block);
      const groups = [
        ...s.groups,
        { id: gid, name: name || `图层组 ${s.groups.length + 1}`, memberIds, visible: true, locked: false },
      ];
      pushHistory();
      set({ objects: keep, groups, selectedIds: memberIds, _busy: false, _dirty: false });
      get().notify(`已分组 ${members.length} 个图形`);
      schedulePersist();
    },

    ungroupSelected: () => {
      const s = get();
      const affected = new Set<string>();
      s.groups.forEach((g) => {
        if (g.memberIds.some((m) => s.selectedIds.includes(m))) {
          g.memberIds.forEach((m) => affected.add(m));
        }
      });
      if (!affected.size) return;
      const next = s.objects.map((o) => (affected.has(o.id) ? { ...o, groupId: null } : o));
      pushHistory();
      set({
        objects: next,
        groups: s.groups.filter((g) => !g.memberIds.some((m) => affected.has(m))),
        selectedIds: [...affected],
        _busy: false,
        _dirty: false,
      });
      get().notify(`已取消分组（${affected.size} 个图形）`);
      schedulePersist();
    },

    toggleVisible: (ids) => {
      const s = get();
      const byId = new Set(ids);
      const groupMembers = new Set<string>();
      s.groups.forEach((g) => {
        if (byId.has(g.id)) g.memberIds.forEach((m) => groupMembers.add(m));
      });
      const target = new Set([...ids.filter((id) => s.objects.some((o) => o.id === id)), ...groupMembers]);
      const visibleMap = new Map(s.objects.filter((o) => target.has(o.id)).map((o) => [o.id, o.visible]));
      const anyVisible = [...target].some((id) => visibleMap.get(id));
      const nextVisible = !anyVisible;
      const next = s.objects.map((o) => (target.has(o.id) ? { ...o, visible: nextVisible } : o));
      const groups = s.groups.map((g) => (byId.has(g.id) ? { ...g, visible: nextVisible } : g));
      const selectedIds = nextVisible
        ? s.selectedIds
        : s.selectedIds.filter((id) => !target.has(id));
      pushHistory();
      set({ objects: next, groups, selectedIds, _busy: false, _dirty: false });
      schedulePersist();
    },

    toggleLocked: (ids) => {
      const s = get();
      const byId = new Set(ids);
      const groupMembers = new Set<string>();
      s.groups.forEach((g) => {
        if (byId.has(g.id)) g.memberIds.forEach((m) => groupMembers.add(m));
      });
      const target = [...groupMembers, ...ids.filter((id) => s.objects.some((o) => o.id === id))];
      const anyUnlocked = target.some((id) => s.objects.find((o) => o.id === id)?.locked);
      const nextLocked = !anyUnlocked;
      const next = s.objects.map((o) => (target.includes(o.id) ? { ...o, locked: nextLocked } : o));
      const groups = s.groups.map((g) => (byId.has(g.id) ? { ...g, locked: nextLocked } : g));
      pushHistory();
      set({ objects: next, groups, _busy: false, _dirty: false });
      get().notify(nextLocked ? '已锁定图层' : '已解锁图层');
      schedulePersist();
    },

    renameLayer: (id, name) => {
      const s = get();
      const isGroup = s.groups.some((g) => g.id === id);
      if (isGroup) {
        set({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) });
      } else {
        set({ objects: s.objects.map((o) => (o.id === id ? { ...o, name } : o)) });
      }
    },

    setGroupExpanded: (gid, collapsed) => {
      const s = get();
      set({ groups: s.groups.map((g) => (g.id === gid ? { ...g, collapsed } : g)) });
    },

    penBegin: (p) => set({ penPts: [{ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }], tool: 'pen' }),
    penAddPoint: (p) => {
      const s = get();
      const pts = s.penPts || [];
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 3) return;
      set({ penPts: [...pts, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }] });
    },
    penUpdateLast: (p, handle) => {
      const s = get();
      const pts = s.penPts;
      if (!pts || !pts.length) return;
      const next = [...pts];
      const last = { ...next[next.length - 1] };
      if (handle && next.length >= 2) {
        last.h = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
      } else {
        last.x = Math.round(p.x * 10) / 10;
        last.y = Math.round(p.y * 10) / 10;
        delete last.h;
      }
      next[next.length - 1] = last;
      set({ penPts: next });
    },
    penFinish: (closed) => {
      const s = get();
      const pts = s.penPts || [];
      if (pts.length < 2) {
        set({ penPts: null });
        return;
      }
      if (closed && pts.length < 3) {
        get().notify('闭合路径至少需要 3 个锚点');
        return;
      }
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const obj = buildPreset('bezier', `贝塞尔图形 ${s.objects.filter((o) => o.type === 'bezier').length + 1}`);
      obj.x = Math.round(minX);
      obj.y = Math.round(minY);
      obj.width = Math.max(40, Math.round(maxX - minX));
      obj.height = Math.max(40, Math.round(maxY - minY));
      obj.closed = closed;
      obj.anchors = pts.map((p, i) => {
        const a: Anchor = {
          x: Math.round(p.x - minX),
          y: Math.round(p.y - minY),
          smooth: false,
        };
        const hp = p.h;
        // 出柄用于“从该点到下一点”的段：开放路径的末点没有下一段 → 丢弃
        const hasNext = closed || i < pts.length - 1;
        if (hp && hasNext) {
          a.smooth = true;
          a.hOut = {
            x: Math.round(hp.x - minX),
            y: Math.round(hp.y - minY),
          };
          // 自动补入柄：指向上一锚点、长度与出柄一致（仅闭合时对首段成立）
          const prev = pts[i - 1] || (closed ? pts[pts.length - 1] : null);
          if (prev) {
            const dx = a.x - Math.round(prev.x - minX);
            const dy = a.y - Math.round(prev.y - minY);
            const len = Math.hypot(dx, dy) || 1;
            const outLen = Math.hypot(a.hOut.x - a.x, a.hOut.y - a.y);
            a.hIn = {
              x: Math.round(a.x + (dx / len) * outLen),
              y: Math.round(a.y + (dy / len) * outLen),
            };
          }
        }
        return a;
      });
      pushHistory();
      set({
        objects: [...s.objects, obj],
        selectedIds: [obj.id],
        penPts: null,
        tool: 'select',
        activeAnchor: null,
        _busy: false,
        _dirty: false,
      });
      get().notify(closed ? '已创建闭合贝塞尔图形' : '已创建开放路径');
      schedulePersist();
    },
    penCancel: () => set({ penPts: null, tool: 'select' }),

    toggleLogicId: (id) => {
      const s = get();
      set({
        logicIds: s.logicIds.includes(id)
          ? s.logicIds.filter((x) => x !== id)
          : [...s.logicIds, id],
      });
    },
    setLogicOp: (op) => set({ logicOp: op }),

    setTab: (t) => set({ tab: t }),
    setPointer: (p) => set({ pointer: p }),
  };
});
