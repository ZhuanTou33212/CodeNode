/**
 * providerPresets.cjs —— 主流厂商接入预设（「粘贴一个 key 就能用」的那份清单）
 *
 * 为什么需要它：models.json 里只有 apiBase / apiKey / model 三个自由文本框时，用户得**自己知道**
 * 每家的地址、协议、认证头、模型 ID、上下文窗口。填错一个（例如把 Claude 的 key 配到 OpenAI 路径上）
 * 得到的是一句 400，与「key 无效」看起来一模一样 —— 排障成本全落在用户身上。
 *
 * 每条预设回答四个问题：**地址是什么 / 走什么协议 / 用什么认证头 / 有哪些模型**。
 *   protocol：openai（绝大多数厂商的兼容端点）| anthropic（Claude 原生）| gemini（Gemini 原生）
 *   auth    ：bearer | x-api-key | api-key | x-goog-api-key | none（本地免鉴权）
 *   endpoint：standard | azure（部署名路径 + api-version）
 *
 * 价格口径：$ / 1M tokens，**只写有把握的**（DeepSeek / OpenAI / Anthropic / Gemini 的公开价）。
 * 拿不准的一律 0 —— 0 在成本面板里显示为「未计入」，比编一个假数字诚实（用户可手填覆盖）。
 * 人民币计价的国内厂商一律留 0，避免把 ¥ 当成 $ 混进账本。
 */
'use strict';

/** @typedef {{ id: string, label?: string, contextWindow: number, priceInput?: number, priceInputHit?: number, priceOutput?: number, vision?: boolean, supportsEffort?: boolean, maxTokensField?: string }} PresetModel */

/**
 * @typedef {{
 *   id: string, label: string, region: 'cn'|'intl'|'local',
 *   protocol?: string, auth?: string, endpoint?: string, apiBase: string,
 *   keyHint?: string, docs?: string, note?: string, local?: boolean,
 *   apiVersion?: string, maxTokensField?: string, models: PresetModel[]
 * }} ProviderPreset
 */

