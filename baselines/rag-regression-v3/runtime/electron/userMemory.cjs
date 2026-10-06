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
 *   - v1/v2 旧库可读；新写入为 version:3，当前值与历史分库存放，各自设上限。
 *   - 注入：按当前提问打分检索（复用项目级的 `memory.selectRelevant`），**不是**时间切片。
 *   - 写操作一律显式（`remember` 工具的 `scope:'user'`），不自动沉淀 —— 跨项目污染比漏记更难收拾。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { withFileLock } = require('./fileLock.cjs');
const { redact } = require('./redaction.cjs');
const { selectRelevant: selectMemoryRelevant, buildMemoryText, buildMemoryInjection } = require('./memory.cjs');
const { upsertMemory, memoryStatus } = require('./memoryResolution.cjs');

const MAX_USER_MEMORY_ENTRIES = 200;
const MAX_USER_MEMORY_HISTORY_ENTRIES = 2000;

/** 保留旧导出接口，同时固定用户级作用域。 */
function selectRelevant(entries, query, options = {}) {
  return selectMemoryRelevant(entries, query, { ...options, scope: 'user' });
}

/** 记忆根目录（`CODENODE_HOME` 可覆盖，便于测试与隔离） */
function userHome() {
  const override = String(process.env.CODENODE_HOME || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.codenode');
}

function userMemoryPath() {
  return path.join(userHome(), 'user-memory.json');
}

/** 读取失败不阻塞自动注入，但必须保留错误状态，禁止随后覆盖原文件。 */
function readUserMemory() {
  const file = userMemoryPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { version: 3, revision: 0, ok: true, exists: false, entries: [], activeEntries: [], historyEntries: [], error: null, file };
    }
    return { version: 1, ok: false, exists: true, entries: [], code: 'MEMORY_READ_FAILED',
      error: '用户级记忆读取失败：' + String((error && (error.message || error.code)) || 'unknown'), file };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries) ||
        (Number(parsed.version) >= 3 && parsed.history != null && !Array.isArray(parsed.history))) {
      throw new Error('缺少 entries 数组');
    }
    const all = parsed.entries.concat(Array.isArray(parsed.history) ? parsed.history : []);
    if (all.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new Error('entries/history 中存在非对象记录');
    }
    const valid = all.filter((entry) => entry.content);
    const activeEntries = valid.filter((entry) => memoryStatus(entry) === 'active');
    const historyEntries = valid.filter((entry) => memoryStatus(entry) !== 'active');
    return { version: Number(parsed.version) || 1,
      revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
      ok: true, exists: true, entries: historyEntries.concat(activeEntries),
      activeEntries, historyEntries, error: null, file };
  } catch (error) {
    return { version: 1, ok: false, exists: true, entries: [], code: 'MEMORY_CORRUPT',
      error: '用户级记忆文件已损坏（原文件已保留，请先修复后重试）：' + String((error && error.message) || error), file };
  }
}

/** 淘汰只记录 ID 和数量，不把记忆正文复制到审计；旁路失败不影响已完成的写入。 */
function auditUserMemoryEviction(file, evicted, remained) {
  try {
    require('./runStore.cjs').appendJsonl(path.join(path.dirname(file), 'audit.jsonl'), {
      ts: new Date().toISOString(),
      type: 'memory_evicted',
      scope: 'user',
      count: evicted.length,
      remained,
      limit: MAX_USER_MEMORY_ENTRIES,
      evicted: evicted.map((entry) => String(entry.id || '?')),
    });
  } catch {
    // 审计失败不能把 remember 打挂
  }
}

function auditUserMemoryHistoryPruned(file, pruned, remained) {
  try {
    require('./runStore.cjs').appendJsonl(path.join(path.dirname(file), 'audit.jsonl'), {
      ts: new Date().toISOString(), type: 'memory_history_pruned', scope: 'user',
      count: pruned.length, remained, limit: MAX_USER_MEMORY_HISTORY_ENTRIES,
      pruned: pruned.map((entry) => String(entry.id || '?')),
    });
  } catch {}
}

