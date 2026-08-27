import { create } from 'zustand';
import { useGraphStore } from './graphStore';
import { useProjectStore } from './projectStore';
import { useUiStore } from './uiStore';
import type { RagGrounding, SessionCanvas, SessionDoc, SessionMsg, ToolRecord } from '../types';

const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function emptyDoc(): SessionDoc {
  return { root: { nodes: [], edges: [] } };
}

export interface ProgressState {
  edgeIds: string[];
  index: number;
  running: boolean;
}

interface SessionState {
  sessions: Record<string, SessionCanvas>;
  order: string[];
  activeId: string | null;
  streaming: boolean;
  messages: SessionMsg[];
  progress: ProgressState | null;

  current: () => SessionCanvas | null;
  /** 新建项目：创建画布1（对话根），并把灵魂问候写入全局对话 */
  initProject: (greeting?: string, soulPrompt?: string) => void;
  /** 每条用户指令开始时：把上一个画布标记完成，新建下一个空白画布并切换 */
  beginWorkSession: (prompt: string) => void;
  /** 用户手动新建空白画布 */
  newCanvas: () => void;
  /** 直接在当前画布上阅读并制作（不新建画布） */
  startOnCurrent: (prompt: string) => void;
  switchSession: (id: string) => void;
  syncActiveGraph: () => void;
  restoreSessions: (list: SessionCanvas[], messages?: SessionMsg[], activeId?: string | null) => void;

  getDocument: () => SessionDoc;
  pushUser: (content: string) => void;
  beginTurn: () => void;
  streamDelta: (d: {
    kind?: string;
    text?: string;
    toolCalls?: unknown;
    saved?: { filePath?: string };
    error?: string;
  }) => void;
  finishTurn: (reply: string, reasoning: string, tools: ToolRecord[], grounding?: RagGrounding) => void;
  failTurn: (error: string) => void;
  stopTurn: () => void;
  applyAgentDoc: (doc: SessionDoc) => void;
  /** 标记当前画布为 active（就地修改场景下保持当前画布为工作画布） */
  markActive: () => void;

  setProgressIndex: (i: number) => void;
  clearProgress: () => void;
  reset: () => void;
}

function snapshotGraph(): SessionDoc {
  const g = useGraphStore.getState().getDocument();
  return { root: g };
}

function loadGraph(doc: SessionDoc) {
  useGraphStore.getState().loadDocument(doc.root);
}

