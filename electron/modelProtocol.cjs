/**
 * modelProtocol.cjs —— 模型接入**协议适配层**（把「一家一版的私有 API」收敛成一个内部形状）
 *
 * 背景：harness 内部（主循环 / 压缩 / 意图分类 / 子代理）只认一种形状 —— OpenAI 兼容的
 * `messages + tools`、SSE `choices[].delta`、`{prompt_tokens, completion_tokens}` 用量。
 * 于是「换一家模型」在旧实现里等于**改代码**：URL 写死 `apiBase + '/chat/completions'`、
 * 认证头写死 `Authorization: Bearer`、`reasoning_effort` / `stream_options` 无条件下发。
 * 用户手上只要不是 OpenAI 兼容的 key（Claude 原生、Gemini 原生、Azure 企业版），
 * 就完全用不了 —— 而这三家恰恰是「主流 key」里占比最大的一档。
 *
 * 本模块把**协议**与**认证风格**拆成两个正交维度：
 *
 *   protocol：openai（默认，覆盖绝大多数厂商）| anthropic（Claude /v1/messages）| gemini（generativelanguage）
 *   auth    ：auto（按协议取默认）| bearer（Authorization: Bearer）| x-api-key | api-key | query（?key=）
 *   endpoint：standard（默认）| azure（/openai/deployments/<部署名>/chat/completions?api-version=）
 *
 * 对外只有四个动作，全部是**纯函数**（不改入参、不碰网络、可离线单测）：
 *   buildRequest(cfg, messages, { stream, tools }) → { protocol, url, headers, body }
 *   parseResponse(protocol, jsonBody)              → { content, reasoning, toolCalls, usage, finishReason }
 *   createStreamTranslator(protocol)               → { translate(text), flush() }（把原生 SSE 翻成 OpenAI SSE 文本）
 *   describeProtocol(cfg)                          → 给日志 / 自检 / UI 的人话摘要
 *
 * 为什么流式要走「翻译成 OpenAI SSE」而不是各写一套累加器：流中途断线要**整轮重发**、
 * 停滞判定、坏 JSON、重复/累积分片、usage 帧归并……这些语义 streamAccumulator 已经逐条
 * 用测试锁死了（见 scripts/stream-accumulator-test.cjs）。翻译层只做「原生帧 → OpenAI 帧」的
 * 1:1 映射，下游一行都不用改，风险面最小。
 *
 * 负向保证（用例锁住）：`protocol` 未声明 / = 'openai' 时，`buildRequest` 产出的
 * url / headers / body 与改造前**逐字节一致**（包括请求体的键顺序）。
 */
'use strict';

/** 支持的协议。默认 openai（绝大多数厂商都是 OpenAI 兼容）。 */
const PROTOCOL_IDS = ['openai', 'anthropic', 'gemini'];
/** 认证风格。auto = 按协议取默认（openai→bearer / anthropic→x-api-key / gemini→x-goog-api-key）。 */
const AUTH_STYLES = ['auto', 'bearer', 'x-api-key', 'api-key', 'query'];

const PROTOCOL_LABELS = {
  openai: 'OpenAI 兼容（/chat/completions）',
  anthropic: 'Anthropic Messages（Claude 原生）',
  gemini: 'Google Gemini（generativelanguage 原生）',
};

const AUTH_LABELS = {
  auto: '自动（按协议）',
  bearer: 'Authorization: Bearer',
  'x-api-key': 'x-api-key',
  'api-key': 'api-key（Azure）',
  query: 'URL 参数 ?key=',
};

/** Anthropic 官方要求的版本头；不带头会被 400 拒掉 */
const ANTHROPIC_VERSION = '2023-06-01';
/** Azure OpenAI 的 api-version：留空用这个（2024-10-21 是当前长期支持档） */
const AZURE_DEFAULT_API_VERSION = '2024-10-21';

/** 推理强度 → Anthropic thinking 预算（tokens）。Anthropic 只认「思考预算」不认 effort 字符串。 */
const EFFORT_TO_THINKING_BUDGET = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 24576,
};
const THINKING_BUDGET_DEFAULT = 8192;

/**
 * Gemini 的 thinking 预算：0 = 关思考（2.5 flash 支持，pro 不支持 0 → 用 128 兜底）。
 * 与 Anthropic 的档位分开，因为两家的「预算语义」不同（Gemini 是上限、Anthropic 是下限+上限约束）。
 */
const EFFORT_TO_GEMINI_BUDGET = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 24576,
};

