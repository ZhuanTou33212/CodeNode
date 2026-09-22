import { create } from 'zustand';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** 模型接入配置（与 electron modelStore.cjs 中 models.json 的结构一致） */
export interface ModelSpec {
  id: string;
  label: string;
  model: string;
  apiBase?: string;
  apiKey?: string;
  apiKeySet?: boolean;
  contextWindow: number;
  priceInput: number;
  priceInputHit: number;
  priceOutput: number;
  supportsEffort: boolean;
  /** 是否支持图片输入（多模态）。只有为 true 时才允许给该模型附加图片 */
  vision?: boolean;
  enabled?: boolean;
  /** 协议（S13）：openai（默认，兼容绝大多数厂商）| anthropic（Claude 原生）| gemini（Gemini 原生） */
  protocol?: string;
  /** 认证头：auto（按协议取默认）| bearer | x-api-key | api-key | x-goog-api-key | none */
  auth?: string;
  /** 端点风格：standard（默认）| azure（部署名路径 + api-version） */
  endpoint?: string;
  apiVersion?: string;
  azureDeployment?: string;
  /** 输出上限字段名：max_tokens（默认）| max_completion_tokens（OpenAI o 系 / GPT-5） */
  maxTokensField?: string;
  provider?: string;
  providerLabel?: string;
}

/** 该模型是不是 DeepSeek（高峰价只对 DeepSeek 成立；别的厂商按同时段 ×2 会把账算错） */
function isDeepSeekModel(model: { provider?: string; apiBase?: string; model?: string }): boolean {
  if (!model) return false;
  if (String(model.provider || '').toLowerCase().includes('deepseek')) return true;
  return /deepseek/i.test(String(model.apiBase || '') + ' ' + String(model.model || ''));
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
  // 高峰价是 DeepSeek 的定价规则：非 DeepSeek 模型一律按原价（S13 起支持多厂商，这条必须限定范围）
  const peak = isDeepSeekModel(model) && isPeakHours();
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