function countNodes(doc: SessionDoc): number {
  return doc.root.nodes.length;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  streaming: false,
  messages: [],
  progress: null,

  current: () => {
    const s = get();
    return s.activeId ? s.sessions[s.activeId] || null : null;
  },

  initProject: (greeting, soulPrompt) => {
    const id = uid('canvas');
    const first: SessionCanvas = {
      id,
      label: '画布1',
      prompt: soulPrompt || '',
      doc: emptyDoc(),
      status: 'active',
      createdAt: Date.now(),
      nodeCount: 0,
    };
    const messages: SessionMsg[] = greeting
      ? [{ role: 'assistant', content: greeting, status: 'done' }]
      : [];
    set({
      sessions: { [id]: first },
      order: [id],
      activeId: id,
      streaming: false,
      messages,
      progress: null,
    });
    loadGraph(emptyDoc());
  },

  beginWorkSession: (prompt) => {
    const s = get();
    let sessions = { ...s.sessions };
    const order = [...s.order];
    if (s.activeId) {
      const active = s.sessions[s.activeId];
      if (active) sessions[active.id] = { ...active, status: 'completed' };
    }
    const id = uid('canvas');
    const label = '画布' + (order.length + 1);
    const blank: SessionCanvas = {
      id,
      label,
      prompt: prompt || '',
      doc: emptyDoc(),
      status: 'active',
      createdAt: Date.now(),
      nodeCount: 0,
    };
    sessions = { ...sessions, [id]: blank };
    order.push(id);
    loadGraph(blank.doc);
    set({ sessions, order, activeId: id, streaming: false, progress: null });
  },

  switchSession: (id) => {
    const s = get();
    if (id === s.activeId || !s.sessions[id]) return;
    // 先把当前画布的最新状态（含自动排版后的节点位置）保存回会话，避免切换后位置丢失/重叠
    get().syncActiveGraph();
    const target = s.sessions[id];
    loadGraph(target.doc);
    set({ activeId: id, progress: null });
  },

  syncActiveGraph: () => {
    const active = get().current();
    if (!active) return;
    const doc = snapshotGraph();
    set((s) => ({
      sessions: { ...s.sessions, [active.id]: { ...active, doc, nodeCount: countNodes(doc) } },
    }));
  },

  restoreSessions: (list, messages, activeId) => {
    const sessions: Record<string, SessionCanvas> = {};
    const order: string[] = [];
    for (const s of list) {
      if (!s || !s.id) continue;
      sessions[s.id] = s;
      order.push(s.id);
    }
    let id = activeId && sessions[activeId] ? activeId : null;
    if (!id) {
      const active = order.map((x) => sessions[x]).find((x) => x.status === 'active');
      id = active ? active.id : null;
    }
    if (!id) {
      // 没有 active 会话：激活节点最多的画布（用户的工作内容）
      let best: string | null = null;
      let bestCount = -1;
      for (const oid of order) {
        const s = sessions[oid];
        const c = s ? s.nodeCount : 0;
        if (c > bestCount) {
          bestCount = c;
          best = oid;
        }
      }
      id = best || order[order.length - 1] || null;
    }
    if (!id) {
      set({ sessions, order, activeId: null, streaming: false, messages: messages || [], progress: null });
      return;
    }
    loadGraph(sessions[id].doc);
    set({ sessions, order, activeId: id, streaming: false, messages: messages || [], progress: null });
  },

  getDocument: () => snapshotGraph(),

  newCanvas: () => {
    get().beginWorkSession('');
  },

  startOnCurrent: (prompt) => {
    let active = get().current();
    if (!active) {
      if (get().order.length === 0) {
        // 尚无任何画布：创建画布1
        const id = uid('canvas');
        const first: SessionCanvas = {
          id,
          label: '画布1',
          prompt: prompt || '',
          doc: emptyDoc(),
          status: 'active',
          createdAt: Date.now(),
          nodeCount: 0,
        };
        set({ sessions: { [id]: first }, order: [id], activeId: id, streaming: false, progress: null });
        loadGraph(emptyDoc());
        return;
      }
      get().switchSession(get().order[0]);
      active = get().current();
    }
    if (!active) return;
    // 直接在当前画布上阅读并制作
    set((s) => ({
      sessions: {
        ...s.sessions,
        [active.id]: { ...active, prompt: active.prompt || prompt, status: 'active' },
      },
      streaming: false,
      progress: null,
    }));
  },

  pushUser: (content) => {
    set((s) => ({ messages: [...s.messages, { role: 'user', content }] }));
  },

  beginTurn: () => {
    set((s) => ({
      streaming: true,
      messages: [...s.messages, { role: 'assistant', content: '', status: 'running', tools: [] }],
    }));
  },

  streamDelta: (d) => {
    const s = get();
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (d.kind === 'reasoning' && d.text) last.reasoning = (last.reasoning || '') + d.text;
    else if (d.kind === 'content' && d.text) last.content += d.text;
    else if (d.kind === 'tool' && d.toolCalls) {
      const list = (d.toolCalls as { id?: string; name?: string; args?: unknown }[]).map((t) => ({
        id: t.id,
        name: t.name || 'tool',
        args: t.args,
      }));
      last.tools = mergeTools(last.tools || [], list);
    } else if (d.kind === 'tool_result' && d.toolCalls) {
      const list = (d.toolCalls as ToolRecord[]).map((t) => ({
        name: t.name,
        args: t.args,
        result: t.result,
        ok: t.ok,
        data: t.data,
      }));
      last.tools = mergeTools(last.tools || [], list);
    } else if (d.kind === 'saved' && d.saved && d.saved.filePath) {
      useProjectStore.getState().setProjectFile(d.saved.filePath);
      useUiStore.getState().setToast('Agent 已保存：' + d.saved.filePath);
    }
    set({ messages: msgs });
  },

  finishTurn: (reply, reasoning, tools, grounding) => {
    const s = get();
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
      last.content = reply || last.content;
      if (reasoning) last.reasoning = reasoning;
      if (tools && tools.length) last.tools = tools;
      last.status = 'done';
      if (grounding) last.grounding = grounding;
    }
    // 当前画布标记完成并记录摘要
    let sessions = { ...s.sessions };
    const active = s.activeId ? s.sessions[s.activeId] : null;
    if (active) {
      sessions[active.id] = { ...active, status: 'completed', summary: reply || active.summary };
    }
    set({ messages: msgs, sessions, streaming: false });
  },

  failTurn: (error) => {
    const s = get();
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
      last.status = 'failed';
      last.content = '（调用失败：' + error + '）';
    }
    set({ messages: msgs, streaming: false });
  },

  stopTurn: () => {
    const s = get();
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
      last.status = 'stopped';
    }
    set({ messages: msgs, streaming: false });
  },

  applyAgentDoc: (doc) => {
    const active = get().current();
    if (!active) return;
    const clean = clone(doc);
    const oldIds = new Set(active.doc.root.nodes.map((n) => n.id));
    const newIds = clean.root.nodes.map((n) => n.id).filter((id) => !oldIds.has(id));
    const sessions = { ...get().sessions };
    sessions[active.id] = {
      ...active,
      doc: clean,
      nodeCount: countNodes(clean),
    };
    loadGraph(clean);
    const edgeIds = clean.root.edges.map((e) => e.id).filter(Boolean);
    const next = edgeIds.length ? { edgeIds, index: 0, running: true } : null;
    set({ sessions, progress: next });
    // 有新节点：等 React Flow 渲染测量后，按连通分量分块自动整理（而非全部排成一排），
    // 并把排版结果持久化回会话
    if (newIds.length > 0) {
      const targetId = get().activeId;
      const doLayout = () => {
        // 用户已切走画布：不再对错误画布排版
        if (get().activeId !== targetId) return;
        const g = useGraphStore.getState();
        g.arrangeNodes();
        g.commit();
        useSessionStore.getState().syncActiveGraph();
      };
      setTimeout(doLayout, 260);
      setTimeout(doLayout, 900);
    }
  },

  markActive: () => {
    const active = get().current();
    if (!active) return;
    set((s) => ({
      sessions: { ...s.sessions, [active.id]: { ...active, status: 'active' } },
    }));
  },

  setProgressIndex: (i) => {
    const p = get().progress;
    if (!p) return;
    if (i >= p.edgeIds.length) {
      set({ progress: null });
      return;
    }
    set({ progress: { ...p, index: i } });
  },

  clearProgress: () => set({ progress: null }),

  reset: () => set({ sessions: {}, order: [], activeId: null, streaming: false, messages: [], progress: null }),
}));

/** 合并工具记录：流式增量按 id 去重（同一调用多次 chunk 只算一条）；最终结果按 name+args 回填到未定结果条目，保留每次真实调度 */
function mergeTools(current: ToolRecord[], incoming: ToolRecord[]): ToolRecord[] {
  const next = current.map((t) => ({ ...t }));
  for (const t of incoming) {
    if (t.id) {
      const idx = next.findIndex((x) => x.id === t.id);
      if (idx >= 0) next[idx] = { ...next[idx], ...t };
      else next.push(t);
      continue;
    }
    const key = (x: ToolRecord) => x.name + '|' + JSON.stringify(x.args || '');
    const idx = next.findIndex((x) => key(x) === key(t) && x.ok === undefined);
    if (idx >= 0) next[idx] = { ...next[idx], ...t };
    else next.push(t);
  }
  return next;
}