/** 先复核磁盘，再脱敏、原子替换；返回淘汰明细供 remember 展示。 */
function persistUserMemoryUnlocked(entries, options = {}) {
  const current = readUserMemory();
  if (!current.ok) throw new Error('拒绝写入用户级记忆：' + current.error);
  if (options.expectedRevision != null && current.revision !== options.expectedRevision) {
    const error = /** @type {Error & {code?: string}} */ (new Error('用户级记忆在确认期间已变化，请重新读取后再保存'));
    error.code = 'MEMORY_CONFLICT';
    throw error;
  }
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.content);
  const active = list.filter((entry) => memoryStatus(entry) === 'active');
  const history = list.filter((entry) => memoryStatus(entry) !== 'active');
  const overflow = Math.max(0, active.length - MAX_USER_MEMORY_ENTRIES);
  const evicted = active.slice(0, overflow);
  const persistedActive = active.slice(overflow).map((entry) => redact(entry));
  const historyOverflow = Math.max(0, history.length - MAX_USER_MEMORY_HISTORY_ENTRIES);
  const historyPruned = history.slice(0, historyOverflow);
  const persistedHistory = history.slice(historyOverflow).map((entry) => redact(entry));
  const revision = current.revision + 1;
  atomicWriteFile(current.file, JSON.stringify({ version: 3, revision, entries: persistedActive, history: persistedHistory }, null, 2) + '\n', 'utf8');
  if (evicted.length) auditUserMemoryEviction(current.file, evicted, persistedActive.length);
  if (historyPruned.length) auditUserMemoryHistoryPruned(current.file, historyPruned, persistedHistory.length);
  return { entries: persistedHistory.concat(persistedActive), activeEntries: persistedActive,
    historyEntries: persistedHistory, revision, evicted: evicted.length,
    evictedIds: evicted.map((entry) => entry.id || null), historyPruned: historyPruned.length,
    historyPrunedIds: historyPruned.map((entry) => entry.id || null) };
}

/**
 * 安全覆盖写入（保持原有返回数组的接口；超上限时淘汰最旧并留审计）。
 * @param {Array<any>} entries
 */
function writeUserMemory(entries) {
  return withFileLock(userMemoryPath(), () => persistUserMemoryUnlocked(entries).entries);
}

/**
 * 同槽位写入新版本；内容、标签与生效时间都相同时返回 duplicate，不重复落盘。
 * @param {{key?: string, kind?: string, content: string, value?: string, tags?: string[]}} entry
 */
function addUserMemory(entry, options = {}) {
  const content = redact(String((entry && entry.content) || '').trim());
  if (!content) return { ok: false, error: 'EMPTY_CONTENT' };
  try {
    return withFileLock(userMemoryPath(), () => {
      const current = readUserMemory();
      if (!current.ok) return { ok: false, error: current.error, code: current.code, file: current.file };
      const next = upsertMemory(current.entries, {
        ...entry,
        key: redact(String((entry && entry.key) || '').trim()),
        content,
        value: entry && entry.value != null ? redact(String(entry.value)) : undefined,
        tags: entry && Array.isArray(entry.tags) ? entry.tags.map((tag) => redact(String(tag))) : [],
      }, { scope: 'user', ...options });
      if (!next.ok) return next;
      if (next.duplicate) return { ok: true, duplicate: true, id: next.record.id, version: next.record.version || 1,
        entries: current.activeEntries.length, replacedIds: [], evicted: 0, evictedIds: [] };
      const result = persistUserMemoryUnlocked(next.entries, { expectedRevision: current.revision });
      return { ok: true, duplicate: false, id: next.record.id, version: next.record.version,
        entries: result.activeEntries.length, history: result.historyEntries.length,
        replacedIds: next.replacedIds, evicted: result.evicted, evictedIds: result.evictedIds,
        historyPruned: result.historyPruned, historyPrunedIds: result.historyPrunedIds };
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error),
      code: error && error.code || 'MEMORY_WRITE_FAILED', file: userMemoryPath() };
  }
}

/** 注入文本（按 query 打分；一条都没命中时退回最近 N 条，与项目级同口径） */
function buildUserMemoryText(query, options) {
  const data = readUserMemory();
  return buildMemoryText(data.entries, query, { label: '用户级（跨项目）记忆', ...(options || {}), scope: 'user' });
}

/**
 * **自动注入**用（阶段 A / A4）：与项目级同口径 —— 有命中才注入 + 单条/整段预算。
 * `budgetTokens` 由调用方按「项目级用掉多少」传剩下的额度（两类记忆共用一个预算池）。
 * @param {string} query
 * @param {{limit?: number, maxEntryChars?: number, budgetTokens?: number, requireMatch?: boolean, label?: string}} [options]
 */
function buildUserMemoryInjection(query, options) {
  const data = readUserMemory();
  return buildMemoryInjection(data.entries, query, { label: '用户级（跨项目）记忆', ...(options || {}), scope: 'user' });
}

module.exports = {
  MAX_USER_MEMORY_ENTRIES,
  MAX_USER_MEMORY_HISTORY_ENTRIES,
  userHome,
  userMemoryPath,
  readUserMemory,
  writeUserMemory,
  addUserMemory,
  buildUserMemoryText,
  selectRelevant,
  buildUserMemoryInjection,
};
