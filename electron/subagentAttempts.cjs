'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { resolveInRoot } = require('./tools/impl/shared.cjs');
const { classify } = require('./sideEffects.cjs');
const { redact } = require('./redaction.cjs');
const FILE_TOOLS = new Set(['write_file', 'edit_file']);
const MAX_BYTES = 8 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
/** @returns {never} */
function fail(message) { throw new Error(message); }
function journalFile(root, executionId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(executionId)) fail('Attempt 执行标识无效');
  const directory = path.join(path.resolve(root), '.codenode', 'runs', 'attempts');
  const file = path.join(directory, executionId + '.json');
  for (const target of [path.join(root, '.codenode'), path.join(root, '.codenode', 'runs'), directory, file]) {
    try { if (fs.lstatSync(target).isSymbolicLink()) fail('Attempt 记录路径不能是符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
function fingerprint(root, relative) {
  const target = resolveInRoot(root, relative);
  if (!target) fail('Attempt 文件路径越界或受保护：' + relative);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail('Attempt 不自动补偿链接或非普通文件：' + relative);
    if (stat.size > MAX_BYTES) fail('Attempt 文件过大，不能安全补偿：' + relative);
    return { sha256: hash(fs.readFileSync(target)), target };
  } catch (error) { if (error.code === 'ENOENT') return { sha256: null, target }; throw error; }
}
function readJournal(root, executionId) {
  const file = journalFile(root, executionId);
  if (fs.statSync(file).size > 16 * 1024 * 1024) fail('Attempt 副作用记录过大');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.version !== 1 || parsed.executionId !== executionId || !Array.isArray(parsed.operations) || !Array.isArray(parsed.files)) fail('Attempt 副作用记录损坏');
  if (parsed.operations.some(item => !item || typeof item.tool !== 'string' || !['pending', 'committed', 'failed', 'unknown', 'skipped'].includes(item.phase) || !Array.isArray(item.paths) || item.paths.some(relative => typeof relative !== 'string'))) fail('Attempt 操作记录损坏');
  const paths = new Set(parsed.operations.flatMap(item => item.paths));
  if (parsed.files.some(item => !item || typeof item.path !== 'string' || !paths.has(item.path)) ||
      [...paths].some(relative => parsed.files.filter(item => item.path === relative).length !== 1)) fail('Attempt 路径与前像记录不一致');
  return { file, data: parsed };
}
function planCompensation(root, executionId) {
  try {
    const { file, data } = readJournal(root, executionId);
    const blocked = data.operations.filter(operation => operation.phase !== 'skipped' &&
      (!FILE_TOOLS.has(operation.tool) || ['pending', 'unknown'].includes(operation.phase)));
    if (blocked.length) return { ok: false, executionId, error: '上次 Attempt 有外部、未知或未结算副作用，必须先复核；禁止自动重做', blocked: blocked.map(item => ({ tool: item.tool, phase: item.phase })), items: [] };
    const touched = new Set(data.operations.filter(item => item.phase !== 'skipped').flatMap(item => item.paths));
    const items = data.files.filter(entry => touched.has(entry.path)).map(entry => {
      if (typeof entry.path !== 'string' || !entry.before || !Object.hasOwn(entry, 'postSha256')) fail('Attempt 文件记录不完整');
      const current = fingerprint(root, entry.path);
      const alreadyRestored = current.sha256 === entry.before.sha256;
      if (!alreadyRestored && current.sha256 !== entry.postSha256) fail('文件在上次 Attempt 后发生变化，禁止覆盖：' + entry.path);
      if (entry.before.sha256 !== null) {
        if (!/^[a-f0-9]{64}$/.test(entry.before.sha256) || typeof entry.before.content !== 'string' || hash(Buffer.from(entry.before.content, 'base64')) !== entry.before.sha256) fail('Attempt 前像缺失或损坏：' + entry.path);
      }
      return { path: entry.path, action: alreadyRestored ? 'skip' : entry.before.sha256 === null ? 'delete' : 'restore', currentSha256: current.sha256, beforeSha256: entry.before.sha256 };
    });
    return { ok: true, executionId, digest: hash(JSON.stringify({ data, items })), items, file };
  } catch (error) { return { ok: false, executionId, error: String(error.message || error), items: [] }; }
}
function compensate(root, executionId, expectedDigest) {
  const plan = planCompensation(root, executionId);
  if (!plan.ok || plan.digest !== expectedDigest) return { ok: false, error: plan.error || '补偿计划已变化，请重新核对', items: [] };
  const { file, data } = readJournal(root, executionId);
  data.compensation = { phase: 'prepared', at: new Date().toISOString(), items: plan.items };
  atomicWriteFile(file, JSON.stringify(data));
  const applied = [];
  try {
    // Preflight every file/blob first; recheck immediately before each mutation.
    for (const item of plan.items) {
      if (item.action === 'skip') continue;
      const current = fingerprint(root, item.path);
      if (current.sha256 !== item.currentSha256) fail('补偿前文件发生变化：' + item.path);
      const entry = data.files.find(candidate => candidate.path === item.path);
      if (item.action === 'delete') fs.unlinkSync(current.target);
      else atomicWriteFile(current.target, Buffer.from(entry.before.content, 'base64'), 'utf8', { expectedSha256: current.sha256 || 'absent' });
      if (fingerprint(root, item.path).sha256 !== item.beforeSha256) fail('补偿写后核验失败：' + item.path);
      applied.push(item.path);
      data.compensation.applied = applied.slice();
      atomicWriteFile(file, JSON.stringify(data));
    }
    data.compensation.phase = 'completed';
    atomicWriteFile(file, JSON.stringify(data));
    return { ok: true, applied, at: data.compensation.at };
  } catch (error) {
    data.compensation.phase = 'needs_review';
    data.compensation.error = redact(String(error.message || error));
    try { atomicWriteFile(file, JSON.stringify(data)); } catch {}
    return { ok: false, applied, error: data.compensation.error };
  }
}

class AttemptJournal {
  constructor(root, taskId, executionId) {
    this.root = root;
    this.file = journalFile(root, executionId);
    if (fs.existsSync(this.file)) fail('Attempt 执行记录已存在，不能覆盖');
    /** @type {{version: number, taskId: string, executionId: string, operations: any[], files: any[]}} */
    this.data = { version: 1, taskId, executionId, operations: [], files: [] };
    this.persist();
  }
  persist() {
    const text = JSON.stringify(this.data);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) fail('Attempt 副作用记录过大，已停止写入');
    atomicWriteFile(this.file, text);
  }
  wrap(parent) {
    return {
      // Keep the parent Run's idempotency ledger and checkpoints; this journal
      // adds per-Attempt preimages and strong content fingerprints.
      begin: async (name, args, actor, options) => {
        if (classify(name) === 'read') return parent ? parent.begin(name, args, actor, options) : { skip: false };
        /** @type {{id: string, tool: string, phase: string, paths: string[]}} */
        const operation = { id: crypto.randomUUID(), tool: name, phase: 'pending', paths: [] };
        if (FILE_TOOLS.has(name)) {
          const candidates = [args.path || args.filePath];
          for (const candidate of new Set(candidates)) {
            if (typeof candidate !== 'string' || !candidate) fail('文件工具缺少可核对路径');
            const relative = path.relative(this.root, path.resolve(this.root, candidate));
            const current = fingerprint(this.root, relative);
            // Bind the tool's write to the same version captured in the preimage.
            if (!args.expectedSha256) args.expectedSha256 = current.sha256 || 'absent';
            if (!this.data.files.some(entry => entry.path === relative)) this.data.files.push({ path: relative,
              before: { sha256: current.sha256, content: current.sha256 === null ? null : fs.readFileSync(current.target).toString('base64') }, postSha256: current.sha256 });
            operation.paths.push(relative);
          }
        }
        this.data.operations.push(operation);
        this.persist();
        let token;
        try { token = parent ? await parent.begin(name, args, actor, options) : { skip: false, effect: classify(name), idemKey: operation.id }; }
        catch (error) { operation.phase = ['EFFECT_UNKNOWN', 'SYSTEM_ERROR'].includes(error.code) ? 'unknown' : 'skipped'; this.persist(); throw error; }
        if (token.skip) { operation.phase = 'skipped'; this.persist(); return token; }
        return { ...token, attemptOperationId: operation.id, parentToken: token };
      },
      commit: async (token, info) => {
        try { if (parent) await parent.commit(token.parentToken || token, info); this.finish(token, 'committed'); }
        catch (error) { this.finish(token, 'unknown'); throw error; }
      },
      fail: async (token, error) => {
        try { if (parent) await parent.fail(token.parentToken || token, error); }
        finally { this.finish(token, error?.failure?.code === 'EFFECT_UNKNOWN' || error?.data?.sideEffectStatus === 'unknown' || error?.code === 'EFFECT_UNKNOWN' ? 'unknown' : 'failed'); }
      },
    };
  }
  finish(token, phase) {
    const operation = this.data.operations.find(item => item.id === token?.attemptOperationId);
    if (!operation) return;
    operation.phase = operation.phase === 'unknown' ? 'unknown' : phase;
    for (const relative of operation.paths) {
      const file = this.data.files.find(entry => entry.path === relative);
      if (!file) fail('Attempt 文件记录缺失');
      file.postSha256 = fingerprint(this.root, relative).sha256;
    }
    this.persist();
  }
}
function attemptHistory(task) {
  const history = Array.isArray(task.attempts) ? task.attempts.slice() : [];
  if (!task.executionId) return history;
  const entry = { attempt: task.attempt || 1, executionId: task.executionId, status: task.status,
    queuedAt: task.queuedAt || null, startedAt: task.startedAt || null, finishedAt: task.finishedAt || null,
    executionSettled: task.executionSettled === true, requiresReview: task.requiresReview === true,
    effectRoot: task.effectRoot || null, compensation: task.compensation || null,
    summary: String(task.summary || '').slice(0, 8000), summaryChars: String(task.summary || '').length,
    summaryDroppedChars: Math.max(0, String(task.summary || '').length - 8000), error: task.error || null,
    resultDigest: task.envelope ? hash(JSON.stringify(task.envelope)) : null, review: task.review || null,
    worktree: task.worktree || null, usage: task.usage || null, sideEffects: task.sideEffects || null };
  const index = history.findIndex(item => item.executionId === entry.executionId);
  if (index < 0) history.push(entry); else history[index] = entry;
  return history;
}
function effectSummary(root, executionId) {
  const { data } = readJournal(root, executionId);
  return { files: data.files.map(file => ({ path: file.path, beforeSha256: file.before.sha256, afterSha256: file.postSha256 })),
    operations: data.operations.map(operation => ({ tool: operation.tool, phase: operation.phase })) };
}
module.exports = { AttemptJournal, planCompensation, compensate, attemptHistory, journalFile, readJournal, effectSummary };