/** @type {ProviderPreset[]} */
const PROVIDERS = [
  // ────────────────────────────── 国内 ──────────────────────────────
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    region: 'cn',
    apiBase: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    docs: 'https://platform.deepseek.com',
    models: [
      { id: 'deepseek-v4-flash', contextWindow: 1000000, priceInput: 0.22, priceInputHit: 0.007, priceOutput: 0.66, vision: true, supportsEffort: true },
      { id: 'deepseek-v4-pro', contextWindow: 1000000, priceInput: 0.66, priceInputHit: 0.022, priceOutput: 1.98, vision: false, supportsEffort: true },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi 月之暗面',
    region: 'cn',
    apiBase: 'https://api.moonshot.cn/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.moonshot.cn',
    models: [
      { id: 'kimi-k2-0905-preview', contextWindow: 262144, supportsEffort: false },
      { id: 'moonshot-v1-128k', contextWindow: 131072, supportsEffort: false },
    ],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    region: 'cn',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: 'sk-…',
    docs: 'https://help.aliyun.com/zh/model-studio',
    models: [
      { id: 'qwen3-max', contextWindow: 262144, supportsEffort: false },
      { id: 'qwen-plus', contextWindow: 131072, supportsEffort: false },
      { id: 'qwen-vl-max', contextWindow: 131072, vision: true, supportsEffort: false },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    region: 'cn',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: '…（智谱开放平台的 API Key）',
    docs: 'https://open.bigmodel.cn',
    models: [
      { id: 'glm-4.6', contextWindow: 200000, vision: true, supportsEffort: false },
      { id: 'glm-4.5-air', contextWindow: 128000, supportsEffort: false },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax 稀宇',
    region: 'cn',
    apiBase: 'https://api.minimaxi.com/v1',
    keyHint: '…（MiniMax 开放平台密钥）',
    docs: 'https://platform.minimaxi.com',
    models: [
      { id: 'MiniMax-M2', contextWindow: 200000, supportsEffort: false },
      { id: 'MiniMax-Text-01', contextWindow: 1000000, supportsEffort: false },
    ],
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包',
    region: 'cn',
    apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    keyHint: '…（方舟 API Key，模型 ID 填「接入点」或模型名）',
    docs: 'https://www.volcengine.com/docs/82379',
    models: [
      { id: 'doubao-seed-1-6-250615', contextWindow: 262144, vision: true, supportsEffort: false },
      { id: 'doubao-seed-1-6-thinking-250715', contextWindow: 262144, vision: true, supportsEffort: false },
    ],
  },
  {
    id: 'qianfan',
    label: '百度千帆 / 文心',
    region: 'cn',
    apiBase: 'https://qianfan.baidubce.com/v2',
    keyHint: 'bce-v3/…',
    docs: 'https://cloud.baidu.com/doc/qianfan',
    models: [
      { id: 'ernie-4.5-turbo-128k', contextWindow: 131072, supportsEffort: false },
      { id: 'ernie-4.5-8k-preview', contextWindow: 8192, supportsEffort: false },
    ],
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    region: 'cn',
    apiBase: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyHint: 'sk-…',
    docs: 'https://cloud.tencent.com/document/product/1729',
    models: [
      { id: 'hunyuan-turbos-latest', contextWindow: 32768, supportsEffort: false },
      { id: 'hunyuan-t1-latest', contextWindow: 65536, supportsEffort: false },
    ],
  },
  {
    id: 'spark',
    label: '讯飞星火',
    region: 'cn',
    apiBase: 'https://spark-api-open.xf-yun.com/v1',
    keyHint: '…:…（APIKey:APISecret 形式的 http 密钥）',
    docs: 'https://www.xfyun.cn/doc/spark',
    models: [
      { id: '4.0Ultra', contextWindow: 131072, supportsEffort: false },
      { id: 'generalv3.5', contextWindow: 8192, supportsEffort: false },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    region: 'cn',
    apiBase: 'https://api.siliconflow.cn/v1',
    keyHint: 'sk-…',
    docs: 'https://cloud.siliconflow.cn',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 131072, supportsEffort: false },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', contextWindow: 262144, supportsEffort: false },
    ],
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    region: 'cn',
    apiBase: 'https://api.stepfun.com/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.stepfun.com',
    models: [
      { id: 'step-2-16k', contextWindow: 16384, supportsEffort: false },
      { id: 'step-1v-32k', contextWindow: 32768, vision: true, supportsEffort: false },
    ],
  },
  {
    id: 'baichuan',
    label: '百川智能',
    region: 'cn',
    apiBase: 'https://api.baichuan-ai.com/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.baichuan-ai.com',
    models: [{ id: 'Baichuan4-Turbo', contextWindow: 32768, supportsEffort: false }],
  },
  {
    id: 'yi',
    label: '零一万物 Yi',
    region: 'cn',
    apiBase: 'https://api.lingyiwanwu.com/v1',
    keyHint: '…',
    docs: 'https://platform.lingyiwanwu.com',
    models: [{ id: 'yi-lightning', contextWindow: 16384, supportsEffort: false }],
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    region: 'cn',
    apiBase: 'https://api-inference.modelscope.cn/v1',
    keyHint: 'ms-…',
    docs: 'https://modelscope.cn/docs/model-service/API-Inference',
    models: [{ id: 'Qwen/Qwen3-235B-A22B', contextWindow: 131072, supportsEffort: false }],
  },

  // ────────────────────────────── 国际 ──────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    region: 'intl',
    apiBase: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.openai.com',
    models: [
      { id: 'gpt-5', contextWindow: 400000, priceInput: 1.25, priceInputHit: 0.125, priceOutput: 10, vision: true, supportsEffort: true, maxTokensField: 'max_completion_tokens' },
      { id: 'gpt-5-mini', contextWindow: 400000, priceInput: 0.25, priceInputHit: 0.025, priceOutput: 2, vision: true, supportsEffort: true, maxTokensField: 'max_completion_tokens' },
      { id: 'gpt-4o', contextWindow: 128000, priceInput: 2.5, priceInputHit: 1.25, priceOutput: 10, vision: true, supportsEffort: false },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    region: 'intl',
    protocol: 'anthropic',
    auth: 'x-api-key',
    apiBase: 'https://api.anthropic.com',
    keyHint: 'sk-ant-…',
    docs: 'https://docs.anthropic.com',
    note: 'Claude 不走 OpenAI 协议：已自动切到 /v1/messages + x-api-key（无需手改）',
    models: [
      { id: 'claude-sonnet-4-5', contextWindow: 200000, priceInput: 3, priceInputHit: 0.3, priceOutput: 15, vision: true, supportsEffort: true },
      { id: 'claude-opus-4-1', contextWindow: 200000, priceInput: 15, priceInputHit: 1.5, priceOutput: 75, vision: true, supportsEffort: true },
      { id: 'claude-haiku-4-5', contextWindow: 200000, priceInput: 1, priceInputHit: 0.1, priceOutput: 5, vision: true, supportsEffort: true },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    region: 'intl',
    protocol: 'gemini',
    auth: 'x-goog-api-key',
    apiBase: 'https://generativelanguage.googleapis.com',
    keyHint: 'AIza…',
    docs: 'https://ai.google.dev',
    note: 'Gemini 走原生 generativelanguage 协议（contents / functionDeclarations），已自动切换',
    models: [
      { id: 'gemini-2.5-pro', contextWindow: 1048576, priceInput: 1.25, priceInputHit: 0.3125, priceOutput: 10, vision: true, supportsEffort: true },
      { id: 'gemini-2.5-flash', contextWindow: 1048576, priceInput: 0.3, priceInputHit: 0.075, priceOutput: 2.5, vision: true, supportsEffort: true },
    ],
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI（企业版）',
    region: 'intl',
    endpoint: 'azure',
    auth: 'api-key',
    apiBase: 'https://<资源名>.openai.azure.com',
    keyHint: '…（Azure 门户「密钥和终结点」里的 KEY 1/2）',
    docs: 'https://learn.microsoft.com/azure/ai-services/openai/',
    note: '「模型 ID」填**部署名**（deployment），认证走 api-key 头 + api-version 查询参数',
    apiVersion: '2024-10-21',
    models: [
      { id: 'gpt-4o', contextWindow: 128000, vision: true, supportsEffort: false },
      { id: 'gpt-5', contextWindow: 400000, vision: true, supportsEffort: true, maxTokensField: 'max_completion_tokens' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    region: 'intl',
    apiBase: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    docs: 'https://openrouter.ai/docs',
    note: '一个 key 用遍各家模型；模型 ID 形如 anthropic/claude-sonnet-4.5、openai/gpt-5',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, vision: true, supportsEffort: false },
      { id: 'openai/gpt-5', contextWindow: 400000, vision: true, supportsEffort: false },
      { id: 'deepseek/deepseek-chat-v3.1', contextWindow: 163840, supportsEffort: false },
    ],
  },
  {
    id: 'groq',
    label: 'Groq（低延迟推理）',
    region: 'intl',
    apiBase: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
    docs: 'https://console.groq.com',
    models: [
      { id: 'moonshotai/kimi-k2-instruct', contextWindow: 131072, supportsEffort: false },
      { id: 'llama-3.3-70b-versatile', contextWindow: 131072, supportsEffort: false },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    region: 'intl',
    apiBase: 'https://api.mistral.ai/v1',
    keyHint: '…',
    docs: 'https://docs.mistral.ai',
    models: [
      { id: 'mistral-large-latest', contextWindow: 131072, supportsEffort: false },
      { id: 'magistral-medium-latest', contextWindow: 131072, supportsEffort: false },
    ],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    region: 'intl',
    apiBase: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    docs: 'https://docs.x.ai',
    models: [
      { id: 'grok-4', contextWindow: 256000, vision: true, supportsEffort: false },
      { id: 'grok-3-mini', contextWindow: 131072, supportsEffort: false },
    ],
  },
  {
    id: 'together',
    label: 'Together AI',
    region: 'intl',
    apiBase: 'https://api.together.xyz/v1',
    keyHint: '…',
    docs: 'https://docs.together.ai',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', contextWindow: 131072, supportsEffort: false },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', contextWindow: 262144, supportsEffort: false },
    ],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    region: 'intl',
    apiBase: 'https://api.fireworks.ai/inference/v1',
    keyHint: 'fw_…',
    docs: 'https://docs.fireworks.ai',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', contextWindow: 131072, supportsEffort: false },
    ],
  },
  {
    id: 'perplexity',
    label: 'Perplexity（联网检索）',
    region: 'intl',
    apiBase: 'https://api.perplexity.ai',
    keyHint: 'pplx-…',
    docs: 'https://docs.perplexity.ai',
    models: [
      { id: 'sonar-pro', contextWindow: 200000, supportsEffort: false },
      { id: 'sonar', contextWindow: 128000, supportsEffort: false },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras（超快推理）',
    region: 'intl',
    apiBase: 'https://api.cerebras.ai/v1',
    keyHint: 'csk-…',
    docs: 'https://inference-docs.cerebras.ai',
    models: [{ id: 'llama-3.3-70b', contextWindow: 131072, supportsEffort: false }],
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    region: 'intl',
    apiBase: 'https://api.deepinfra.com/v1/openai',
    keyHint: '…',
    docs: 'https://deepinfra.com/docs',
    models: [{ id: 'deepseek-ai/DeepSeek-V3', contextWindow: 65536, supportsEffort: false }],
  },

  // ────────────────────────────── 本地 / 自建 ──────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    region: 'local',
    local: true,
    auth: 'none',
    apiBase: 'http://127.0.0.1:11434/v1',
    keyHint: '本地服务不需要密钥，留空即可',
    docs: 'https://ollama.com',
    note: '本地服务免鉴权：API Key 可留空',
    models: [
      { id: 'qwen3:32b', contextWindow: 32768, supportsEffort: false },
      { id: 'deepseek-r1:14b', contextWindow: 65536, supportsEffort: false },
    ],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    region: 'local',
    local: true,
    auth: 'none',
    apiBase: 'http://127.0.0.1:1234/v1',
    keyHint: '本地服务不需要密钥，留空即可',
    docs: 'https://lmstudio.ai',
    note: '本地服务免鉴权：API Key 可留空',
    models: [{ id: 'local-model', contextWindow: 32768, supportsEffort: false }],
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp / vLLM（本地 OpenAI 服务）',
    region: 'local',
    local: true,
    auth: 'none',
    apiBase: 'http://127.0.0.1:8000/v1',
    keyHint: '本地服务不需要密钥，留空即可',
    docs: 'https://github.com/ggml-org/llama.cpp',
    note: 'llama-server（--api）与 vLLM 都提供 OpenAI 兼容端点；若启动时设了 --api-key 请填上',
    models: [{ id: 'local-model', contextWindow: 32768, supportsEffort: false }],
  },
  {
    id: 'gateway',
    label: '自建聚合网关（one-api / new-api / LiteLLM）',
    region: 'local',
    local: true,
    auth: 'bearer',
    apiBase: 'http://127.0.0.1:3000/v1',
    keyHint: 'sk-…（网关里生成的令牌）',
    docs: 'https://github.com/songquanpeng/one-api',
    note: '把地址改成你自己的网关入口；模型 ID 用网关里的模型名',
    models: [{ id: 'gpt-4o', contextWindow: 128000, supportsEffort: false }],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    region: 'intl',
    apiBase: 'https://api.example.com/v1',
    keyHint: '…',
    docs: '',
    note: '任何 OpenAI 兼容端点都可以：填地址 + 模型 ID 即可；协议/认证保持默认',
    models: [{ id: '', contextWindow: 131072, supportsEffort: false }],
  },
];

