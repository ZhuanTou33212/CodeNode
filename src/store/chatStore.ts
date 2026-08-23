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

function canvasSummary(): string {
  const s = useGraphStore.getState();
  const items = s.nodes.map((n) => {
    const d = n.data as { label?: string; status?: string; goal?: string; prompt?: string; filePath?: string };
    return {
      id: n.id,
      type: n.type,
      label: d.label || '',
      status: d.status || '',
      goal: d.goal || '',
      prompt: d.prompt || '',
      file: d.filePath || '',
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
    // 始终在当前画布上阅读并制作（不自动新建画布，保证 Agent 能读到已有内容）
    ss.startOnCurrent(text);
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
        canvasSummary: canvasSummary(),
        nodeId: null,
        requestId,
        document: useGraphStore.getState().getDocument(),
        projectFile: useProjectStore.getState().projectFile || undefined,
      });

      // Agent 改图：应用到当前（新的）输出画布
      if (res.document) {
        const doc = res.document as {
          root?: { nodes?: unknown[]; edges?: unknown[] };
          groups?: Record<string, unknown>;
          viewStack?: unknown[];
        };
        if (doc && doc.root) {
          useSessionStore.getState().applyAgentDoc({
            root: (doc.root as never) || { nodes: [], edges: [] },
            groups: ((doc.groups || {}) as never) || {},
            viewStack: (doc.viewStack || []) as never[],
          });
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
