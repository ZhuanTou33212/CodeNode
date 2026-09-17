'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');

function memoryPath(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'memory.json');
}

function readMemory(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath(projectRoot), 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeMemory(projectRoot, entries) {
  const file = memoryPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify({ version: 1, entries: entries.slice(-200) }, null, 2) + '\n', 'utf8');
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

/** 注入到 system prompt 的记忆文本（ipc/agent.cjs 直接用这个，保证与测试同一条代码路径） */
function buildMemoryText(entries, query, options = {}) {
  const picked = selectRelevant(entries, query, options);
  if (!picked.entries.length) return '';
  const lines = picked.entries.map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content}`);
  if (!picked.matched) {
    // 没有任何关键词命中：如实说明这是「最近的记忆」，别让模型以为这是检索结果
    lines.unshift('（以下为此项目最近保存的记忆，未按当前问题检索）');
  }
  return lines.join('\n');
}

module.exports = { readMemory, writeMemory, memoryPath, tokenize, scoreEntry, selectRelevant, buildMemoryText };
