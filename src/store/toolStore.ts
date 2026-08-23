import { create } from 'zustand';

export type ConfirmRequest = {
  id: string;
  type: 'confirm';
  level: string;
  what: string;
  detail: string;
};

export type AskRequest = {
  id: string;
  type: 'ask';
  question: string;
  options: string[];
};

export type UiRequest = {
  id: string;
  type: 'ui';
  action: string;
  args: Record<string, unknown>;
};

export type ToolRequest = ConfirmRequest | AskRequest | UiRequest;

interface ToolState {
  current: ConfirmRequest | AskRequest | null;
  queue: (ConfirmRequest | AskRequest)[];
  push: (req: ToolRequest) => void;
  respond: (id: string, result: unknown) => void;
  clearCurrent: () => void;
}

export const useToolStore = create<ToolState>((set, get) => ({
  current: null,
  queue: [],

  push: (req) => {
    if (req.type === 'ui') return; // ui 请求由调用方直接处理
    set((s) => {
      if (!s.current) return { current: req, queue: s.queue };
      return { current: s.current, queue: [...s.queue, req] };
    });
  },

  respond: (id, result) => {
    const api = window.codenode;
    if (api && api.respondToolRequest) api.respondToolRequest(id, result);
    set((s) => {
      if (s.current && s.current.id === id) {
        const next = s.queue[0] || null;
        return { current: next, queue: s.queue.slice(1) };
      }
      return s;
    });
  },

  clearCurrent: () => set({ current: null, queue: [] }),
}));