function normalizeProtocol(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return 'openai';
  // 常见别名：claude / messages / anthropic-v1 → anthropic；google / googleai / gemini-native → gemini
  if (value === 'anthropic' || value === 'claude' || value === 'messages') return 'anthropic';
  if (value === 'gemini' || value === 'google' || value === 'googleai' || value === 'generativelanguage') return 'gemini';
  if (value === 'openai' || value === 'openai-compatible' || value === 'compatible' || value === 'azure' || value === 'azure-openai') return 'openai';
  return 'openai';
}

function defaultAuthStyle(protocol, endpoint) {
  if (endpoint === 'azure') return 'api-key';
  if (protocol === 'anthropic') return 'x-api-key';
  if (protocol === 'gemini') return 'x-goog-api-key';
  return 'bearer';
}

function normalizeAuthStyle(raw, protocol, endpoint) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value || value === 'auto') return defaultAuthStyle(protocol, endpoint);
  if (value === 'x-goog-api-key' || value === 'goog' || value === 'google') return 'x-goog-api-key';
  if (value === 'x-api-key' || value === 'apikey' || value === 'api_key') return 'x-api-key';
  if (value === 'api-key') return 'api-key';
  if (value === 'none' || value === 'noauth' || value === 'off') return 'none';
  if (value === 'query' || value === 'key') return 'query';
  return 'bearer';
}

/** 端点风格：azure 需要部署名路径与 api-version 查询参数（其余厂商都用标准路径） */
function normalizeEndpoint(cfg) {
  const raw = String((cfg && (cfg.endpoint || cfg.apiEndpoint)) || '').trim().toLowerCase();
  if (raw === 'azure' || raw === 'azure-openai' || raw === 'azureopenai') return 'azure';
  if (raw === 'standard' || raw === 'default') return 'standard';
  // 只填了 apiVersion / azureDeployment 也按 azure 处理（UI 上这两个字段是 Azure 专属）
  if (cfg && (cfg.apiVersion || cfg.azureDeployment)) return 'azure';
  if (cfg && cfg.provider && /azure/i.test(String(cfg.provider))) return 'azure';
  // 地址本身就是 Azure 企业端点时不必再让用户勾选（界面已不再暴露端点开关）
  if (cfg && /openai\.azure\.com/i.test(String(cfg.apiBase || ''))) return 'azure';
  return 'standard';
}

/**
 * 协议**自动判定**（界面上只有「API Key」一个入口，不该再让用户选协议）：
 * 只看 API 地址的域名特征 —— 确定性、可离线单测、不做联网探测。
 *   api.anthropic.com                  → anthropic（/v1/messages + x-api-key）
 *   generativelanguage.googleapis.com  → gemini（contents + x-goog-api-key）
 *   其它（含 *.openai.azure.com）       → openai 兼容（Azure 的 api-key 头与 api-version 由端点风格补）
 * 需要强制指定时仍可写 config/agent.properties 的 api_protocol，或模型条目里的 protocol 字段。
 */
function inferProtocolFromBase(apiBase) {
  const text = String(apiBase || '').toLowerCase();
  if (!text) return 'openai';
  if (/anthropic\.com|\/v1\/messages/.test(text)) return 'anthropic';
  if (/generativelanguage\.googleapis\.com|googleapis\.com\/v1beta/.test(text)) return 'gemini';
  return 'openai';
}

/** 协议解析：显式声明优先 → 按地址判定 → 回落 OpenAI 兼容 */
function resolveProtocol(cfg) {
  const declared = String((cfg && (cfg.protocol || cfg.apiProtocol)) || '').trim();
  if (declared) return normalizeProtocol(declared);
  return inferProtocolFromBase(cfg && cfg.apiBase);
}

function trimSlashes(value) {
  return String(value == null ? '' : value).trim().replace(/\/+$/, '');
}

/** 去掉用户可能多填的版本后缀（Anthropic 的 /v1、Gemini 的 /v1beta 或 /v1beta/models） */
function stripVersionSuffix(base, suffixes) {
  let out = trimSlashes(base);
  for (const suffix of suffixes) {
    if (out.toLowerCase().endsWith(suffix.toLowerCase())) {
      out = out.slice(0, out.length - suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return out;
}

/**
 * 认证头。**密钥不落日志**：调用方（agent.cjs）出错时只上报状态与响应体，
 * 本函数只把密钥放进请求头/URL 参数，不做任何拼接输出。
 */
/** @returns {Record<string, string>} */
function authHeaders(cfg, authStyle) {
  const key = String((cfg && cfg.apiKey) || '');
  const style = authStyle || normalizeAuthStyle(cfg && cfg.auth, normalizeProtocol(cfg && cfg.protocol), normalizeEndpoint(cfg));
  if (style === 'none') return {};
  if (style === 'x-api-key') return { 'x-api-key': key };
  if (style === 'api-key') return { 'api-key': key };
  if (style === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return { Authorization: 'Bearer ' + key };
}

/** 数据 URL → { mediaType, data }；非数据 URL 返回 null */
function parseDataUrl(url) {
  const text = String(url == null ? '' : url);
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(text);
  if (!match) return null;
  const mediaType = match[1] || 'image/png';
  const isBase64 = /;base64/i.test(match[2] || '');
  return { mediaType, base64: isBase64, data: match[3] || '' };
}

/** 把消息内容（字符串 / 多模态数组）拍平成纯文本（tool_result / system 用） */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[图片]';
        return '';
      })
      .join('');
  }
  return String(content);
}

