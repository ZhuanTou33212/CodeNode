/**
 * contextBudget.cjs —— 上下文预算（第 1 项缺陷的最小修复）
 *
 * 问题（实测，2026-09-17）：工具结果只受「单条截断（agent.data_truncate_cap）」与「压缩配额
 * （agent.compression.max_calls，按请求数计）」约束，**没有任何按整体上下文的预算与裁剪**。
 * 40 次 27KB 的 read_file 之后，第 11 次模型请求的输入达到 434,743 字符（≈145k tokens），
 * 而压缩配额用完（26/40 条被压缩）后其余原文直接进上下文 —— 结果只有一个：等模型 API 报
 * 「上下文超限」失败，或者把长会话的成本烧穿。
 *
 * 本模块只做一件事：**在每次请求前，把「最旧的、超大的工具结果正文」换成占位符**，直到
 * 整体字符数落回预算内。裁剪刻意保守，三条不破坏协议与可追溯性的硬约束：
 *
 *   1. **不动消息结构**：消息条数、角色顺序、`tool_calls` / `tool_call_id` 配对全部原样保留
 *      —— 只改写 tool 消息的 content 文本。这样就不会造出「孤立 tool 消息」这种会让供应商
 *      直接 400 的形态（这也是不采用「删掉旧消息」/「滑动窗口」的原因：删消息要连带重算配对）。
 *   2. **两档保护**：正常只裁「最近 keepRecent 条之外」的旧结果；**如果单靠这一步仍超预算**
 *      （一轮之内就灌进来 4×27KB 这种），再退一档：除 system 与最后 hardKeepRecent 条之外
 *      都允许裁。两档都保不住时才如实报 overBudget —— 因为那时已经没有别的选择（不改报文大小，
 *      请求本身就会被供应商拒）。
 *   3. **占位符可追溯 + 幂等**：占位符带工具名与原文长度，并告诉模型「需要时用相同参数重取」；
 *      已裁过的占位符不会再被裁剪/重复计数（置换成更短的占位符是纯浪费）。
 *
 * 与既有机制的关系：压缩（S11 批量压缩）是**质量优先**的降级（模型摘要），本模块是**兜底**
 * 的硬预算 —— 压缩配额用尽、压缩失败回退、或压缩被关掉时，上下文依然有界。
 */
'use strict';

/** 占位符标记：既用于人/模型阅读，也用于识别「已裁剪」（幂等） */
const TRIM_MARKER = '【上下文预算裁剪】';

/** 一条消息折成字符数的口径：与 requestBudget 的「按 UTF-8 字节偏保守」同源，这里用字符数近似 */
function messageChars(message) {
  if (!message) return 0;
  const content = message.content;
  let size = typeof content === 'string' ? content.length : content ? JSON.stringify(content).length : 0;
  if (Array.isArray(message.tool_calls)) size += JSON.stringify(message.tool_calls).length;
  if (typeof message.reasoning === 'string') size += message.reasoning.length;
  return size;
}

/** 整段消息的字符总量（裁剪判据、报告用的都是它） */
function estimateChars(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) total += messageChars(message);
  return total;
}

/** 生成占位符：保留工具名、原文规模与「怎么拿回来」 */
function placeholderFor(toolName, originalChars) {
  return (
    TRIM_MARKER +
    '此处原本是 ' +
    (toolName || '工具') +
    ' 的结果（' +
    originalChars +
    ' 字符），为控制上下文体积已省略正文；' +
    '如果确实还需要这份内容，请用**相同参数**重新调用该工具（结果会被重新取回）。'
  );
}

/** 是否已经是占位符（幂等判据） */
function isTrimmed(content) {
  return typeof content === 'string' && content.startsWith(TRIM_MARKER);
}

