import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import { useGraphStore } from './graphStore';
import { useUiStore } from './uiStore';
import { useSessionStore } from './sessionStore';
import { useUsageStore, type UsageSnapshot } from './usageStore';
import type { AgentAttachment, ToolRecord } from '../types';

interface ChatState {
  sending: boolean;
  requestId: string | null;
  send: (
    prompt: string,
    options?: { resumeRunId?: string; resumeForce?: boolean; attachments?: AgentAttachment[] }
  ) => Promise<{ reply: string; reasoning: string; tools: ToolRecord[] }>;
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

  send: async (prompt, options) => {
    const empty = { reply: '', reasoning: '', tools: [] };
    const api = window.codenode;
    if (!api) {
      useUiStore.getState().setToast('需要 Electron 环境');
      return empty;
    }
    const text = prompt.trim();
    const attachments = options?.attachments ?? [];
    // 允许「只有图片、没有文字」的消息
    if (!text && !attachments.length) return empty;

    const ss = useSessionStore.getState();
    // 指令前已有的对话（作为历史传给 Agent）
    const prior = ss.messages.map((m) => ({ role: m.role, content: m.content }));
    // 当前画布内容：作为 Agent 的「读取上下文」，保证它能读到已有节点
    const ctx = useGraphStore.getState().getDocument();
    // 确保有当前画布（无会话时创建画布1）
    if (!ss.current()) {
      ss.startOnCurrent(text);
    }
    ss.pushUser(text, attachments);
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
        attachments: attachments.length ? attachments : undefined,
        history: prior,
        canvasSummary: summarizeDoc(ctx),
        nodeId: null,
        requestId,
        modelId: us.modelId || undefined,
        reasoningEffort: us.effort,
        document: { root: ctx },
        projectFile: useProjectStore.getState().projectFile || undefined,
        // 断点续跑：带上原始 Run 与「是否已人工复核」；主进程按续跑计划决定走 auto 还是 review
        resumeRunId: options?.resumeRunId,
        resumeForce: options?.resumeForce === true ? true : undefined,
      });
      // 需要人工复核的续跑：主进程拒绝自动执行，这里如实提示，不假装跑过
      if (!res.ok && (res as { needsReview?: boolean }).needsReview) {
        useUiStore.getState().setToast('该运行存在结果未知的副作用，需要人工复核后才能继续');
        useSessionStore.getState().stopTurn();
        return empty;
      }
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
        // 交付形态如实告知：被长度上限截断的回答不是完整答案，别让用户以为写完了
        if (res.stopReason === 'length_truncated') {
          useUiStore.getState().setToast('回答触到模型长度上限被截断，可回复「继续」让它接着写完');
        }
      } else if (res.limitReached && res.reply) {
        // 达到迭代/工具调用上限（第 2 项）：不是「调用失败」，而是「没跑完但有事可交付」——
        // 结构化收尾（已完成/失败/涉及文件/怎么续跑）必须让用户看见，不能只弹一个报错把结果丢掉。
        const rawTools = (res.toolCalls as ToolRecord[] | null) || null;
        tools = (rawTools || []).map((t) => ({ name: t.name || 'tool', args: t.args, result: t.result, ok: t.ok, data: t.data }));
        useSessionStore.getState().finishTurn(res.reply, res.reasoning || '', tools, res.grounding);
        useSessionStore.getState().markActive();
        useUiStore.getState().setToast('本次运行达到步数上限（任务未完成）：已列出阶段性结果，可在「工作流运行」里续跑');
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