/** 解析 assistant.tool_calls[].function.arguments（字符串或已是对象） */
function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ────────────────────────────── Anthropic（Claude 原生 /v1/messages） ──────────────────────────────

/**
 * OpenAI messages → Anthropic messages。
 *
 * Anthropic 的硬约束（踩过都是 400）：
 *   ① system 不是消息，是顶层 `system` 参数；
 *   ② messages 必须 **user / assistant 交替**（相邻同角色要合并，否则 400）；
 *   ③ `role:'tool'` 的结果必须以 `tool_result` 块放在 **user** 消息里，且 tool_use_id 必须对得上；
 *   ④ 助手消息里的工具调用是 content 块 `tool_use`（id/name/input），不是 `tool_calls` 字段。
 */
function toAnthropicMessages(messages) {
  const systemTexts = [];
  /** @type {Array<{role: string, content: Array<any>}>} */
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || message.toolCallId || ''),
          content: contentToText(message.content),
        },
      ]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = contentToText(message.content);
      if (text) blocks.push({ type: 'text', text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      calls.forEach((call, index) => {
        const fn = (call && call.function) || {};
        blocks.push({
          type: 'tool_use',
          id: String((call && call.id) || 'toolu_' + index),
          name: String(fn.name || (call && call.name) || ''),
          input: parseToolArguments(fn.arguments),
        });
      });
      push('assistant', blocks);
      continue;
    }
    // user（含多模态）
    const blocks = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: String(part.text || '') });
          continue;
        }
        if (part.type === 'image_url') {
          const dataUrl = parseDataUrl(part.image_url && part.image_url.url);
          if (dataUrl) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data },
            });
          } else if (part.image_url && part.image_url.url) {
            // Anthropic 支持 URL 直传（2025 起）：非 data URL 一律按 url 源处理
            blocks.push({ type: 'image', source: { type: 'url', url: String(part.image_url.url) } });
          }
        }
      }
    } else {
      const text = contentToText(content);
      if (text) blocks.push({ type: 'text', text });
    }
    push('user', blocks);
  }
  /**
   * Anthropic 要求会话**从 user 开始**（历史以助手消息开头时直接 400：
   * `messages: first message must use the "user" role`）。补一条最小的 user 占位，
   * 而不是把助手消息丢掉 —— 丢历史会让模型看不到上下文，那比多一条占位更糟。
   */
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '（会话从这条之后继续）' }] });
  }
  return { system: systemTexts.join('\n\n'), messages: out };
}

/** OpenAI tools → Anthropic tools（`parameters` → `input_schema`） */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map((tool) => {
    const fn = (tool && tool.function) || {};
    return {
      name: String(fn.name || ''),
      description: String(fn.description || ''),
      input_schema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    };
  });
}

function thinkingBudgetFor(cfg) {
  const effort = String((cfg && cfg.reasoningEffort) || '').toLowerCase();
  const budget = EFFORT_TO_THINKING_BUDGET[effort] || THINKING_BUDGET_DEFAULT;
  const maxTokens = Number((cfg && cfg.maxTokens) || 0) || 0;
  // Anthropic 硬性要求 max_tokens > thinking.budget_tokens，否则 400：装不下就干脆不开思考
  if (maxTokens && budget >= maxTokens) {
    const shrunk = Math.max(1024, Math.floor(maxTokens / 2));
    return shrunk > 0 && shrunk < maxTokens ? shrunk : 0;
  }
  return budget;
}

