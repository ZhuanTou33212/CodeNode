'use strict';
/**
 * costAttribution.cjs —— 成本按层归因（P2-2）：回答「这一次主请求里，到底哪一层在烧 token」。
 *
 * 动机（审计原话）：账本按 main/intent/compression/compaction/subagent 分账很好，但缺**主请求内部构成**
 * —— 没有这层归因，很容易出现「总 token 降了，但不知道是任务更短还是 harness 真变轻」的假优化。
 *
 * 本模块**只测量、不改行为**：纯函数 + 显式输入（system 段落、消息、tools、工具投影累加器），
 * 计费与缓存命中仍归 `costLedger.cjs`（这里只把 usage 里的命中/未命中镜像进来，方便一起看）。
 *
 * 口径要点（避免两个常见错账）：
 *   1. system 的 token **按段落**估，且不再按「一条 system 消息」重复计一遍（`messages` 里的 system 会被跳过）；
 *   2. token 折算与 `compaction.estimateTokens` **共用同一套规则**（`estimateTextTokens`），不另立口径；
 *   3. 未登记的段落一律算 `system_dynamic`（fail-safe：绝不把不确定的东西算进「稳定前缀」的账）。
 */

const compaction = require('./compaction.cjs');

/** 归因层（审计 P2-2 点名的 8 项 + 画布即时状态单列） */
const LAYERS = Object.freeze([
  'system_static',
  'system_dynamic',
  'tool_schema',
  'memory',
  'rag',
  'project_state',
  'history_user',
  'history_assistant',
  'tool_result',
  'attachment',
]);

/**
 * system 段落 id（`agent.PROMPT_SECTIONS` 的 id）→ 归因层。
 * `tools` 段（【可用工具】引导）与真实 schema 同属工具面，所以一起算 `tool_schema`，
 * 但返回值里用 `toolSchema.guideTokens / schemaTokens` 分别报出 —— 加总透明，不藏钱。
 */
const SECTION_LAYER = Object.freeze({
  'reply-rules': 'system_static',
  'runtime-rules': 'system_static',
  soul: 'system_static',
  tools: 'tool_schema',
  'task-rules': 'system_dynamic',
  skills: 'system_dynamic',
  memory: 'memory',
  'user-memory': 'memory',
  canvas: 'project_state',
});

/** RAG 注入走的是机器注入的 user 消息（前缀固定），单列成 rag 层而不是混进 history_user */
const RAG_USER_PREFIX = 'RAG 来源校验：';

/** 单图 token 粗估（与 compaction.estimateTokens / requestBudget 同量级，三处必须一致） */
const IMAGE_TOKENS = 1100;

function emptyLayers() {
  /** @type {Record<string, number>} */
  const out = {};
  for (const layer of LAYERS) out[layer] = 0;
  return out;
}

/**
 * 消息 → 该层的 token（含每条消息的角色/分隔开销，与 estimateTokens 一致）。
 * @returns {{tokens: number, attachments: number, rag: boolean}}
 */
function messageTokens(msg) {
  let tokens = 0;
  let attachments = 0;
  if (msg && typeof msg.content === 'string') tokens += compaction.estimateTextTokens(msg.content);
  else if (msg && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part) continue;
      if (part.type === 'image_url') attachments += IMAGE_TOKENS; // 图片按「张」折算，与 requestBudget 同口径
      else tokens += compaction.estimateTextTokens(part.text);
    }
  }
  if (msg && Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      tokens += compaction.estimateTextTokens(call && call.function && call.function.arguments);
    }
  }
  tokens += 8; // 每条消息的角色/分隔开销
  const text = typeof (msg && msg.content) === 'string' ? msg.content : '';
  return { tokens, attachments, rag: text.startsWith(RAG_USER_PREFIX) };
}

/**
 * 主请求的按层归因。
 *
 * @param {object} input
 *   sections           —— `agent.splitPromptSections(systemPrompt)` 的结果（含 id/stable/text）
 *   messages           —— **不含 system** 的消息数组（含 system 也不会重复计）
 *   tools              —— 真实下发的 tools 数组（仅当没给 toolSchemaTokens 时用它折算）
 *   toolSchemaTokens   —— 已知的工具面 schema token（`registry.schemaInfo().tokens`，优先用）
 *   toolProjection     —— 运行内累加器：`Map|object<string, {calls, rawTokens, modelTokens}>`
 *   usage              —— 本次响应的 usage（只镜像 cached/miss，计费仍归账本）
 *   previousSections   —— 上一次请求的段落（用于定位「第一个变化的区段」）
 *   cacheMiss          —— 本次是否缓存未命中（true 时才报 firstChangedSection，避免噪音）
 * @returns {object}
 */
