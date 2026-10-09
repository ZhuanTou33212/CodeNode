'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { atomicWriteFile } = require('../atomicFile.cjs');
const { withFileLock } = require('../fileLock.cjs');
const { resolveInRoot } = require('../tools/impl/shared.cjs');
const { redact } = require('../redaction.cjs');
const trellis = require('./index.cjs');
const limits = require('../../config/trellis.compatibility.json');
const hash = content => createHash('sha256').update(content).digest('hex');
const date = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function internal(root, relative) {
  const full = resolveInRoot(root, '.codenode/trellis-' + relative);
  if (!full) throw new Error('兼容元数据路径不安全');
  let current = full;
  while (current !== path.resolve(root)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('兼容元数据目录不能为链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
  return full;
}
function proposalFile(root, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('无效修改建议编号');
  return internal(root, 'transactions/' + id + '.json');
}
function sharedFile(root, source) {
  if (!/^\.trellis\/(tasks|workspace|spec)\//.test(source)) throw new Error('不支持的共享写回路径');
  const full = trellis.safePath(root, source);
  let current = full;
  while (current !== path.resolve(root)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('共享写回路径不能为链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
  return full;
}
function readShared(root, source, optional = false) {
  const full = sharedFile(root, source);
  if (optional && !fs.existsSync(full)) return { source, content: null, fingerprint: 'absent' };
  const stat = fs.statSync(full);
  if (!stat.isFile() || stat.size > limits.maxJournalBytes) throw new Error('共享文件类型或大小超出写回能力');
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) throw new Error('共享文件不是可识别文本');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes)) throw new Error('共享文件不是有效 UTF-8，保持只读');
  return { source, content, fingerprint: hash(bytes) };
}
function change(doc, after) { return { source: doc.source, before: doc.content, beforeHash: doc.fingerprint, after, afterHash: hash(after) }; }
function summaryText(text, required = true) {
  if (typeof text !== 'string' || (required && !text.trim()) || text.length > limits.maxSummaryChars) throw new Error('摘要必填且长度不能超过 ' + limits.maxSummaryChars);
  const clean = redact(text.trim());
  if (clean !== text.trim()) throw new Error('摘要包含疑似秘密，请移除后重新预览');
  return clean;
}
function preview(root, kind, files, details) {
  if (!files.length || files.some(file => Buffer.byteLength(file.after) > limits.maxJournalBytes)) throw new Error('修改建议为空或超出写回预算');
  const proposal = { version: 1, id: randomUUID(), kind, status: 'proposed', createdAt: new Date().toISOString(), details, files, applied: [], error: null };
  const json = JSON.stringify(proposal, null, 2) + '\n';
  if (Buffer.byteLength(json) > limits.maxJournalBytes * 6) throw new Error('事务记录超过预算，请缩减日志或规范内容');
  atomicWriteFile(proposalFile(root, proposal.id), json);
  return proposal;
}
function proposeTaskUpdate(root, taskPath, input) {
  const task = trellis.readTask(root, taskPath);
  if (task.diagnostics.length || !limits.writableStatuses.includes(task.status) || !limits.writableStatuses.includes(input?.status)) throw new Error('该状态格式不支持无损写回');
  if (task.fingerprint !== input.expectedFingerprint) throw new Error('任务来源已变化，请重新读取后预览');
  const note = summaryText(input.reason);
  if (input.status === 'completed' && input.acceptanceConfirmed !== true) throw new Error('完成状态需要人工明确确认 PRD 验收及未核验项');
  const doc = readShared(root, task.source);
  if (doc.content === null) throw new Error('任务文件不存在');
  if (doc.fingerprint !== task.fingerprint) throw new Error('任务在预览期间已变化');
  const raw = JSON.parse(doc.content.replace(/^\uFEFF/, ''));
  if (raw.completedAt !== undefined && raw.completedAt !== null && typeof raw.completedAt !== 'string') throw new Error('未知 completedAt 格式，保持只读');
  // Preserve the original JSON bytes outside the two supported top-level value spans.
  const spans = topLevelValues(doc.content);
  const statusSpan = spans.get('status');
  if (!statusSpan) throw new Error('无法定位唯一顶层状态，保持只读');
  const edits = [{ ...statusSpan, value: JSON.stringify(input.status) }];
  if (spans.has('completedAt') && task.status !== input.status) edits.push({ ...spans.get('completedAt'), value: input.status === 'completed' ? JSON.stringify(date()) : 'null' });
  let after = doc.content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.value + after.slice(edit.end);
  return preview(root, 'task-status', [change(doc, after)], { taskPath, status: input.status, evidenceType: input.status === 'completed' ? 'explicit-human-acceptance' : 'user-state-update', reason: note });
}
function topLevelValues(content) {
  // Scan JSON tokens independently of formatting. Duplicate top-level keys are read-only.
  JSON.parse(content.replace(/^\uFEFF/, ''));
  const values = new Map();
  let i = content.indexOf('{') + 1;
  const space = () => { while (/\s/.test(content[i] || '') && i < content.length) i++; };
  const stringEnd = start => { let end = start + 1; for (; end < content.length; end++) { if (content[end] === '\\') end++; else if (content[end] === '"') return end + 1; } throw new Error('JSON 字符串损坏'); };
  while (i < content.length) {
    space(); if (content[i] === '}') break;
    if (content[i] === ',') { i++; space(); }
    const end = stringEnd(i), key = JSON.parse(content.slice(i, end)); i = end; space();
    if (content[i++] !== ':') throw new Error('JSON 顶层格式无法识别'); space();
    const start = i;
    let nesting = 0;
    for (; i < content.length; i++) {
      if (content[i] === '"') { i = stringEnd(i) - 1; continue; }
      if ('[{'.includes(content[i])) nesting++;
      if (']}'.includes(content[i])) { if (!nesting) break; nesting--; }
      if (content[i] === ',' && !nesting) break;
    }
    let valueEnd = i; while (/\s/.test(content[valueEnd - 1])) valueEnd--;
    if (values.has(key)) throw new Error('JSON 顶层键重复，保持只读');
    values.set(key, { start, end: valueEnd });
  }
  return values;
}
function workspaces(root) {
  const source = '.trellis/workspace';
  try { return fs.readdirSync(trellis.safePath(root, source), { withFileTypes: true }).filter(item => item.isDirectory() && /^[A-Za-z0-9_-]+$/.test(item.name)).map(item => item.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function markedBlock(content, name) {
  const start = '<!-- @@@auto:' + name + ' -->', end = '<!-- @@@/auto:' + name + ' -->';
  const a = content.indexOf(start), b = content.indexOf(end);
  if (a < 0 || b <= a || content.indexOf(start, a + 1) >= 0 || content.indexOf(end, b + 1) >= 0) throw new Error('未知或重复日志索引标记：' + name + '；保持只读');
  return { start: a + start.length, end: b, body: content.slice(a + start.length, b) };
}
function proposeJournal(root, taskPath, input) {
  const task = trellis.readTask(root, taskPath);
  if (input.expectedFingerprint !== task.fingerprint) throw new Error('任务来源已变化，请重新读取');
  if (!workspaces(root).includes(input.developer)) throw new Error('需要选择已有 Trellis 开发者工作区');
  const summary = summaryText(input.summary), next = summaryText(input.nextSteps || '无', false), verification = summaryText(input.verification || '未核验', false);
  const base = '.trellis/workspace/' + input.developer;
  const index = readShared(root, base + '/index.md');
  if (index.content === null) throw new Error('日志索引不存在');
  const status = markedBlock(index.content, 'current-status');
  const documents = markedBlock(index.content, 'active-documents');
  const history = markedBlock(index.content, 'session-history');
  if (!/^\|\s*File\s*\|\s*Lines\s*\|\s*Status\s*\|\s*$/m.test(documents.body) || !/^\|\s*#\s*\|\s*Date\s*\|\s*Title\s*\|\s*Commits\s*\|\s*Branch\s*\|\s*$/m.test(history.body)) throw new Error('未知日志索引列结构，保持只读');
  const active = status.body.match(/\*\*Active File\*\*:\s*`(journal-([1-9]\d*)\.md)`/);
  const total = status.body.match(/\*\*Total Sessions\*\*:\s*(\d+)/);
  if (!active || !total || !/^\|\s*#\s*\|/m.test(history.body)) throw new Error('不支持的日志索引结构，保持只读');
  const journal = readShared(root, base + '/' + active[1]);
  if (journal.content === null) throw new Error('活动日志不存在');
  if (!/^# Journal - /m.test(journal.content)) throw new Error('不支持的日志标题，保持只读');
  const journalNames = fs.readdirSync(path.dirname(sharedFile(root, base + '/index.md'))).filter(name => /^journal-[1-9]\d*\.md$/.test(name));
  if (journalNames.length > limits.maxEntries) throw new Error('日志文件数量超过扫描预算');
  const numbered = journalNames.flatMap(name => [...String(readShared(root, base + '/' + name).content).matchAll(/^## Session (\d+):/gm)].map(match => Number(match[1])));
  if (Math.max(0, ...numbered) !== Number(total[1]) || new Set(numbered).size !== numbered.length) throw new Error('日志与索引会话编号不一致，请修复后再写回');
  const n = Number(total[1]) + 1, today = date();
  const title = task.title.replace(/[\r\n|]/g, ' ').slice(0, 180);
  const entry = '\n\n## Session ' + n + ': ' + title + '\n\n**Date**: ' + today + '\n**Task**: ' + title + '\n\n### Summary\n\n' + summary + '\n\n### Testing\n\n' + verification + '\n\n### Status\n\n任务状态：' + task.status + '；本记录为交接摘要，不证明工具副作用成功。\n\n### Next Steps\n\n' + next + '\n';
  const eol = journal.content.includes('\r\n') ? '\r\n' : '\n';
  const append = entry.replace(/\n/g, eol);
  let journalLines = limits.maxJournalLines;
  const configPath = '.trellis/config.yaml';
  let configGuard = { source: configPath, fingerprint: 'absent' };
  if (fs.existsSync(trellis.safePath(root, configPath))) {
    const config = trellis.readDocument(root, configPath);
    const declared = config.content.match(/^max_journal_lines:\s*([^\r\n#]+)(?:\s*#.*)?$/m);
    if (declared) {
      const value = Number(declared[1].trim());
      if (!Number.isInteger(value) || value < 20 || value > 10000) throw new Error('max_journal_lines 超出已支持范围，保持只读');
      journalLines = value;
    }
    configGuard = { source: configPath, fingerprint: config.fingerprint };
  }
  let currentName = active[1], currentText = journal.content + append;
  /** @type {{source: string, content: string|null, fingerprint: string}} */
  let currentDoc = journal;
  if (currentText.split(/\r?\n/).length > journalLines) {
    currentName = 'journal-' + (Number(active[2]) + 1) + '.md';
    currentDoc = readShared(root, base + '/' + currentName, true);
    if (currentDoc.content !== null) throw new Error('下一日志文件已存在，请重新核对索引');
    currentText = '# Journal - ' + input.developer + ' (Part ' + (Number(active[2]) + 1) + ')\n\n> AI development session journal\n> Started: ' + today + '\n\n---\n' + entry;
    if (currentText.split(/\r?\n/).length > journalLines) throw new Error('单次日志摘要超过上游轮转行数，需缩减摘要');
  }
  const indexEol = index.content.includes('\r\n') ? '\r\n' : '\n';
  if (!/\*\*Last Active\*\*:\s*[^\r\n]+/.test(status.body)) throw new Error('日志索引缺少 Last Active，保持只读');
  const newStatus = status.body.replace(/(\*\*Active File\*\*:\s*)`[^`]+`/, '$1`' + currentName + '`').replace(/(\*\*Total Sessions\*\*:\s*)\d+/, '$1' + n).replace(/(\*\*Last Active\*\*:\s*)[^\r\n]+/, '$1' + today);
  const rows = history.body.split(/\r?\n/); const header = rows.findIndex(line => /^\|[- |]+\|$/.test(line));
  if (header < 0) throw new Error('日志历史表格无法识别');
  rows.splice(header + 1, 0, '| ' + n + ' | ' + today + ' | ' + title + ' | `-` | `-` |');
  const lines = currentText.split(/\r?\n/).length;
  const fileRow = '| `' + currentName + '` | ~' + lines + ' | Active |';
  const escapedName = currentName.replace(/\./g, '\\.');
  let docBody = documents.body.replace(/\|\s*Active\s*\|/g, '| Archived |');
  const rowPattern = new RegExp('^\\| `'+escapedName+'` \\|.*$', 'm');
  docBody = rowPattern.test(docBody) ? docBody.replace(rowPattern, fileRow) : docBody.trimEnd() + '\n' + fileRow + '\n';
  let indexAfter = index.content;
  for (const edit of [{ ...status, body: newStatus }, { ...history, body: rows.join('\n') }, { ...documents, body: docBody }].sort((a,b) => b.start-a.start)) indexAfter = indexAfter.slice(0, edit.start) + edit.body.replace(/\r?\n/g, indexEol) + indexAfter.slice(edit.end);
  return preview(root, 'journal', [change(currentDoc, currentText), change(index, indexAfter)], { taskPath, developer: input.developer, session: n, taskFingerprint: task.fingerprint, configGuard });
}
function proposeSpecUpdate(root, source, input) {
  if (!/^\.trellis\/spec\/.+\.md$/.test(source)) throw new Error('需要现有规范 Markdown 路径');
  const doc = readShared(root, source);
  if (doc.fingerprint !== input.expectedFingerprint) throw new Error('规范来源已变化');
  const reason = summaryText(input.reason);
  if (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > limits.maxFileBytes || input.content.includes('\0')) throw new Error('规范内容为空或超出预算');
  summaryText(input.content.slice(0, limits.maxSummaryChars));
  if (redact(input.content) !== input.content) throw new Error('规范建议包含疑似秘密');
  return preview(root, 'spec', [change(doc, input.content)], { source, reason, scope: summaryText(input.scope) });
}
function readProposal(root, id) {
  const file = proposalFile(root, id);
  if (fs.statSync(file).size > limits.maxJournalBytes * 6) throw new Error('事务记录过大');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.version !== 1 || p.id !== id || !Array.isArray(p.files) || !p.files.length || p.files.length > 3) throw new Error('事务记录损坏');
  for (const f of p.files) { sharedFile(root, f.source); if (hash(f.after) !== f.afterHash || (f.before === null ? 'absent' : hash(f.before)) !== f.beforeHash) throw new Error('事务文件指纹损坏'); }
  return p;
}
function applyProposal(root, id, action = 'apply', dependencies = {}) {
  const file = proposalFile(root, id);
  return withFileLock(file, () => {
    const p = readProposal(root, id);
    if (!['apply', 'resume', 'rollback'].includes(action)) throw new Error('未知事务恢复动作');
    if ((p.status === 'applied' && action !== 'rollback') || p.status === 'rolled-back') return p;
    if (action === 'apply' && p.status !== 'proposed') throw new Error('该事务需要明确恢复或回滚');
    const writer = dependencies.write || atomicWriteFile;
    const save = () => atomicWriteFile(file, JSON.stringify(p, null, 2) + '\n');
    try {
      if (p.kind === 'journal' && action !== 'rollback' && trellis.readTask(root, p.details.taskPath).fingerprint !== p.details.taskFingerprint) throw new Error('任务来源已变化，日志建议已失效');
      if (p.details.configGuard && action !== 'rollback') {
        const source = p.details.configGuard.source;
        const actual = fs.existsSync(trellis.safePath(root, source)) ? trellis.readDocument(root, source).fingerprint : 'absent';
        if (actual !== p.details.configGuard.fingerprint) throw new Error('上游日志配置已变化，请重新预览');
      }
      const current = p.files.map(f => ({ f, doc: readShared(root, f.source, true) }));
      for (const { f, doc } of current) {
        if (action === 'apply' ? doc.fingerprint !== f.beforeHash : ![f.beforeHash, f.afterHash].includes(doc.fingerprint)) throw new Error('文件存在外部修改，停止覆盖：' + f.source);
      }
      p.status = action === 'rollback' ? 'rolling-back' : 'applying'; p.error = null; save();
      const ordered = action === 'rollback' ? [...p.files].reverse() : p.files;
      for (const f of ordered) {
        const before = readShared(root, f.source, true);
        const desiredHash = action === 'rollback' ? f.beforeHash : f.afterHash;
        const expectedHash = action === 'rollback' ? f.afterHash : f.beforeHash;
        if (before.fingerprint !== desiredHash) {
          if (before.fingerprint !== expectedHash) throw new Error('提交前文件发生外部修改：' + f.source);
          if (action === 'rollback' && f.before === null) {
            if (readShared(root, f.source).fingerprint !== expectedHash) throw new Error('删除回滚前发生冲突');
            fs.unlinkSync(sharedFile(root, f.source));
          } else writer(sharedFile(root, f.source), action === 'rollback' ? f.before : f.after, 'utf8', { expectedSha256: expectedHash });
        }
        p.applied = p.files.filter(item => readShared(root, item.source, true).fingerprint === item.afterHash).map(item => item.source); save();
      }
      p.status = action === 'rollback' ? 'rolled-back' : 'applied'; p.finishedAt = new Date().toISOString(); save();
      return p;
    } catch (error) {
      p.status = 'needs-recovery'; p.error = String(error.message || error);
      p.applied = p.files.filter(f => { try { return readShared(root, f.source, true).fingerprint === f.afterHash; } catch { return false; } }).map(f => f.source); save();
      return p;
    }
  });
}
function listProposals(root) {
  const directory = internal(root, 'transactions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => readProposal(root, name.slice(0, -5))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(({files, ...summary}) => summary);
}
module.exports = { proposeTaskUpdate, proposeJournal, proposeSpecUpdate, applyProposal, listProposals, readProposal, workspaces, internal, date };