function buildAnthropicRequest(cfg, messages, /** @type {{ stream?: boolean, tools?: any }} */ { stream, tools } = {}) {
  const base = stripVersionSuffix((cfg && cfg.apiBase) || 'https://api.anthropic.com', ['/v1/messages', '/v1']);
  const authStyle = normalizeAuthStyle(cfg && cfg.auth, 'anthropic', 'standard');
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'anthropic-version': String((cfg && cfg.anthropicVersion) || ANTHROPIC_VERSION) },
    authHeaders(cfg, authStyle),
    (cfg && cfg.extraHeaders) || {}
  );
  const converted = toAnthropicMessages(messages);
  /** @type {any} */
  const body = { model: cfg.model, max_tokens: Number(cfg.maxTokens) || 4096 };
  if (converted.system) body.system = converted.system;
  body.messages = converted.messages.length ? converted.messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }];
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) body.tools = anthropicTools;
  /**
   * 思考链：Anthropic 没有 `reasoning_effort`，它认 `thinking.budget_tokens`。
   * 关思考（reasoningEffort 为 null）时**整个字段都不下发** —— 这才对应 UI 上「不支持推理强度」的语义。
   */
  if (cfg.reasoningEffort) {
    const budget = thinkingBudgetFor(cfg);
    if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  if (stream) body.stream = true;
  return { protocol: 'anthropic', url: base + '/v1/messages', headers, body };
}

/** Anthropic usage → 内部（OpenAI）口径。缓存命中单独给 prompt_tokens_details.cached_tokens。 */
function usageFromAnthropic(usage) {
  const u = usage || {};
  const input = Number(u.input_tokens || 0) || 0;
  const output = Number(u.output_tokens || 0) || 0;
  const cacheRead = Number(u.cache_read_input_tokens || 0) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens || 0) || 0;
  const prompt = input + cacheRead + cacheWrite;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  return out;
}

const ANTHROPIC_FINISH_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

function mapFinishReason(protocol, raw) {
  const value = String(raw == null ? '' : raw);
  if (!value) return null;
  if (protocol === 'anthropic') return ANTHROPIC_FINISH_REASONS[value] || value;
  if (protocol === 'gemini') {
    const table = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', MALFORMED_FUNCTION_CALL: 'tool_calls', OTHER: 'stop', FINISH_REASON_UNSPECIFIED: null };
    return table[value] !== undefined ? table[value] : value;
  }
  return value;
}

function parseAnthropicResponse(data) {
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  let content = '';
  let reasoning = '';
  /** @type {Array<any>|null} */
  let toolCalls = null;
  blocks.forEach((block, index) => {
    if (!block) return;
    if (block.type === 'text') content += String(block.text || '');
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') reasoning += String(block.thinking || '');
    else if (block.type === 'tool_use') {
      toolCalls = toolCalls || [];
      toolCalls.push({
        id: String(block.id || 'toolu_' + index),
        type: 'function',
        function: { name: String(block.name || ''), arguments: JSON.stringify(block.input == null ? {} : block.input) },
      });
    }
  });
  return {
    content,
    reasoning,
    toolCalls,
    usage: parseAnthropicUsageEnvelope(data && data.usage),
    finishReason: mapFinishReason('anthropic', data && data.stop_reason),
  };
}
function parseAnthropicUsageEnvelope(usage) {
  if (!usage) return null;
  return usageFromAnthropic(usage);
}

// ────────────────────────────── Google Gemini（generativelanguage 原生） ──────────────────────────────

/**
 * Gemini 的 JSON Schema 子集比 OpenAI 严：`additionalProperties` / `$schema` / `strict`
 * 这类关键字会被 400 INVALID_ARGUMENT 拒掉，而仓库的 `closeInputSchema()` 恰好会加
 * `additionalProperties: false` —— 必须在这里剥掉，否则**每个**工具调用都会 400。
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', 'additionalProperties', 'strict', '$defs', 'definitions', 'examples']);

function sanitizeGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/** OpenAI tools → Gemini functionDeclarations */
function toGeminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const declarations = tools.map((tool) => {
    const fn = (tool && tool.function) || {};
    const declaration = { name: String(fn.name || ''), description: String(fn.description || '') };
    if (fn.parameters && typeof fn.parameters === 'object') declaration.parameters = sanitizeGeminiSchema(fn.parameters);
    return declaration;
  });
  return [{ functionDeclarations: declarations }];
}

/**
 * OpenAI messages → Gemini contents。
 *   system → 顶层 `systemInstruction`；assistant → role 'model'；tool → functionResponse（按 id 反查函数名）
 */
