import { create } from 'zustand';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** 模型接入配置（与 electron modelStore.cjs 中 models.json 的结构一致） */
export interface ModelSpec {
  id: string;
  label: string;
  model: string;
  apiBase?: string;
  apiKey?: string;
  contextWindow: number;
  priceInput: number;
  priceInputHit: number;
  priceOutput: number;
  supportsEffort: boolean;
  enabled?: boolean;
}

/** 是否为 DeepSeek 高峰时段（01:00–04:00、06:00–10:00 UTC，周一至周五），高峰价 = 非高峰价 × 2 */
function isPeakHours(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** 根据当前时段返回实际价格（$ / 1M tokens）；models.json 中记录的是非高峰价 */
export function modelPrice(model: ModelSpec): { priceInput: number; priceInputHit: number; priceOutput: number } {
  const peak = isPeakHours();
  return {
    priceInput: peak ? model.priceInput * 2 : model.priceInput,
    priceInputHit: peak ? model.priceInputHit * 2 : model.priceInputHit,
    priceOutput: peak ? model.priceOutput * 2 : model.priceOutput,
  };
}

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHit: number;
  promptCacheMiss: number;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

interface UsageState {
  models: ModelSpec[];
  modelId: string | null;
  effort: ReasoningEffort;
  budget: number;
  summary: UsageSummary;
  lastUsage: UsageSnapshot | null;
  loadModels: () => Promise<void>;
  setModel: (id: string) => void;
  setEffort: (e: ReasoningEffort) => void;
  setBudget: (n: number) => void;
  recordUsage: (u: UsageSnapshot) => void;
  resetUsage: () => void;
}

const KEY = 'codenode.usagePrefs';

function loadPrefs(): { modelId: string | null; effort: ReasoningEffort; budget: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const budget = Number(p.budget);
      return {
        modelId: typeof p.modelId === 'string' ? p.modelId : null,
        effort: p.effort === 'low' || p.effort === 'high' ? p.effort : 'medium',
        budget: Number.isFinite(budget) && budget > 0 ? budget : 5,
      };
    }
  } catch {}
  return { modelId: null, effort: 'medium', budget: 5 };
}

function savePrefs(modelId: string | null, effort: ReasoningEffort, budget: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ modelId, effort, budget }));
  } catch {}
}

export function usageCost(model: ModelSpec, u: UsageSnapshot): number {
  const p = modelPrice(model);
  return (
    (u.promptCacheMiss / 1e6) * p.priceInput +
    (u.promptCacheHit / 1e6) * p.priceInputHit +
    (u.completionTokens / 1e6) * p.priceOutput
  );
}

export const useUsageStore = create<UsageState>((set, get) => {
  const prefs = loadPrefs();
  return {
    models: [],
    modelId: prefs.modelId,
    effort: prefs.effort,
    budget: prefs.budget,
    summary: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    lastUsage: null,

    loadModels: async () => {
      const api = window.codenode;
      if (!api || !api.modelsList) return;
      try {
        const res = await api.modelsList();
        const list = (res.models || []).filter((m) => m && m.id);
        if (!list.length) return;
        const stored = get().modelId;
        const active = res.activeId && list.some((m) => m.id === res.activeId) ? res.activeId : list[0].id;
        // 优先保留用户上次选择；不存在则用主进程激活的模型
        const next = stored && list.some((m) => m.id === stored) ? stored : active;
        set({ models: list, modelId: next });
        savePrefs(next, get().effort, get().budget);
      } catch {}
    },

    setModel: (id) => {
      set({ modelId: id });
      savePrefs(id, get().effort, get().budget);
      const api = window.codenode;
      if (api && api.modelsActive) void api.modelsActive(id);
    },
    setEffort: (effort) => {
      set({ effort });
      savePrefs(get().modelId, effort, get().budget);
    },
    setBudget: (budget) => {
      const n = Number.isFinite(budget) && budget > 0 ? budget : 5;
      set({ budget: n });
      savePrefs(get().modelId, get().effort, n);
    },
    recordUsage: (u) => {
      if (!u) return;
      const model = get().models.find((m) => m.id === get().modelId) || get().models[0];
      if (!model) return;
      const cost = usageCost(model, u);
      set((s) => ({
        lastUsage: u,
        summary: {
          promptTokens: s.summary.promptTokens + u.promptTokens,
          completionTokens: s.summary.completionTokens + u.completionTokens,
          totalTokens: s.summary.totalTokens + u.totalTokens,
          cost: s.summary.cost + cost,
        },
      }));
    },
    resetUsage: () =>
      set({ summary: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }, lastUsage: null }),
  };
});
