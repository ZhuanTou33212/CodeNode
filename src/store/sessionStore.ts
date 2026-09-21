import { create } from 'zustand';
import { useGraphStore } from './graphStore';
import { useProjectStore } from './projectStore';
import { useUiStore } from './uiStore';
import { applyStreamDelta, warnUnknownDelta } from '../lib/sessionDelta';
import type { RagGrounding, SessionCanvas, SessionDoc, SessionMsg, ToolRecord } from '../types';

const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function emptyDoc(): SessionDoc {
  return { root: { nodes: [], edges: [] } };
}

/** 计划卡里的一步（与主进程 electron/plan.cjs 的 PLAN_STATUSES 同口径） */
export interface PlanItem {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 意图识别的一轮判定（主进程 electron/intent.cjs；两个维度照 Codex guardian 分类器）。
 *
 * 界面只显示主进程给的判定，不本地推算；`source` 要一起留着 —— 用户得能区分
 * 「模型真判了」与「这次没有信号（没跑 / 超时 / 关闭）」，后者不该显示成任何结论。
 */
export interface IntentVerdict {
  intent: string;
  risk: string;
  authorization: string;
  confidence: number;
  source: string;
  tighten: boolean;
  /** 判定依据摘要（主进程给的，界面只做 tooltip，不解析） */
  reason?: string;
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
  pushUser: (content: string, attachments?: SessionMsg['attachments']) => void;
  beginTurn: () => void;
  streamDelta: (d: {
    kind?: string;
    text?: string;
    toolCalls?: unknown;
    saved?: { filePath?: string };
    error?: string;
    /** kind==='intent'：意图识别的轮级判定（主进程 electron/intent.cjs 的 createIntentPolicy 结果） */
    intent?: string;
    risk?: string;
    authorization?: string;
    confidence?: number;
    source?: string;
    routeHint?: string | null;
    tighten?: boolean;
    /** kind==='compacted'：压缩结果与给模型的信封 */
    ok?: boolean;
    envelope?: string;
    summary?: string;
    windowNumber?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    keptUserTurns?: number;
    reason?: string;
    /** kind==='context_overflow'：preflight | recovering；以及估算 token / 窗口 */
    phase?: string;
    tokens?: number;
    reserve?: number;
    window?: number;
    /** kind==='max_tokens_capped'：收缩前/后的输出上限 */
    from?: number;
    to?: number;
    /** kind==='subagent_merge'：确定性合并的指纹与统计（P5） */
    digest?: string;
    counts?: Record<string, number>;
    providerMessage?: string;
    /** kind==='plan'：任务清单（update_plan）的最新一份 */
    items?: { step?: string; status?: string }[];
    updatedAt?: string;
    runId?: string | null;
  }) => void;
  /**
   * 上下文压缩（照 Codex CLI）：把当前对话折叠成一张交接摘要卡 —— 旧消息标记 `compacted`
   * （不再发给模型），摘要卡（`compaction:true`）原文进历史。幂等：同一份摘要重复到达不叠卡。
   */
  compactHistory: (payload: { envelope: string; summary?: string; windowNumber?: number; tokensBefore?: number; tokensAfter?: number; keptUserTurns?: number }) => void;
  finishTurn: (reply: string, reasoning: string, tools: ToolRecord[], grounding?: RagGrounding) => void;
  failTurn: (error: string) => void;
  stopTurn: () => void;
  applyAgentDoc: (doc: SessionDoc) => void;
  /** 标记当前画布为 active（就地修改场景下保持当前画布为工作画布） */
  markActive: () => void;

  setProgressIndex: (i: number) => void;
  clearProgress: () => void;
  /**
   * 任务清单（`update_plan` 的计划卡）：由主进程的 `kind:'plan'` 增量更新。
   * 只认主进程给的「最新一份」，不做本地推算（本地推算会与模型看到的计划漂移）。
   */
  plan: PlanItem[] | null;
  planUpdatedAt: string | null;
  planRunId: string | null;
  /**
   * 意图识别的最近一次判定（`kind:'intent'` 增量）：run 级状态，写独立字段。
   * `null` = 这次 run 没有判定（功能关闭 / 未触发 / 分类失败），界面据此**不显示任何结论**。
   */
  intentVerdict: IntentVerdict | null;
  intentUpdatedAt: string | null;
  intentRunId: string | null;
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
  plan: null,
  planUpdatedAt: null,
  planRunId: null,
  intentVerdict: null,
  intentUpdatedAt: null,
  intentRunId: null,

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