function toGeminiContents(messages) {
  const systemTexts = [];
  /** @type {Array<{role: string, parts: Array<any>}>} */
  const out = [];
  /** tool_call_id → 函数名（Gemini 的 functionResponse 只认名字，不认 id） */
  const callNames = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    out.push({ role, parts });
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === 'tool') {
      const id = String(message.tool_call_id || message.toolCallId || '');
      const name = String(message.name || callNames.get(id) || 'tool');
      let response = null;
      try {
        const parsed = JSON.parse(contentToText(message.content));
        response = parsed && typeof parsed === 'object' ? parsed : { result: parsed };
      } catch {
        response = { result: contentToText(message.content) };
      }
      push('user', [{ functionResponse: { name, response } }]);
      continue;
    }
    if (role === 'assistant') {
      const parts = [];
      const text = contentToText(message.content);
      if (text) parts.push({ text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = (call && call.function) || {};
        const name = String(fn.name || (call && call.name) || '');
        if (call && call.id) callNames.set(String(call.id), name);
        parts.push({ functionCall: { name, args: parseToolArguments(fn.arguments) } });
      }
      push('model', parts);
      continue;
    }
    const parts = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'text') {
          parts.push({ text: String(part.text || '') });
          continue;
        }
        if (part.type === 'image_url') {
          const dataUrl = parseDataUrl(part.image_url && part.image_url.url);
          if (dataUrl) parts.push({ inlineData: { mimeType: dataUrl.mediaType, data: dataUrl.data } });
          else if (part.image_url && part.image_url.url) parts.push({ fileData: { fileUri: String(part.image_url.url) } });
        }
      }
    } else {
      const text = contentToText(content);
      if (text) parts.push({ text });
    }
    push('user', parts);
  }
  // Gemini 同样要求 contents 从 user 开始（助手开头的历史会被拒）
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', parts: [{ text: '（会话从这条之后继续）' }] });
  }
  return { systemInstruction: systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : null, contents: out };
}

