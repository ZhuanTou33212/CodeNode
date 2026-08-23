import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import { useGraphStore } from './graphStore';
import { useUiStore } from './uiStore';
import { useSessionStore } from './sessionStore';
import type { ToolRecord } from '../types';

interface ChatState {
  sending: boolean;
  send: (prompt: string) => Promise<{ reply: string; reasoning: string; tools: ToolRecord[] }>;
}

/** 从文档生成画布节点摘要（作为 Agent 读取上下文，写入系统提示） */
function summarizeDoc(doc: { root?: { nodes?: unknown[] } } | null | undefined): string {
  const nodes = (doc && doc.root && doc.root.nodes) || [];
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

    set({ sending: true });
    try {
      const res = await api.agentChat({
        projectRoot: useProjectStore.getState().root,
        prompt: text,
        history: prior,
        canvasSummary: summarizeDoc(ctx),
        nodeId: null,
        requestId,
        document: ctx,
        projectFile: useProjectStore.getState().projectFile || undefined,
      });

      // Agent 改图完成：新建下一个画布作为本次输出画布，并把结果应用上去
      if (res.document) {
        const doc = res.document as {
          root?: { nodes?: unknown[]; edges?: unknown[] };
          groups?: Record<string, unknown>;
          viewStack?: unknown[];
        };
        if (doc && doc.root) {
          const clean = {
            root: (doc.root as never) || { nodes: [], edges: [] },
            groups: ((doc.groups || {}) as never) || {},
            viewStack: (doc.viewStack || []) as never[],
          };
          useSessionStore.getState().syncActiveGraph();
          useSessionStore.getState().beginWorkSession(text);
          useSessionStore.getState().applyAgentDoc(clean);
        }
      }

      let tools: ToolRecord[] = [];
      if (res.ok && res.reply != null) {
        const rawTools = (res.toolCalls as ToolRecord[] | null) || null;
        tools = (rawTools || []).map((t) => ({ name: t.name || 'tool', args: t.args, result: t.result, ok: t.ok, data: t.data }));
        useSessionStore.getState().finishTurn(res.reply, res.reasoning || '', tools);
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
      set({ sending: false });
    }
  },
}));