function attribute(input = {}) {
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const layers = emptyLayers();
  /** @type {Record<string, {tokens: number, chars: number, stable: boolean, layer: string}>} */
  const bySection = {};
  let stableChars = 0;
  let dynamicChars = 0;
  for (const sec of sections) {
    if (!sec) continue;
    const text = String(sec.text || '');
    const tokens = compaction.estimateTextTokens(text);
    const layer = SECTION_LAYER[sec.id] || 'system_dynamic';
    layers[layer] += tokens;
    if (sec.id) bySection[sec.id] = { tokens, chars: text.length, stable: sec.stable === true, layer };
    if (sec.stable === true) stableChars += text.length;
    else dynamicChars += text.length;
  }
  const guideTokens = bySection.tools ? bySection.tools.tokens : 0;

  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role === 'system' ? 'system' : msg.role === 'assistant' ? 'assistant' : msg.role === 'tool' ? 'tool' : 'user';
    if (role === 'system') continue; // 已按段落计过
    const { tokens, attachments, rag } = messageTokens(msg);
    layers.attachment += attachments;
    const total = tokens + attachments;
    if (role === 'tool') layers.tool_result += total;
    else if (role === 'assistant') layers.history_assistant += total;
    else if (rag) layers.rag += total;
    else layers.history_user += total;
  }

  const schemaTokens = input.toolSchemaTokens != null
    ? Math.max(0, Math.round(Number(input.toolSchemaTokens) || 0))
    : (Array.isArray(input.tools) && input.tools.length ? compaction.estimateTokens([], input.tools) : 0);
  layers.tool_schema += schemaTokens;

  let total = 0;
  for (const layer of LAYERS) total += layers[layer];

  const projection = normalizeProjection(input.toolProjection);
  const compression = normalizeCompression(input.compressionStats);
  const cache = {
    miss: input.cacheMiss === true,
    cachedTokens: numberOrNull(input.cachedTokens),
    missTokens: numberOrNull(input.missTokens),
    /** 缓存未命中时才有值：**第一个变化的 prompt 区段**（P2-2 明确要求的那一格归因） */
    firstChangedSection: input.cacheMiss === true ? firstChangedSection(input.previousSections, sections) : null,
  };

  return {
    layers,
    total,
    bySection,
    stableChars,
    dynamicChars,
    toolSchema: { guideTokens, schemaTokens, total: layers.tool_schema },
    toolProjection: projection,
    compression,
    cache,
  };
}

function numberOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 工具投影累加器归一化：`raw → model`，用于回答「哪类工具的结果最该做确定性裁剪」。
 * @param {Map<string, {calls: number, rawTokens: number, modelTokens: number}>|object|null} input
 */
function normalizeProjection(input) {
  /** @type {Record<string, {calls: number, rawTokens: number, modelTokens: number, savedTokens: number, projectionRate: number|null}>} */
  const byTool = {};
  let rawTokens = 0;
  let modelTokens = 0;
  let calls = 0;
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input || {});
  for (const [name, stat] of entries) {
    if (!stat) continue;
    const raw = Number(stat.rawTokens) || 0;
    const model = Number(stat.modelTokens) || 0;
    const n = Number(stat.calls) || 0;
    byTool[name] = {
      calls: n,
      rawTokens: raw,
      modelTokens: model,
      savedTokens: Math.max(0, raw - model),
      projectionRate: raw > 0 ? Number(((raw - model) / raw).toFixed(4)) : null,
    };
    rawTokens += raw;
    modelTokens += model;
    calls += n;
  }
  return {
    calls,
    rawTokens,
    modelTokens,
    savedTokens: Math.max(0, rawTokens - modelTokens),
    projectionRate: rawTokens > 0 ? Number(((rawTokens - modelTokens) / rawTokens).toFixed(4)) : null,
    byTool,
  };
}

/**
 * 压缩账归一化（P1-3 → P2-2）：回答「每次压缩的 `costTokens` 换来了多少 `futureSavedTokens`」。
 * `netTokensSaved` 是**收益口径**（每轮省 × 剩余轮数 − 成本）；`netTokensImmediate` 是单轮差，两者都给。
 * @param {Map<string, object>|object|null} input
 */
function normalizeCompression(input) {
  /** @type {Record<string, object>} */
  const byTool = {};
  let calls = 0;
  let rawTokens = 0;
  let summaryTokens = 0;
  let savedTokens = 0;
  let costTokens = 0;
  let netTokensSaved = 0;
  let netTokensImmediate = 0;
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input || {});
  for (const [name, stat] of entries) {
    if (!stat) continue;
    const item = {
      calls: Number(stat.calls) || 0,
      rawTokens: Number(stat.rawTokens) || 0,
      summaryTokens: Number(stat.summaryTokens) || 0,
      savedTokens: Number(stat.savedTokens) || 0,
      costTokens: Number(stat.costTokens) || 0,
      netTokensSaved: Number(stat.netTokensSaved) || 0,
      netTokensImmediate: Number(stat.netTokensImmediate) || 0,
    };
    byTool[name] = item;
    calls += item.calls;
    rawTokens += item.rawTokens;
    summaryTokens += item.summaryTokens;
    savedTokens += item.savedTokens;
    costTokens += item.costTokens;
    // 顶层就是各工具累加和的再汇总；两个口径分别汇总，不互相顶替（收益口径≠单轮差）
    netTokensSaved += item.netTokensSaved;
    netTokensImmediate += item.netTokensImmediate;
  }
  return {
    calls,
    rawTokens,
    summaryTokens,
    savedTokens,
    costTokens,
    netTokensSaved: Math.round(netTokensSaved),
    netTokensImmediate: Math.round(netTokensImmediate),
    byTool,
  };
}

/**
 * 第一个**内容发生变化**的段落 id（顺序也按段落表算：新增段算变化，消失段也算）。
 * @param {Array<{id?: string, text?: string}>|null} previous
 * @param {Array<{id?: string, text?: string}>} next
 * @returns {string|null}
 */
function firstChangedSection(previous, next) {
  if (!Array.isArray(previous)) return null; // 首轮没有可比对象 → 不报，不编造
  const prev = new Map(previous.filter(Boolean).map((sec) => [String(sec.id || ''), String(sec.text || '')]));
  for (const sec of Array.isArray(next) ? next : []) {
    if (!sec) continue;
    const id = String(sec.id || '');
    if (!prev.has(id)) return id;
    if (prev.get(id) !== String(sec.text || '')) return id;
    prev.delete(id);
  }
  return prev.size ? [...prev.keys()][0] : null;
}

module.exports = {
  LAYERS,
  SECTION_LAYER,
  RAG_USER_PREFIX,
  IMAGE_TOKENS,
  attribute,
  firstChangedSection,
  normalizeProjection,
  normalizeCompression,
  messageTokens,
};