function buildGeminiRequest(cfg, messages, /** @type {{ stream?: boolean, tools?: any }} */ { stream, tools } = {}) {
  const base = stripVersionSuffix((cfg && cfg.apiBase) || 'https://generativelanguage.googleapis.com', ['/v1beta/models', '/v1beta', '/v1']);
  const authStyle = normalizeAuthStyle(cfg && cfg.auth, 'gemini', 'standard');
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const model = String((cfg && cfg.model) || '').replace(/^models\//, '');
  let url = base + '/v1beta/models/' + encodeURIComponent(model) + ':' + action;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, (cfg && cfg.extraHeaders) || {});
  if (authStyle === 'query') url += '?key=' + encodeURIComponent(String((cfg && cfg.apiKey) || ''));
  else Object.assign(headers, authHeaders(cfg, authStyle));
  if (stream && authStyle !== 'query') url += '?alt=sse';
  /**
   * 流式：`?alt=sse` 让 Gemini 回标准 SSE（`data: {...}` 逐行），
   * 不带上它就是裸 JSON 数组分片流 —— 那种形状没有 SSE 分隔符，累加器解析不了。
   */
  const converted = toGeminiContents(messages);
  /** @type {any} */
  const body = { contents: converted.contents.length ? converted.contents : [{ role: 'user', parts: [{ text: '' }] }] };
  if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction;
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;
  const generationConfig = {};
  const maxTokens = Number(cfg && cfg.maxTokens) || 0;
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (cfg.reasoningEffort) {
    const effort = String(cfg.reasoningEffort).toLowerCase();
    const budget = Object.prototype.hasOwnProperty.call(EFFORT_TO_GEMINI_BUDGET, effort) ? EFFORT_TO_GEMINI_BUDGET[effort] : 8192;
    // 2.5 pro 不接受 thinkingBudget=0；0 只在 flash 系列合法，这里给 128 兜底更安全
    generationConfig.thinkingConfig = { thinkingBudget: budget === 0 ? 128 : budget };
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return { protocol: 'gemini', url, headers, body };
}

/** Gemini usageMetadata → 内部口径 */
function usageFromGemini(usage) {
  if (!usage) return null;
  const prompt = Number(usage.promptTokenCount || 0) || 0;
  const output = Number(usage.candidatesTokenCount || 0) || 0;
  const total = Number(usage.totalTokenCount || 0) || prompt + output;
  const out = { prompt_tokens: prompt, completion_tokens: output, total_tokens: total };
  const cached = Number(usage.cachedContentTokenCount || 0) || 0;
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

/** Gemini 非流式响应 → 内部口径（thought:true 的 part 归入 reasoning） */
function parseGeminiResponse(data) {
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  let content = '';
  let reasoning = '';
  /** @type {Array<any>|null} */
  let toolCalls = null;
  let index = 0;
  for (const part of parts) {
    if (!part) continue;
    if (typeof part.text === 'string') {
      if (part.thought === true) reasoning += part.text;
      else content += part.text;
    }
    if (part.functionCall) {
      toolCalls = toolCalls || [];
      toolCalls.push({
        id: 'call_' + index,
        type: 'function',
        function: { name: String(part.functionCall.name || ''), arguments: JSON.stringify(part.functionCall.args == null ? {} : part.functionCall.args) },
      });
      index += 1;
    }
  }
  return { content, reasoning, toolCalls, usage: usageFromGemini(data && data.usageMetadata), finishReason: mapFinishReason('gemini', candidate && candidate.finishReason) };
}

// ────────────────────────────── OpenAI 兼容（默认） ──────────────────────────────

/**
 * 组装 OpenAI 兼容请求。
 *
 * **键顺序是判据的一部分**：`model, messages, stream, max_tokens, [reasoning_effort], [stream_options], [tools]`
 * 与改造前逐字节一致 —— 供应商那边对前缀缓存敏感（哪怕语义相同，字段顺序变了也可能让缓存失效），
 * 所以这里不用「能省就省」的写法。
 *
 * azure：路径换成 `/openai/deployments/<部署名>/chat/completions?api-version=…`，认证头 `api-key`
 * （Azure 企业版**不认** `Authorization: Bearer`，这是它最典型的坑）。
 */
function buildOpenAiRequest(cfg, messages, /** @type {{ stream?: boolean, tools?: any }} */ { stream, tools } = {}) {
  const endpoint = normalizeEndpoint(cfg);
  const base = trimSlashes((cfg && cfg.apiBase) || 'https://api.deepseek.com');
  const authStyle = normalizeAuthStyle(cfg && cfg.auth, 'openai', endpoint);
  let url;
  if (endpoint === 'azure') {
    const deployment = String((cfg && (cfg.azureDeployment || cfg.deployment)) || (cfg && cfg.model) || '');
    const apiVersion = String((cfg && cfg.apiVersion) || AZURE_DEFAULT_API_VERSION);
    url = base + '/openai/deployments/' + encodeURIComponent(deployment) + '/chat/completions?api-version=' + encodeURIComponent(apiVersion);
  } else {
    url = base + '/chat/completions';
  }
  const headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg, authStyle), (cfg && cfg.extraHeaders) || {});
  /** @type {any} */
  const body = {
    model: cfg.model,
    messages,
    stream: !!stream,
  };
  /**
   * 输出上限字段名：新模型（OpenAI o 系列 / GPT-5 家族）只认 `max_completion_tokens`，
   * 老模型与绝大多数兼容网关只认 `max_tokens`。由模型配置（models.json）决定，默认老名字。
   */
  const maxTokensField = String((cfg && cfg.maxTokensField) || 'max_tokens');
  if (maxTokensField === 'max_completion_tokens') body.max_completion_tokens = cfg.maxTokens;
  else body.max_tokens = cfg.maxTokens;
  if (cfg.reasoningEffort) {
    body.reasoning_effort = cfg.reasoningEffort;
  }
  // stream_options 只有流式才有意义；且**可关**（网关不认这个字段时用 agent.send_stream_options=false）
  if (stream && cfg.sendStreamOptions !== false) {
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length) body.tools = tools;
  return { protocol: 'openai', url, headers, body };
}

/** OpenAI 非流式响应 → 内部口径（与改造前 agent.cjs 内联逻辑逐字段一致） */
function parseOpenAiResponse(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message : null;
  return {
    content: (msg && msg.content) || '',
    reasoning: (msg && msg.reasoning_content) || '',
    toolCalls: (msg && msg.tool_calls) || null,
    usage: (data && data.usage) || null,
    finishReason: (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || null,
  };
}

// ────────────────────────────── 对外总入口 ──────────────────────────────

/**
 * 组装一次模型请求。
 * @param {any} cfg
 * @param {Array<any>} messages
 * @param {{ stream?: boolean, tools?: any }} [options]
 * @returns {{ protocol: string, url: string, headers: Record<string,string>, body: any }}
 */
function buildRequest(cfg, messages, /** @type {{ stream?: boolean, tools?: any }} */ options = {}) {
  const protocol = resolveProtocol(cfg);
  if (protocol === 'anthropic') return buildAnthropicRequest(cfg, messages, options);
  if (protocol === 'gemini') return buildGeminiRequest(cfg, messages, options);
  return buildOpenAiRequest(cfg, messages, options);
}

function parseResponse(protocol, data) {
  const normalized = normalizeProtocol(protocol);
  if (normalized === 'anthropic') return parseAnthropicResponse(data);
  if (normalized === 'gemini') return parseGeminiResponse(data);
  return parseOpenAiResponse(data);
}

function sseFrame(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

function openAiTextFrame(text) {
  return sseFrame({ choices: [{ index: 0, delta: { content: String(text) } }] });
}

function openAiReasoningFrame(text) {
  return sseFrame({ choices: [{ index: 0, delta: { reasoning_content: String(text) } }] });
}

function openAiToolFrame(index, id, name, args) {
  return sseFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id,
              type: 'function',
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  });
}

