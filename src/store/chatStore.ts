import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import { useGraphStore } from './graphStore';
import { useUiStore } from './uiStore';

export interface ChatMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatState {
  messages: ChatMsg[];
  sending: boolean;
  push: (m: ChatMsg) => void;
  reset: () => void;
  send: (
    prompt: string,
    nodeId?: string | null,
    onDelta?: (d: { requestId?: string; kind?: string; text?: string; toolCalls?: unknown; error?: string }) => void
  ) => Promise<{ reply: string; reasoning: string; tools: { name: string; args?: unknown; result?: string }[] }>;
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
  messages: [],
  sending: false,

  push: (m) => set((s) => ({ messages: [...s.messages, m] })),

  reset: () => set({ messages: [] }),

  send: async (prompt, nodeId, onDelta) => {
    const empty = { reply: '', reasoning: '', tools: [] };
    const api = window.codenode;
    if (!api) {
      useUiStore.getState().setToast('需要 Electron 环境');
      return empty;
    }
    const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const unsub = api.onAgentDelta
      ? api.onAgentDelta((d) => {
          if (d.requestId === requestId) onDelta && onDelta(d);
        })
      : null;
    set({ sending: true });
    try {
      const res = await api.agentChat({
        projectRoot: useProjectStore.getState().root,
        prompt,
        history: get().messages,
        canvasSummary: canvasSummary(),
        nodeId: nodeId ?? null,
        requestId,
      });
      if (res.ok && res.reply) {
        const reply: string = res.reply;
        const reasoning = res.reasoning || '';
        const rawTools = (res.toolCalls as { id?: string; type?: string; function?: { name?: string; arguments?: string } }[] | null) || null;
        const tools = (rawTools || []).map((t) => ({
          name: t.function?.name || t.type || 'tool',
          args: t.function?.arguments,
        }));
        set((s) => ({
          messages: [
            ...s.messages,
            { role: 'user', content: prompt },
            { role: 'assistant', content: reply },
          ],
        }));
        return { reply, reasoning, tools };
      }
      useUiStore.getState().setToast('Agent 调用失败：' + (res.error || '未知错误'));
      return empty;
    } catch (e) {
      useUiStore.getState().setToast('Agent 调用异常：' + String(e));
      return empty;
    } finally {
      if (unsub) unsub();
      set({ sending: false });
    }
  },
}));
