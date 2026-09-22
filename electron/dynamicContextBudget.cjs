'use strict';
/**
 * dynamicContextBudget.cjs —— 动态上下文段落的**统一 token 预算**（token 效率审计 §4 P1-2）。
 *
 * 问题（审计原文）：「记忆、RAG、画布状态共用一个 `DynamicContextBudget`，避免各模块都认为自己只占一点。」
 * 此前每段各有一套自己的口径（记忆有 2,000 的池子、画布摘要与技能索引**完全没有上限**），
 * 于是「每段看起来都不大」但加起来把固定输入推得很高 —— 而且没有任何一处能回答
 * 「这一轮到底把多少 budget 花在了哪一段」。
 *
 * 这个模块只做一件事：**按优先级把一份总预算分给若干段落**，并且如实记下每段
 * 「想要多少 / 拿到多少 / 为什么只有这么多」。它**不产生文本、不读 IO、不认识任何具体段落** ——
 * 具体怎么裁剪（画布丢节点、技能丢条目）由调用方决定，这里只给额度与理由。
 *
 * 分配规则（确定性，纯函数）：
 *   1. 每段先拿 `minTokens` 保底（保底**优先于总预算**：保底都满足不了的配置是配置错误，
 *      宁可超一点也要把 `overcommit` 如实报出来，绝不静默把某段饿成 0）；
 *   2. 剩余额度按 `priority` 从小到大（数字小 = 更优先；同优先级按输入顺序）依次补齐，
 *      每段最多补到 `min(desired, cap)`；
 *   3. 额度用尽后，还没补满的段 `granted = 已经拿到的`，理由 'trimmed'；被自己 cap 限制的记 'capped'。
 *
 * **不触发时逐字节不变**：每段都 ≤ cap 且合计 ≤ 总量时，`granted === desired`（理由 'full'），
 * 调用方据此可以断言「输出与没有这个预算时完全一样」——这是这套东西能安全上线的根基。
 */

/** 出厂：总预算 6,000 tokens（够大，常见项目不会触发裁剪 → 负向判据成立；不够大时按优先级饿尾段） */
const DEFAULT_TOTAL_TOKENS = 6000;

/**
 * 出厂段落表（审计 P1-2 提到的四段）。优先级与 cap 的取值理由：
 *   - `canvas` 最优先：它是**当前任务的直接输入**，模型看不到画布就等于任务丢了；
 *     但 cap 4,000 兜住「画布很大时把固定输入吃光」，超出时调用方按节点粒度裁剪并留取回提示。
 *   - `memory` 次之：长期偏好类信息，缺了还能 `recall` 补回来；cap 沿用既有 2,000 出厂池（不回归）。
 *   - `skills` 再次：只需索引（名字 + 一句话），真要用正文走 `read_skill`。
 *   - `rag` 最后：检索片段本来就是按需的（多数情况下模型用工具现查）。
 */
/**
 * @typedef {{id: string, priority: number, capTokens: number, minTokens: number}} SectionPreset
 */
/** @type {Record<string, SectionPreset>} */
const SECTION_PRESETS = {
  canvas: { id: 'canvas', priority: 1, capTokens: 4000, minTokens: 0 },
  // 记忆 cap 与既有 `agent.memory_budget_tokens` 出厂值一致（2000）—— 两者都默认时行为**逐字节不变**
  memory: { id: 'memory', priority: 2, capTokens: 2000, minTokens: 0 },
  skills: { id: 'skills', priority: 3, capTokens: 800, minTokens: 0 },
  rag: { id: 'rag', priority: 4, capTokens: 1500, minTokens: 0 },
};
/** 出厂段落表（顺序即声明顺序；分配顺序另由 `priority` 决定） @type {ReadonlyArray<SectionPreset>} */
const DEFAULT_SECTIONS = Object.freeze(Object.keys(SECTION_PRESETS).map((id) => SECTION_PRESETS[id]));

/**
 * @param {{totalTokens?: number, sections?: Array<{id: string, desiredTokens?: number, capTokens?: number, priority?: number, minTokens?: number}>}} [input]
 *   `totalTokens`：0 或缺省=用出厂总预算；**负数/`off` 由调用方在解析配置时转成 0 表示关闭**（本函数不做 IO）。
 *   `sections`：调用方给出**它自己能量到的**每段 desired（例如 `estimateTextTokens(canvasSummary)`），
 *               可以省略 cap/priority（缺省按 id 查 `DEFAULT_SECTIONS`，查不到按 0 cap/最后优先级）。
 * @returns {{totalTokens: number, used: number, overcommit: number, granted: Record<string, number>,
 *            trace: Array<{id: string, desired: number, cap: number, granted: number, reason: string}>}}
 */