function openAiFinishFrame(finishReason) {
  return sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }] });
}

/**
 * 流式翻译器：原生 SSE 文本 → OpenAI SSE 文本。
 *
 * 逐行处理（分片可能把一行劈成两半，所以自带行缓冲）；openai 协议原样透传（零成本、零风险）。
 * 返回对象：
 *   translate(text) → 已完整行的 OpenAI SSE 文本（可能为空串）
 *   flush()         → 残行 + 收尾帧（[DONE]）
 */
function createStreamTranslator(protocol) {
  const normalized = normalizeProtocol(protocol);
  const passthrough = {
    translate(text) {
      return String(text == null ? '' : text);
    },
    flush() {
      return '';
    },
  };
  if (normalized === 'openai') return passthrough;

  let buffer = '';
  let done = false;
  /** Anthropic：block index → 工具调用序号；以及「该工具块有没有收到过 input_json_delta」 */
  const toolIndexByBlock = new Map();
  let toolCount = 0;
  const sawToolJson = new Set();
  /**
   * 累计用量：Anthropic 把 input（message_start）与 output（message_delta）分两帧报 ——
   * 每帧各自成帧会把先到的 prompt 覆盖成 0（实测踩到）。这里按「只增不减」合并，
   * 保证**最后发出的那一帧是完整的**（累加器对 usage 帧是覆盖语义）。
   * Gemini 每帧带全量 usageMetadata，直接替换即可。
   */
  let cumulative = { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: null };

  function emitUsage(partial, mode) {
    const incoming = partial || {};
    const prompt = Number(incoming.prompt_tokens || 0) || 0;
    const completion = Number(incoming.completion_tokens || 0) || 0;
    if (mode === 'replace') {
      cumulative = { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: incoming.prompt_tokens_details || null };
    } else {
      cumulative = {
        prompt_tokens: prompt > 0 ? prompt : cumulative.prompt_tokens,
        completion_tokens: completion > 0 ? completion : cumulative.completion_tokens,
        prompt_tokens_details: incoming.prompt_tokens_details || cumulative.prompt_tokens_details,
      };
    }
    const next = { prompt_tokens: cumulative.prompt_tokens, completion_tokens: cumulative.completion_tokens, total_tokens: cumulative.prompt_tokens + cumulative.completion_tokens };
    if (cumulative.prompt_tokens_details) next.prompt_tokens_details = cumulative.prompt_tokens_details;
    return sseFrame({ choices: [], usage: next });
  }

  function handleAnthropicPayload(payload) {
    const type = payload && payload.type;
    if (type === 'ping') return '';
    if (type === 'error') {
      return sseFrame({ error: (payload && payload.error) || { message: 'provider stream error' } }) + sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    if (type === 'message_start') {
      const startUsage = payload.message && payload.message.usage;
      if (startUsage) return emitUsage(usageFromAnthropic(startUsage), 'merge');
      return '';
    }
    if (type === 'content_block_start') {
      const block = payload.content_block || {};
      if (block.type === 'tool_use') {
        const index = toolCount;
        toolIndexByBlock.set(payload.index, index);
        toolCount += 1;
        return openAiToolFrame(index, String(block.id || 'toolu_' + index), String(block.name || ''), '');
      }
      if (block.type === 'text' && block.text) return openAiTextFrame(block.text);
      if (block.type === 'thinking' && block.thinking) return openAiReasoningFrame(block.thinking);
      return '';
    }
    if (type === 'content_block_delta') {
      const delta = payload.delta || {};
      if (delta.type === 'text_delta') return openAiTextFrame(delta.text || '');
      if (delta.type === 'thinking_delta') return openAiReasoningFrame(delta.thinking || '');
      if (delta.type === 'input_json_delta') {
        const index = toolIndexByBlock.has(payload.index) ? toolIndexByBlock.get(payload.index) : toolCount;
        sawToolJson.add(index);
        return openAiToolFrame(index, undefined, undefined, String(delta.partial_json || ''));
      }
      return '';
    }
    if (type === 'content_block_stop') {
      // 空参数工具（Anthropic 不发任何 input_json_delta）→ 补一个 `{}`，
      // 否则累加器里 args 为空串、argsValid=true 但参数解析出来的语义不明确
      const index = toolIndexByBlock.has(payload.index) ? toolIndexByBlock.get(payload.index) : null;
      if (index != null && !sawToolJson.has(index)) {
        sawToolJson.add(index);
        return openAiToolFrame(index, undefined, undefined, '{}');
      }
      return '';
    }
    if (type === 'message_delta') {
      let out = '';
      const deltaUsage = payload.usage;
      if (deltaUsage) out += emitUsage(usageFromAnthropic(deltaUsage), 'merge');
      const reason = payload.delta && payload.delta.stop_reason;
      if (reason) out += openAiFinishFrame(mapFinishReason('anthropic', reason));
      return out;
    }
    if (type === 'message_stop') {
      done = true;
      return 'data: [DONE]\n\n';
    }
    return '';
  }

  function handleGeminiPayload(payload) {
    if (payload && payload.error) {
      return sseFrame({ error: payload.error }) + openAiFinishFrame('stop');
    }
    let out = '';
    const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    let index = toolCount;
    for (const part of parts) {
      if (!part) continue;
      if (typeof part.text === 'string' && part.text) {
        out += part.thought === true ? openAiReasoningFrame(part.text) : openAiTextFrame(part.text);
      }
      if (part.functionCall) {
        const args = part.functionCall.args == null ? {} : part.functionCall.args;
        out += openAiToolFrame(index, 'call_' + index, String(part.functionCall.name || ''), typeof args === 'string' ? args : JSON.stringify(args));
        index += 1;
        toolCount = index;
      }
    }
    if (candidate && candidate.finishReason) out += openAiFinishFrame(mapFinishReason('gemini', candidate.finishReason));
    const usageRaw = payload && payload.usageMetadata;
    if (usageRaw) {
      const mapped = usageFromGemini(usageRaw);
      if (mapped) out += emitUsage(mapped, 'replace');
    }
    return out;
  }

  function handleLine(line) {
    const text = String(line == null ? '' : line).trim();
    if (!text || !text.startsWith('data:')) return '';
    const payloadText = text.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') {
      if (payloadText === '[DONE]') done = true;
      return '';
    }
    let payload = null;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return '';
    }
    return normalized === 'anthropic' ? handleAnthropicPayload(payload) : handleGeminiPayload(payload);
  }

  return {
    translate(text) {
      buffer += String(text == null ? '' : text);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      let out = '';
      for (const line of lines) out += handleLine(line);
      return out;
    },
    flush() {
      let out = '';
      if (buffer.trim()) out += handleLine(buffer);
      buffer = '';
      // 原生流没有 OpenAI 的 [DONE] 终止帧（Gemini 尤其没有）：这里补一个，
      // 让累加器的 done 语义与 OpenAI 一致；usageSeen 只用于自检，不影响帧内容
      if (!done) {
        out += 'data: [DONE]\n\n';
        done = true;
      }
      return out;
    },
  };
}