/**
 * 计算裁剪方案（纯函数，不改入参）。
 *
 * @param {Array<any>} messages 完整消息列表（含 system）
 * @param {{maxChars?: number, keepRecent?: number, minResultChars?: number, hardKeepRecent?: number}} [options]
 * @returns {{ok: boolean, before: number, after: number, overBudget: boolean, maxChars: number, tier: number,
 *            trimmed: Array<{index: number, toolName: string, originalChars: number, placeholderChars: number}>,
 *            plan: Array<{index: number, content: string}>}}
 */
function planTrim(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxChars = Math.max(1000, Number(options.maxChars) || 250000);
  const keepRecent = Math.max(0, Number.isFinite(Number(options.keepRecent)) ? Math.floor(Number(options.keepRecent)) : 12);
  const minResultChars = Math.max(200, Number(options.minResultChars) || 2000);
  const hardKeepRecent = Math.max(0, Number.isFinite(Number(options.hardKeepRecent)) ? Math.floor(Number(options.hardKeepRecent)) : 1);
  const before = estimateChars(list);
  if (before <= maxChars) {
    return { ok: true, before, after: before, overBudget: false, maxChars, tier: 0, trimmed: [], plan: [] };
  }
  let total = before;
  /** @type {Array<{index: number, toolName: string, originalChars: number, placeholderChars: number}>} */
  const trimmed = [];
  /** @type {Array<{index: number, content: string}>} */
  const plan = [];
  /** 已在本次计划里裁过的下标（第二档不能再裁一次，否则会把同一份节省重复计入 → after 变负数） */
  const done = new Set();
  /** 裁一条消息（返回是否真的裁掉） */
  const trimAt = (index) => {
    if (done.has(index)) return false;
    const message = list[index];
    const content = message && typeof message.content === 'string' ? message.content : '';
    if (content.length < minResultChars) return false; // 小结果：裁了也省不了多少，反而丢信息
    if (isTrimmed(content)) return false;
    const placeholder = placeholderFor(message.name || message.toolName || '工具', content.length);
    if (placeholder.length >= content.length) return false; // 占位符更长就没意义
    total -= content.length - placeholder.length;
    done.add(index);
    trimmed.push({ index, toolName: message.name || message.toolName || '', originalChars: content.length, placeholderChars: placeholder.length });
    plan.push({ index, content: placeholder });
    return true;
  };
  // 第一档：只裁「最近 keepRecent 条之外」的旧工具结果
  const protectedFrom = Math.max(0, list.length - keepRecent);
  for (let index = 0; index < list.length && total > maxChars; index++) {
    if (index >= protectedFrom) continue;
    if (!list[index] || list[index].role !== 'tool') continue;
    trimAt(index);
  }
  // 第二档：仍然超预算（一轮就灌进来好几个大结果）→ 除 system 与最后 hardKeepRecent 条外都允许裁
  let tier = 1;
  if (total > maxChars) {
    tier = 2;
    const hardFrom = Math.max(1, list.length - hardKeepRecent);
    for (let index = 1; index < hardFrom && total > maxChars; index++) {
      if (!list[index] || list[index].role !== 'tool') continue;
      trimAt(index);
    }
  }
  return { ok: true, before, after: total, overBudget: total > maxChars, maxChars, tier, trimmed, plan };
}

/**
 * 应用裁剪方案（就地改写 tool 消息的 content；结构、顺序、配对一概不动）。
 * @param {Array<any>} messages
 * @param {{maxChars?: number, keepRecent?: number, minResultChars?: number, hardKeepRecent?: number}} [options]
 * @returns {{trimmed: number, before: number, after: number, overBudget: boolean, maxChars: number, tier: number,
 *            details: Array<{index: number, toolName: string, originalChars: number, placeholderChars: number}>}}
 */
function applyTrim(messages, options = {}) {
  const result = planTrim(messages, options);
  for (const item of result.plan) {
    messages[item.index].content = item.content;
  }
  return { trimmed: result.plan.length, before: result.before, after: result.after, overBudget: result.overBudget, maxChars: result.maxChars, tier: result.tier, details: result.trimmed };
}

module.exports = { TRIM_MARKER, isTrimmed, placeholderFor, estimateChars, messageChars, planTrim, applyTrim };