function allocateContextBudget(input = {}) {
  const i = input || {};
  const totalTokens = i.totalTokens == null ? DEFAULT_TOTAL_TOKENS : Math.max(0, Math.floor(Number(i.totalTokens) || 0));
  /** @type {Array<{id: string, index: number, desired: number, cap: number, priority: number, minTokens: number}>} */
  const list = [];
  const rawSections = /** @type {Array<any>} */ (Array.isArray(i.sections) ? i.sections : []);
  for (let index = 0; index < rawSections.length; index += 1) {
    /** @type {any} */
    const s = rawSections[index] || {};
    /** @type {{priority: number, capTokens: number, minTokens: number}|null} */
    const preset = SECTION_PRESETS[String(s.id)] || null;
    const desired = Math.max(0, Math.floor(Number(s.desiredTokens) || 0));
    const cap = s.capTokens == null ? (preset ? preset.capTokens : 0) : Math.max(0, Math.floor(Number(s.capTokens) || 0));
    const priority = s.priority == null ? (preset ? preset.priority : 99) : Number(s.priority);
    const minTokens = Math.max(0, Math.floor(Number(s.minTokens == null ? (preset ? preset.minTokens : 0) : s.minTokens) || 0));
    list.push({ id: String(s.id), index, desired, cap, priority, minTokens });
  }

  /** @type {Record<string, number>} */
  const granted = {};
  /** @type {Array<{id: string, desired: number, cap: number, granted: number, reason: string}>} */
  const trace = [];
  for (const s of list) granted[s.id] = 0;

  // ① 保底：每段先拿 minTokens（保底优先于总预算，超了如实记 overcommit）
  let used = 0;
  for (const s of list) {
    const give = Math.min(s.minTokens, s.desired);
    granted[s.id] += give;
    used += give;
  }
  // ② 剩余额度按优先级补齐（同优先级按输入顺序）
  const ordered = list.slice().sort((a, b) => a.priority - b.priority || a.index - b.index);
  for (const s of ordered) {
    const want = Math.min(s.desired, s.cap);
    const already = granted[s.id];
    if (already >= want) continue;
    const room = Math.max(0, totalTokens - used);
    const give = Math.min(want - already, room);
    granted[s.id] += give;
    used += give;
    if (give < want - already) break; // 额度耗尽，后面的段只能拿保底
  }

  for (const s of list) {
    const want = Math.min(s.desired, s.cap);
    const got = granted[s.id];
    /** @type {string} */
    let reason = 'full';
    if (s.desired <= 0) reason = 'empty';
    // 自己的 cap 先咬住（`want` 已经夹过 cap）→ 首要原因是 capped，而不是「总量不够」
    else if (want < s.desired) reason = 'capped';
    else if (got >= s.desired) reason = 'full';
    else if (got > 0) reason = 'trimmed';
    else reason = 'starved';
    trace.push({ id: s.id, desired: s.desired, cap: s.cap, granted: got, reason });
  }
  const overcommit = Math.max(0, used - totalTokens);
  return { totalTokens, used, overcommit, granted, trace };
}

/**
 * 解析 `agent.dynamic_context_*` 配置。
 *
 *   agent.dynamic_context_tokens        = 6000   总预算（0 = **关闭这套预算**，各段退回自己的口径）
 *   agent.dynamic_context_canvas_tokens = 4000   画布摘要 cap
 *   agent.dynamic_context_memory_tokens = 2000   记忆（项目+用户合计）cap（与 `agent.memory_budget_tokens` 取小）
 *   agent.dynamic_context_skills_tokens = 800    技能索引 cap
 *   agent.dynamic_context_rag_tokens    = 1500   RAG 片段 cap
 *
 * @param {Record<string, any>} cfg 扁平的 agent.properties 键值
 */
function parseDynamicContextConfig(cfg) {
  const c = cfg || {};
  const int = (key, dflt, min, max) => {
    const raw = c[key];
    if (raw == null || String(raw).trim() === '') return dflt;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const sections = DEFAULT_SECTIONS.map((s) => ({
    id: s.id,
    priority: s.priority,
    minTokens: s.minTokens,
    capTokens: int('agent.dynamic_context_' + s.id + '_tokens', s.capTokens, 0, 200000),
  }));
  return { totalTokens: int('agent.dynamic_context_tokens', DEFAULT_TOTAL_TOKENS, 0, 400000), sections };
}

module.exports = { DEFAULT_TOTAL_TOKENS, DEFAULT_SECTIONS, allocateContextBudget, parseDynamicContextConfig };