/** 给日志 / 自检 / UI 的人话摘要（**不含密钥**） */
function describeProtocol(cfg) {
  const protocol = resolveProtocol(cfg);
  const endpoint = normalizeEndpoint(cfg);
  const auth = normalizeAuthStyle(cfg && cfg.auth, protocol, endpoint);
  return {
    protocol,
    protocolLabel: PROTOCOL_LABELS[protocol] || protocol,
    endpoint,
    auth,
    authLabel: AUTH_LABELS[auth] || auth,
    apiVersion: endpoint === 'azure' ? String((cfg && cfg.apiVersion) || AZURE_DEFAULT_API_VERSION) : null,
    maxTokensField: String((cfg && cfg.maxTokensField) || 'max_tokens'),
  };
}

module.exports = {
  PROTOCOL_IDS,
  AUTH_STYLES,
  PROTOCOL_LABELS,
  AUTH_LABELS,
  ANTHROPIC_VERSION,
  AZURE_DEFAULT_API_VERSION,
  normalizeProtocol,
  inferProtocolFromBase,
  resolveProtocol,
  normalizeAuthStyle,
  normalizeEndpoint,
  defaultAuthStyle,
  buildRequest,
  parseResponse,
  createStreamTranslator,
  describeProtocol,
  // 供用例直接锁细节（工具 / 消息 / 用量映射）
  toAnthropicMessages,
  toAnthropicTools,
  toGeminiContents,
  toGeminiTools,
  sanitizeGeminiSchema,
  usageFromAnthropic,
  usageFromGemini,
  mapFinishReason,
  parseDataUrl,
  thinkingBudgetFor,
  sseFrame,
};
