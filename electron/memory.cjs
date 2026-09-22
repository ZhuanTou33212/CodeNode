'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { redact } = require('./redaction.cjs');

/** 项目记忆条数上限（#16：超出后**显式**淘汰最旧条目并留审计，不再静默 slice） */
const MAX_MEMORY_ENTRIES = 200;

function memoryPath(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'memory.json');
}

/**
 * 读项目记忆（#16）。
 *
 * 旧实现把**任何**异常都吞成 `{entries: []}` —— 文件被编辑坏 / 截断之后，下一次
 * `remember`（读出 + push + 整体覆盖写）会把整个记忆库替换成 1 条，且无提示无审计。
 *
 * 现在区分三种状态，`entries` 字段保持向后兼容（始终是数组）：
 *   - 文件不存在：`ok:true, exists:false` —— 全新项目，允许写入；
 *   - 可解析：`ok:true, exists:true`；
 *   - 损坏 / 不可读：`ok:false, code:'MEMORY_CORRUPT'|'MEMORY_READ_FAILED'` —— 调用方
 *     （writeMemory）据此**拒绝写入**并保留坏文件。
 */
function readMemory(projectRoot) {
  const file = memoryPath(projectRoot);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, exists: false, entries: [], error: null, file };
    }
    return {
      ok: false,
      exists: true,
      entries: [],
      error: '项目记忆读取失败：' + String((error && (error.message || error.code)) || 'unknown'),
      code: 'MEMORY_READ_FAILED',
      file,
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new Error('缺少 entries 数组');
    }
    return { ok: true, exists: true, entries: parsed.entries, error: null, file };
  } catch (error) {
    return {
      ok: false,
      exists: true,
      entries: [],
      error: '项目记忆文件已损坏（memory.json 解析失败，未做任何写入）：' + String((error && error.message) || error),
      code: 'MEMORY_CORRUPT',
      file,
    };
  }
}

/**
 * 超上限时淘汰最旧条目并留痕（#16：不再静默丢最旧约定）。
 * 审计写 `.codenode/audit.jsonl`（与 ipc/project.cjs 的审计同一形状、同一脱敏口径），
 * 并投一条 `memory_evicted` 到统一事件流；审计是旁路，写不进去也不影响写入结果。
 */
function auditMemoryEviction(projectRoot, evicted, remained) {
  try {
    const root = path.resolve(projectRoot || '.');
    const dir = path.join(root, '.codenode');
    fs.mkdirSync(dir, { recursive: true });
    const ids = evicted.map((entry) => String((entry && entry.id) || '?'));
    require('./runStore.cjs').appendJsonl(path.join(dir, 'audit.jsonl'), {
      ts: new Date().toISOString(),
      type: 'memory_evicted',
      entry: '项目记忆超出上限（' + MAX_MEMORY_ENTRIES + '），已淘汰最旧 ' + evicted.length + ' 条，保留最新 ' + remained + ' 条：' + ids.join(', '),
      evicted: ids,
    });
    require('./eventBus.cjs').bridge(projectRoot, 'memory_evicted', {
      count: evicted.length,
      remained,
      limit: MAX_MEMORY_ENTRIES,
      evicted: ids,
    });
  } catch {
    // 审计失败不能把 remember 打挂
  }
}

/**
 * 写项目记忆（#16 + #15）。三条显式约束：
 *   1. **写入前复核磁盘**：文件存在但不可解析 → 抛错拒绝，原文件一字节不动（绝不静默清空整库）；
 *   2. 超出 MAX_MEMORY_ENTRIES → 最旧优先淘汰，淘汰明细随返回值返回 + 写审计 + 事件流；
 *   3. 落盘前按 `redaction.redact` 脱敏（与 runStore 同一口径）—— `id/key/tags/createdAt`
 *      等结构与统计字段原样保留，检索打分口径不变。
 */
