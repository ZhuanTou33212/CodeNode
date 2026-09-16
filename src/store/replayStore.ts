import { create } from 'zustand';

/** S8：统一事件流（`.codenode/events.jsonl`）的一行 —— 字段与 electron/eventBus.cjs 的归一化形状一致。 */
export type ReplayEvent = {
  v?: number;
  ts?: string;
  kind: string;
  runId?: string | null;
  turnId?: string | null;
  toolCallId?: string | null;
  attemptId?: string | null;
  [key: string]: unknown;
};

export type ReplaySummary = {
  total: number;
  runs: string[];
  span: { first: string | null; last: string | null };
  kinds: Record<string, number>;
  tools: Record<string, { calls: number; failures: number }>;
  toolCalls: number;
  toolFailures: number;
  failureCodes: Record<string, number>;
  approvals: { issued: number; denied: number; rejected: number; consumed: number };
  costUsd: number;
  tokens: number;
};

export type ReplayRun = { runId: string; count: number; first: string | null; last: string | null; kinds: string[] };

type ReplayState = {
  loading: boolean;
  error: string | null;
  file: string | null;
  total: number;
  runs: ReplayRun[];
  events: ReplayEvent[];
  summary: ReplaySummary | null;
  runId: string | null;
  kinds: string[] | null;
  limit: number;
  setRunId: (runId: string | null) => void;
  setKinds: (kinds: string[] | null) => void;
  load: (projectRoot: string | null, options?: { runId?: string | null; kinds?: string[] | null; limit?: number }) => Promise<void>;
};

export const useReplayStore = create<ReplayState>((set, get) => ({
  loading: false,
  error: null,
  file: null,
  total: 0,
  runs: [],
  events: [],
  summary: null,
  runId: null,
  kinds: null,
  limit: 200,
  setRunId: (runId) => set({ runId }),
  setKinds: (kinds) => set({ kinds }),
  load: async (projectRoot, options) => {
    const current = get();
    const runId = options?.runId !== undefined ? options.runId : current.runId;
    const kinds = options?.kinds !== undefined ? options.kinds : current.kinds;
    const limit = options?.limit ?? current.limit;
    if (!projectRoot || !window.codenode?.replayEvents) {
      set({ loading: false, error: '未选择项目', events: [], runs: [], summary: null, total: 0, file: null });
      return;
    }
    set({ loading: true, error: null, runId, kinds });
    try {
      const payload = await window.codenode.replayEvents(projectRoot, { runId, kinds, limit });
      if (!payload || payload.ok !== true) {
        set({ loading: false, error: payload?.error || '回放失败', events: [], runs: [], summary: null, total: 0, file: null });
        return;
      }
      set({
        loading: false,
        error: null,
        file: payload.file,
        total: payload.total,
        runs: payload.runs,
        events: payload.events,
        summary: payload.summary,
      });
    } catch (error) {
      set({
        loading: false,
        error: String((error as Error)?.message || error),
        events: [],
        runs: [],
        summary: null,
        total: 0,
        file: null,
      });
    }
  },
}));