  pushUser: (content, attachments) => {
    set((s) => ({
      messages: [...s.messages, { role: 'user', content, ...(attachments && attachments.length ? { attachments } : {}) }],
    }));
  },

  beginTurn: () => {
    set((s) => ({
      streaming: true,
      messages: [...s.messages, { role: 'assistant', content: '', status: 'running', tools: [] }],
    }));
  },

  streamDelta: (d) => {
    const s = get();
    /**
     * 计划卡：写**独立字段**而不是塞进某条消息 —— 计划是 run 级状态，
     * 塞进气泡会在压缩/续跑时跟着消息一起被折叠或错位。
     * 未知状态按 pending 处理（界面上不出现空白步骤）。
     */
    if (d.kind === 'plan') {
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20).map((i) => ({
        step: String((i && i.step) || '').slice(0, 300),
        status: (['pending', 'in_progress', 'completed'].includes(String((i && i.status) || ''))
          ? String(i && i.status)
          : 'pending') as PlanItem['status'],
      }));
      set({ plan: items, planUpdatedAt: d.updatedAt ? String(d.updatedAt) : null, planRunId: d.runId ? String(d.runId) : null });
      return;
    }
    /**
     * 意图识别：与计划卡同款处理 —— 写独立字段（run 级状态），不塞进气泡。
     * 只认主进程给的判定，`source` 一起留着：界面要能区分「模型真判了」（model/partial/invalid）
     * 与「这次没有信号」（unavailable —— 没跑 / 超时 / 关闭），后者不显示任何结论。
     */
    if (d.kind === 'intent') {
      set({
        intentVerdict: {
          intent: String(d.intent || 'unknown'),
          risk: String(d.risk || 'unknown'),
          authorization: String(d.authorization || 'unknown'),
          confidence: Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : 0,
          source: String(d.source || 'unavailable'),
          tighten: d.tighten === true,
          reason: d.reason ? String(d.reason).slice(0, 200) : '',
        },
        intentUpdatedAt: new Date().toISOString(),
        intentRunId: d.runId ? String(d.runId) : null,
      });
      return;
    }
    // 上下文压缩（照 Codex）：把已有消息折叠掉、换成一张交接摘要卡。必须在「最后一条是 assistant」
    // 的守卫之前处理 —— 压缩发生在模型轮次之间，那时气泡状态不该影响它。
    if (d.kind === 'compacted' && d.ok !== false) {
      get().compactHistory({
        envelope: String(d.envelope || ''),
        summary: d.summary,
        windowNumber: d.windowNumber,
        tokensBefore: d.tokensBefore,
        tokensAfter: d.tokensAfter,
        keptUserTurns: d.keptUserTurns,
      });
      useUiStore.getState().setToast('上下文已压缩（' + (d.windowNumber ? '第 ' + d.windowNumber + ' 次 · ' : '') + (d.tokensBefore || 0) + ' → ' + (d.tokensAfter || 0) + ' tokens）');
      return;
    }
    if (d.kind === 'compacted' && d.ok === false) {
      useUiStore.getState().setToast('上下文压缩失败：' + (d.reason || '未知原因') + '（已改用硬裁剪兜底）');
      return;
    }
    // 超窗自救：供应商真报了超窗 → 立刻压缩重发。必须让用户看到「为什么这一轮慢了一拍」。
    if (d.kind === 'context_overflow') {
      useUiStore
        .getState()
        .setToast(
          d.phase === 'recovering'
            ? '上下文超窗：正在压缩后重试（估算 ' + (d.tokens || 0) + ' tokens，已将本模型窗口下调为 ' + (d.window || 0) + '）'
            : '上下文超窗：本轮未发送（估算 ' + (d.tokens || 0) + ' tokens > 窗口 ' + (d.window || 0) + '）'
        );
      return;
    }
    /**
     * 子代理结果的确定性合并（P5）：一致/被覆盖时无需打扰用户，但**待裁决的冲突必须让人看到** ——
     * 「不猜」是设计原则，用户得有机会来判。
     */
    if (d.kind === 'subagent_merge') {
      const conflicts = Number((d.counts && d.counts.conflicts) || 0);
      const superseded = Number((d.counts && d.counts.superseded) || 0);
      if (conflicts > 0) {
        useUiStore
          .getState()
          .setToast('子代理结果有 ' + conflicts + ' 处冲突待裁决（同一资源被不同内容改动，未擅自取舍）');
      } else if (superseded > 0) {
        useUiStore.getState().setToast('子代理结果已合并：' + superseded + ' 处被后写的覆盖（两份都留痕）');
      }
      return;
    }
    // 输出预算被上下文挤压：本轮输出上限临时缩小（如实告知，别让用户以为模型变笨了）
    if (d.kind === 'max_tokens_capped') {
      useUiStore.getState().setToast('上下文偏满：本轮输出上限临时从 ' + (d.from || 0) + ' 降为 ' + (d.to || 0));
      return;
    }
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant') return;
    // 「已保存」是副作用提示，不改气泡内容；未知 kind 兜底时不吞掉它
    if (d.kind === 'saved') {
      if (d.saved && d.saved.filePath) {
        useProjectStore.getState().setProjectFile(d.saved.filePath);
        useUiStore.getState().setToast('Agent 已保存：' + d.saved.filePath);
      }
      return;
    }
    // 气泡的 kind → 状态判断收在 `src/lib/sessionDelta.ts` 的纯函数里：那里认识 truncated / stopped，
    // 也对**未知 kind 显式兜底告警**（修复前这两类增量在这里没有任何分支，被静默丢弃；
    // 而且下次后端再加 kind 还会同样静默漂移）。
    const outcome = applyStreamDelta(last, d);
    if (!outcome.recognized) {
      warnUnknownDelta(d.kind);
      return;
    }
    if (!outcome.changed) return;
    if (outcome.appendText) {
      if (d.kind === 'reasoning') last.reasoning = (last.reasoning || '') + outcome.appendText;
      else last.content = (last.content || '') + outcome.appendText;
    }
    if (outcome.resetContent) {
      // 流中途断线 → 主进程整轮重发：已流出的半截内容作废，否则重发的完整回答
      // 会接在半截后面，用户看到两遍开头。
      last.content = '';
      last.reasoning = '';
      last.tools = [];
    }
    if (outcome.toolCalls) {
      const list = (outcome.toolCalls as { id?: string; name?: string; args?: unknown }[]).map((t) => ({
        id: t.id,
        name: t.name || 'tool',
        args: t.args,
      }));
      last.tools = mergeTools(last.tools || [], list);
    }
    if (outcome.toolResult) {
      const list = (outcome.toolResult as ToolRecord[]).map((t) => ({
        name: t.name,
        args: t.args,
        result: t.result,
        ok: t.ok,
        data: t.data,
      }));
      last.tools = mergeTools(last.tools || [], list);
    }
    if (outcome.status) {
      // truncated：「正在续写」不再是看不见的状态；stopped：点停止后气泡立刻变「已停止」，
      // 不再等 finally（那个窗口里界面看起来像没反应）。同时把 streaming 收掉，
      // 避免「已停止」的气泡旁边还挂着「思考中…」。
      last.status = outcome.status;
      if (outcome.status !== 'done') set({ messages: msgs, streaming: false });
      else set({ messages: msgs });
      return;
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

  compactHistory: ({ envelope, summary, windowNumber, tokensBefore, tokensAfter, keptUserTurns }) => {
    const text = String(envelope || '');
    if (!text) return;
    const s = get();
    // 幂等：同一份信封重复到达（续跑重放 / delta 与结果双路径）不叠第二张卡
    if (s.messages.some((m) => m.compaction && m.content === text)) return;
    const msgs: SessionMsg[] = s.messages.map((m) => ({ ...m, compacted: true }));
    msgs.push({
      role: 'system',
      content: text,
      status: 'done',
      compaction: true,
      compactionMeta: { windowNumber, tokensBefore, tokensAfter, keptUserTurns, summary },
    });
    set({ messages: msgs });
  },

  failTurn: (error) => {
    const s = get();
    const msgs = s.messages.map((m) => ({ ...m }));
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
      last.status = 'failed';
      // 已流出的半截内容**不能抹掉**：流式中断时那是用户唯一拿到的东西，
      // 直接替换成「（调用失败：…）」会让回答看起来凭空消失（这正是「聊一半断掉」的观感）。
      const partial = typeof last.content === 'string' ? last.content.trim() : '';
      last.content = partial ? partial + '\n\n---\n> ⚠️ 本轮中断：' + error : '（调用失败：' + error + '）';
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
    // 停止 → 流式立刻结束。修复前 `streaming` 与单值 `sending` 不同步，存在
    // 「UI 已显示空闲、旧请求尚未收尾」的窗口；现在 `sending` 是派生的 inflight 计数，窗口消失。
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

  reset: () => set({ sessions: {}, order: [], activeId: null, streaming: false, messages: [], progress: null, plan: null, planUpdatedAt: null, planRunId: null, intentVerdict: null, intentUpdatedAt: null, intentRunId: null }),
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