function writeMemory(projectRoot, entries) {
  const file = memoryPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readMemory(projectRoot);
  if (current.exists && !current.ok) {
    throw new Error('拒绝写入项目记忆：' + current.error + '（原文件已保留，请先修复或删除再重试）');
  }
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  const overflow = list.length - MAX_MEMORY_ENTRIES;
  const evicted = overflow > 0 ? list.slice(0, overflow) : [];
  const kept = overflow > 0 ? list.slice(overflow) : list;
  const persisted = kept.map((entry) => redact(entry));
  atomicWriteFile(file, JSON.stringify({ version: 1, entries: persisted }, null, 2) + '\n', 'utf8');
  if (evicted.length) auditMemoryEviction(projectRoot, evicted, persisted.length);
  return {
    ok: true,
    file,
    written: persisted.length,
    evicted: evicted.length,
    evictedIds: evicted.map((entry) => (entry && entry.id) || null),
  };
}

/**
 * 查询分词（第 5 项）：英文/数字按词切，中文按 2-gram —— 和 Java 版 `MemoryStore.recall`
 * 的口径一致（中文没有空格，按 2-gram 才能命中「缓存命中率」这类词）。
 */
function tokenize(query) {
  const text = String(query || '').toLowerCase();
  const terms = new Set();
  for (const word of text.match(/[a-z0-9_]{2,}/g) || []) terms.add(word);
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/**
 * 单条记忆的匹配分：key（人工打的标签，意图最强）×6、tags ×4、content ×2。
 * 纯函数、可测；分数只用于排序，不对外声称「语义相关性」。
 */
function scoreEntry(entry, terms) {
  if (!entry || !terms.length) return 0;
  const key = String(entry.key || '').toLowerCase();
  const content = String(entry.content || '').toLowerCase();
  const tags = Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).toLowerCase()) : [];
  let score = 0;
  for (const term of terms) {
    if (key && key.includes(term)) score += 6;
    if (tags.some((tag) => tag.includes(term))) score += 4;
    if (content.includes(term)) score += 2;
  }
  return score;
}

/**
 * 挑出这次请求要注入的记忆（第 5 项缺陷的修复）。
 *
 * 旧实现是 `entries.slice(-30)` —— **纯按写入时间取最近 30 条**，key/tags 完全不参与：
 * 项目约定写在第 31 条之前就永远进不了提示（等于「写了但读不到」），而最新的 30 条
 * 可能全是无关的临时记录。
 *
 * 现在的口径：按 query（当前用户消息）打分排序取前 limit 条；**一条都没命中时退回最近的
 * limit 条**（保持旧行为，不编造相关性）。返回 matched 字段让调用方能如实标注。
 */
function selectRelevant(entries, query, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && entry.content) : [];
  const limit = Math.max(1, Number(options.limit) || 30);
  const terms = tokenize(query);
  const scored = list.map((entry, index) => ({ entry, index, score: scoreEntry(entry, terms) }));
  const matched = scored.filter((item) => item.score > 0);
  if (!matched.length) {
    return { entries: list.slice(-limit), matched: false, terms, scores: [] };
  }
  matched.sort((a, b) => (b.score - a.score) || (b.index - a.index));
  return {
    entries: matched.slice(0, limit).map((item) => item.entry),
    matched: true,
    terms,
    scores: matched.slice(0, limit).map((item) => ({ id: item.entry.id || null, score: item.score })),
  };
}

/**
 * 与 `compaction.estimateTokens` 同一把尺的纯文本估算（中文按 0.7、其余按 1/4 字符）。
 * 为什么在这里再写一份：memory.cjs 是底层模块（不依赖 compaction），而「注入预算」必须与
 * compaction 的窗口估算用同一个口径 —— 两把尺子会得到「这里够用、那里已超」的假安全感。
 */
function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    }
  }
  const other = [...s].length - cjk;
  return Math.round(cjk * 0.7 + other / 4);
}

/** 自动注入的出厂预算（token 效率审计 §4 P1-2） */
const MEMORY_INJECTION_DEFAULTS = Object.freeze({
  topK: 5,
  maxEntryChars: 400,
  budgetTokens: 2000,
});

/**
 * **自动注入**用（阶段 A / A4）：与 `buildMemoryText`（选择器口径，`recall` 工具与既有用例依赖它）
 * 的关键差别是两条：
 *   1. **有命中才注入**：没有任何关键词命中时返回空串，不再「回退最近 N 条」。
 *      旧口径把与本次提问无关的记忆当成固定税，每轮塞进 system prompt 中部（还破坏稳定前缀）。
 *      模型真要看最近的记忆，有 `recall` 可调 —— 那是显式动作，不是每轮的默认税。
 *      需要旧行为可配 `agent.memory_inject=recent`。
 *   2. **有预算**：单条字符上限 + 整段 token 上限，超出按分数截断并如实标注。
 *
 * @param {Array<any>} entries
 * @param {string} query
 * @param {{limit?: number, maxEntryChars?: number, budgetTokens?: number, requireMatch?: boolean, label?: string}} [options]
 * @returns {{text: string, tokens: number, count: number, matched: boolean, dropped: number, truncated: number}}
 */
