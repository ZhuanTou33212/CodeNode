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
          root?: { nodes?: { id?: string }[]; edges?: { source?: string; target?: string }[] };
          groups?: Record<string, { nodes?: { id?: string }[]; edges?: { source?: string; target?: string }[] }>;
          viewStack?: unknown[];
        };
        if (doc && doc.root) {
          const clean: {
            root: { nodes?: { id?: string }[]; edges?: { source?: string; target?: string }[] };
            groups: Record<string, { nodes?: { id?: string }[]; edges?: { source?: string; target?: string }[] }>;
            viewStack: unknown[];
          } = {
            root: doc.root || { nodes: [], edges: [] },
            groups: doc.groups || {},
            viewStack: doc.viewStack || [],
          };
          // 新画布只保留本次 Agent 新建的节点：忽略上个画布带入的旧节点，避免节点被复制到下一个画布
          const oldIds = new Set<string>();
          for (const n of (ctx.root?.nodes || []) as { id?: string }[]) {
            if (n && n.id) oldIds.add(n.id);
          }
          for (const g of Object.values(ctx.groups || {})) {
            const sub = g as { nodes?: { id?: string }[] };
            for (const n of sub.nodes || []) if (n && n.id) oldIds.add(n.id);
          }
          const newNodes = (clean.root.nodes || []).filter((n) => n && n.id && !oldIds.has(n.id));
          const keepIds = new Set(newNodes.map((n) => n.id));
          if (newNodes.length === 0) {
            clean.root.nodes = [];
            clean.root.edges = [];
          } else {
            clean.root.nodes = newNodes;
            clean.root.edges = (clean.root.edges || []).filter(
              (e) => keepIds.has(e.source || '') && keepIds.has(e.target || '')
            );
          }
          const cleanGroups: Record<string, { nodes: { id?: string }[]; edges: { source?: string; target?: string }[] }> = {};
          for (const gid of Object.keys(clean.groups || {})) {
            if (!keepIds.has(gid)) continue;
            const sub = clean.groups[gid];
            const subNodes = (sub?.nodes || []).filter((n) => n && n.id && !oldIds.has(n.id));
            const subKeep = new Set(subNodes.map((n) => n.id));
            cleanGroups[gid] = {
              nodes: subNodes,
              edges: (sub?.edges || []).filter((e) => subKeep.has(e.source || '') && subKeep.has(e.target || '')),
            };
          }
          clean.groups = cleanGroups;
          clean.viewStack = [];
          useSessionStore.getState().syncActiveGraph();
          useSessionStore.getState().beginWorkSession(text);
          useSessionStore.getState().applyAgentDoc(clean as never);
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