const REGION_LABELS = { cn: '国内厂商', intl: '国际厂商', local: '本地 / 自建' };

function allPresets() {
  return PROVIDERS.slice();
}

function findPreset(id) {
  const key = String(id == null ? '' : id).trim();
  if (!key) return null;
  return PROVIDERS.find((p) => p.id === key) || null;
}

/** 默认协议/认证（预设缺省 = openai + 按协议取默认） */
function presetProtocol(preset) {
  return String((preset && preset.protocol) || 'openai');
}

function presetAuth(preset) {
  if (preset && preset.auth) return String(preset.auth);
  if (preset && preset.endpoint === 'azure') return 'api-key';
  return 'auto';
}

/**
 * 预设 → 可直接写进 models.json 的模型条目（apiKey 由调用方补）。
 * 模型 id 会带上厂商前缀（`<provider>/<model>`）作为本地唯一键，避免两家同名模型互相覆盖。
 */
function presetModels(preset, options = {}) {
  const providerId = String((preset && preset.id) || 'provider');
  const apiBase = String((options && options.apiBase) || (preset && preset.apiBase) || '');
  const apiKey = String((options && options.apiKey) || '');
  return ((preset && preset.models) || []).map((model) => ({
    id: providerId + '/' + (model.id || 'default'),
    provider: providerId,
    providerLabel: String((preset && preset.label) || providerId),
    label: (String((preset && preset.label) || '').split(/[（(/]/)[0] || providerId) + ' · ' + (model.label || model.id || 'default'),
    model: model.id || '',
    apiBase: providerId === 'custom' ? apiBase : String((preset && preset.apiBase) || apiBase),
    apiKey,
    protocol: presetProtocol(preset),
    auth: presetAuth(preset),
    endpoint: (preset && preset.endpoint) || 'standard',
    apiVersion: (preset && preset.apiVersion) || (preset && preset.endpoint === 'azure' ? '2024-10-21' : ''),
    maxTokensField: model.maxTokensField || (preset && preset.maxTokensField) || 'max_tokens',
    contextWindow: Number(model.contextWindow) || 131072,
    priceInput: Number(model.priceInput) || 0,
    priceInputHit: Number(model.priceInputHit) || 0,
    priceOutput: Number(model.priceOutput) || 0,
    supportsEffort: model.supportsEffort === true,
    vision: model.vision === true,
    enabled: true,
  }));
}

module.exports = {
  PROVIDERS,
  REGION_LABELS,
  allPresets,
  findPreset,
  presetModels,
  presetProtocol,
  presetAuth,
};