function buildMemoryInjection(entries, query, options = {}) {
  const opt = options || {};
  const limit = opt.limit == null ? MEMORY_INJECTION_DEFAULTS.topK : Math.max(0, Math.floor(Number(opt.limit) || 0));
  const maxEntryChars = opt.maxEntryChars == null ? MEMORY_INJECTION_DEFAULTS.maxEntryChars : Math.max(0, Math.floor(Number(opt.maxEntryChars) || 0));
  const budgetTokens = opt.budgetTokens == null ? MEMORY_INJECTION_DEFAULTS.budgetTokens : Math.max(0, Math.floor(Number(opt.budgetTokens) || 0));
  const requireMatch = opt.requireMatch !== false;
  const empty = { text: '', tokens: 0, count: 0, matched: false, dropped: 0, truncated: 0 };
  if (limit === 0 || budgetTokens === 0) return empty;

  const picked = selectRelevant(entries, query, { limit });
  if (!picked.entries.length) return empty;
  if (requireMatch && !picked.matched) return Object.assign({}, empty, { matched: false });

  const label = String(opt.label || '此项目');
  const header = picked.matched ? '' : '（以下为' + label + '最近保存的记忆，未按当前问题检索）\n';
  const lines = [];
  const truncatedNotes = [];
  let tokens = estimateTextTokens(header);
  let dropped = 0;
  let truncated = 0;
  for (const entry of picked.entries) {
    let body = (entry.key ? '[' + entry.key + '] ' : '') + String(entry.content || '');
    if (maxEntryChars > 0 && body.length > maxEntryChars) {
      body = body.slice(0, maxEntryChars) + '…（本条已截断）';
      truncated += 1;
      truncatedNotes.push(String(entry.key || entry.id || '?'));
    }
    const line = '- ' + body + '\n';
    const cost = estimateTextTokens(line);
    if (tokens + cost > budgetTokens) {
      dropped += 1;
      continue;
    }
    tokens += cost;
    lines.push(line);
  }
  if (!lines.length) return empty;

  let text = header + lines.join('');
  if (dropped > 0 || truncated > 0) {
    const notes = [];
    if (dropped > 0) notes.push('另有 ' + dropped + ' 条因预算省略');
    if (truncated > 0) notes.push('有 ' + truncated + ' 条被截断（' + truncatedNotes.join('、') + '）');
    text += '（' + notes.join('；') + '，需要完整内容用 recall 检索）\n';
    tokens = estimateTextTokens(text);
  }
  return { text, tokens, count: lines.length, matched: picked.matched, dropped, truncated };
}

/** 注入到 system prompt 的记忆文本（ipc/agent.cjs 直接用这个，保证与测试同一条代码路径） */
function buildMemoryText(entries, query, options = {}) {
  const picked = selectRelevant(entries, query, options);
  if (!picked.entries.length) return '';
  const lines = picked.entries.map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content}`);
  if (!picked.matched) {
    // 没有任何关键词命中：如实说明这是「最近的记忆」，别让模型以为这是检索结果。
    // `options.label` 让调用方说明范围（项目级 / 用户级跨项目）—— 文案说错范围会误导模型，
    // 例如把用户级记忆写成「此项目」（2026-09-21 用户级记忆落地时实测踩到）。
    const label = String(options.label || '此项目');
    lines.unshift('（以下为' + label + '最近保存的记忆，未按当前问题检索）');
  }
  return lines.join('\n');
}

module.exports = {
  readMemory,
  writeMemory,
  memoryPath,
  MAX_MEMORY_ENTRIES,
  MEMORY_INJECTION_DEFAULTS,
  estimateTextTokens,
  tokenize,
  scoreEntry,
  selectRelevant,
  buildMemoryText,
  buildMemoryInjection,
};
