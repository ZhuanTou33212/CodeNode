/**
 * userMemory.cjs —— 用户级（跨项目）长期记忆
 *
 * 短板（对照文档 §5 #7）：此前只有**项目级**记忆（`<project>/.codenode/memory.json`），
 * 「我用 pnpm 不用 npm」「提交署名用 yimi528」这类**跨项目**的偏好每换一个项目就要重讲一遍
 * —— Java 版有 `UserMemoryStore`，Electron 版没有。
 *
 * 口径：
 *   - 文件：`$CODENODE_HOME/user-memory.json`（默认 `~/.codenode/user-memory.json`）；
 *     `CODENODE_HOME` 可注入，测试与打包环境不污染真实家目录。
 *   - 结构：`{version:1, entries:[{id, key, content, tags, createdAt}]}`，上限 200 条（与项目级同口径）。
 *   - 注入：按当前提问打分检索（复用项目级的 `memory.selectRelevant`），**不是**时间切片。
 *   - 写操作一律显式（`remember` 工具的 `scope:'user'`），不自动沉淀 —— 跨项目污染比漏记更难收拾。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectRelevant, buildMemoryText, buildMemoryInjection } = require('./memory.cjs');

const MAX_USER_MEMORY_ENTRIES = 200;

/** 记忆根目录（`CODENODE_HOME` 可覆盖，便于测试与隔离） */
function userHome() {
  const override = String(process.env.CODENODE_HOME || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.codenode');
}

function userMemoryPath() {
  return path.join(userHome(), 'user-memory.json');
}

/** @returns {{version: number, entries: Array<any>}} */
function readUserMemory() {
  try {
    const file = userMemoryPath();
    if (!fs.existsSync(file)) return { version: 1, entries: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries.filter((e) => e && e.content) : [];
    return { version: 1, entries };
  } catch {
    // 坏文件当空（不挡住 Agent），下一次写入时覆盖
    return { version: 1, entries: [] };
  }
}

/**
 * 覆盖写入（原子；超出上限时丢最旧的）。
 * @param {Array<any>} entries
 */
function writeUserMemory(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.content).slice(-MAX_USER_MEMORY_ENTRIES);
  const file = userMemoryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return list;
}

/**
 * 追加一条（同 key 且内容相同视为重复，返回 `duplicate: true` 而不重复写）。
 * @param {{key?: string, content: string, tags?: string[]}} entry
 */
function addUserMemory(entry) {
  const content = String((entry && entry.content) || '').trim();
  if (!content) return { ok: false, error: 'EMPTY_CONTENT' };
  const key = String((entry && entry.key) || '');
  const current = readUserMemory();
  const dup = current.entries.find((e) => String(e.content || '').trim() === content);
  if (dup) return { ok: true, duplicate: true, id: dup.id, entries: current.entries.length };
  const record = {
    id: 'umem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    key,
    content,
    tags: Array.isArray(entry && entry.tags) ? entry.tags.map(String) : [],
    createdAt: new Date().toISOString(),
  };
  const list = writeUserMemory([...current.entries, record]);
  return { ok: true, duplicate: false, id: record.id, entries: list.length };
}

/** 注入文本（按 query 打分；一条都没命中时退回最近 N 条，与项目级同口径） */
function buildUserMemoryText(query, options) {
  const data = readUserMemory();
  return buildMemoryText(data.entries, query, Object.assign({ label: '用户级（跨项目）记忆' }, options || {}));
}

/**
 * **自动注入**用（阶段 A / A4）：与项目级同口径 —— 有命中才注入 + 单条/整段预算。
 * `budgetTokens` 由调用方按「项目级用掉多少」传剩下的额度（两类记忆共用一个预算池）。
 * @param {string} query
 * @param {{limit?: number, maxEntryChars?: number, budgetTokens?: number, requireMatch?: boolean, label?: string}} [options]
 */
function buildUserMemoryInjection(query, options) {
  const data = readUserMemory();
  return buildMemoryInjection(data.entries, query, Object.assign({ label: '用户级（跨项目）记忆' }, options || {}));
}

module.exports = {
  MAX_USER_MEMORY_ENTRIES,
  userHome,
  userMemoryPath,
  readUserMemory,
  writeUserMemory,
  addUserMemory,
  buildUserMemoryText,
  selectRelevant,
  buildUserMemoryInjection,
};
