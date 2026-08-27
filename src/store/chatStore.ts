import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import { useGraphStore } from './graphStore';
import { useUiStore } from './uiStore';
import { useSessionStore } from './sessionStore';
import { useUsageStore, type UsageSnapshot } from './usageStore';
import type { ToolRecord } from '../types';

interface ChatState {
  sending: boolean;
  requestId: string | null;
  send: (prompt: string) => Promise<{ reply: string; reasoning: string; tools: ToolRecord[] }>;
  stop: () => void;
}

/** 把 DeepSeek usage 归一化为本应用结构 */
function normalizeUsage(u: unknown): UsageSnapshot | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, number>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const prompt = num(o.prompt_tokens);
  const hit = num(o.prompt_cache_hit_tokens);
  return {
    promptTokens: prompt,
    completionTokens: num(o.completion_tokens),
    totalTokens: num(o.total_tokens) || prompt + num(o.completion_tokens),
    promptCacheHit: hit,
    promptCacheMiss: num(o.prompt_cache_miss_tokens) || Math.max(0, prompt - hit),
  };
}

/** 从文档生成画布节点摘要（作为 Agent 读取上下文，写入系统提示） */
function summarizeDoc(doc: { nodes?: unknown[] } | null | undefined): string {
  const nodes = (doc && doc.nodes) || [];
  const items = (nodes as { id?: string; type?: string; data?: Record<string, unknown> }[]).map((n) => {
    const d = n.data || {};
    return {
      id: n.id,
      type: n.type,
      label: d.label || '',
      status: d.status || '',
      goal: d.goal || '',
      prompt: d.prompt || '',
    };
  });
  return JSON.stringify(items);
}

export const useChatStore = create<ChatState>((set, get) => ({
  sending: false,
  requestId: null,

  stop: () => {
    const api = window.codenode;
    const rid = get().requestId;
    if (api && api.stopAgent && rid) {
      void api.stopAgent(rid);
    }
  },

  send: async (prompt) => {
    const empty = { reply: '', reasoning: '', tools: [] };
    const api = window.codenode;
    if (!api) {
      useUiStore.getState().setToast('需要 Electron 环境');
      return empty;
    }
    const text = prompt.trim();
    if (!text) return empty;

    const ss = useSessionStore.getState();
    // 指令前已有的对话（作为历史传给 Agent）
    const prior = ss.messages.map((m) => ({ role: m.role, content: m.content }));
    // 当前画布内容：作为 Agent 的「读取上下文」，保证它能读到已有节点
    const ctx = useGraphStore.getState().getDocument();
    // 确保有当前画布（无会话时创建画布1）
    if (!ss.current()) {
      ss.startOnCurrent(text);
    }
    ss.pushUser(text);
    ss.beginTurn();

    const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const unsub = api.onAgentDelta
      ? api.onAgentDelta((d) => {
          if (d.requestId === requestId) useSessionStore.getState().streamDelta(d);
        })
      : null;

    const us = useUsageStore.getState();
    set({ sending: true, requestId });
    try {
      const res = await api.agentChat({
        projectRoot: useProjectStore.getState().root,
        prompt: text,
        history: prior,
        canvasSummary: summarizeDoc(ctx),
        nodeId: null,
        requestId,
        modelId: us.modelId || undefined,
        reasoningEffort: us.effort,
        document: { root: ctx },
        projectFile: useProjectStore.getState().projectFile || undefined,
      });
      const usage = normalizeUsage(res.usage);
      if (usage) useUsageStore.getState().recordUsage(usage);

      if (res.aborted) {
        useSessionStore.getState().stopTurn();
        return empty;
      }

      // Agent 改图完成：画布是独立系统。
      // 若 Agent 只是对当前画布做修改（保留了画布中已有节点）→ 就地应用到当前画布，不新开画布；
      // 否则（当前画布为空 / Agent 输出了与现有画布完全无关的全新内容）→ 新开一个画布承载新内容。
      if (res.document) {
        const doc = res.document as {
          root?: { nodes?: { id?: string; type?: string }[]; edges?: { source?: string; target?: string }[] };
        };
        if (doc && doc.root) {
          const rawNodes = (doc.root.nodes || []) as { id?: string; type?: string }[];
          const rawEdges = (doc.root.edges || []) as { source?: string; target?: string }[];
          const current = useGraphStore.getState();
          const currentIds = new Set(current.nodes.map((n) => n.id));
          // 会话开始时画布存在的 id：用于识别 Agent 运行期间被用户删除的节点（不让它复活）
          const ctxIds = new Set((ctx.nodes || []).map((n) => n.id));
          const deletedDuringRun = [...ctxIds].filter((id) => !currentIds.has(id));
          const cleanNodes = rawNodes.filter(
            (n) =>
              n &&
              n.id &&
              !deletedDuringRun.includes(n.id) &&
              n.type !== 'group' &&
              n.type !== 'group-input' &&
              n.type !== 'group-output'
          );
          const kept = cleanNodes.filter((n) => n.id != null && currentIds.has(n.id));
          const isModification = current.nodes.length > 0 && kept.length > 0;
          const keepIds = new Set(cleanNodes.map((n) => n.id));
          const cleanEdges = rawEdges.filter((e) => keepIds.has(e.source || '') && keepIds.has(e.target || ''));
          const clean = { root: { nodes: cleanNodes, edges: cleanEdges } };
          if (isModification) {
            // 就地修改当前画布：画布内容 = Agent 在当前画布基础上的完整结果
            useSessionStore.getState().applyAgentDoc(clean as never);
          } else {
            // 全新内容：标记当前画布完成并新开一个画布承载输出
            useSessionStore.getState().syncActiveGraph();
            useSessionStore.getState().beginWorkSession(text);
            useSessionStore.getState().applyAgentDoc(clean as never);
          }
        }
      }

      let tools: ToolRecord[] = [];
      if (res.ok && res.reply != null) {
        const rawTools = (res.toolCalls as ToolRecord[] | null) || null;
        tools = (rawTools || []).map((t) => ({ name: t.name || 'tool', args: t.args, result: t.result, ok: t.ok, data: t.data }));
        useSessionStore.getState().finishTurn(res.reply, res.reasoning || '', tools, res.grounding);
        // 画布是独立工作系统：turn 结束后当前画布始终是工作画布，保持 active（不被标记为 completed）
        useSessionStore.getState().markActive();
      } else {
        useSessionStore.getState().failTurn(res.error || '未知错误');
        useUiStore.getState().setToast('Agent 调用失败：' + (res.error || '未知错误'));
        return empty;
      }

      return { reply: res.reply, reasoning: res.reasoning || '', tools };
    } catch (e) {
      useSessionStore.getState().failTurn(String(e));
      useUiStore.getState().setToast('Agent 调用异常：' + String(e));
      return empty;
    } finally {
      if (unsub) unsub();
      set({ sending: false, requestId: null });
    }
  },
}));
