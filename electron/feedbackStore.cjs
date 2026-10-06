'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redaction.cjs');
const { appendJsonl } = require('./runStore.cjs');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT = 12000;
function feedbackFile(root) { return path.join(path.resolve(root || '.'), '.codenode', 'feedback.jsonl'); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function normalize(root, input = {}) {
  const verdict = ['accept', 'reject', 'retry', 'report'].includes(String(input.verdict)) ? String(input.verdict) : null;
  if (!verdict) return { ok: false, error: '反馈类型无效' };
  const content = redact(String(input.content || '')).slice(0, MAX_CONTENT);
  if (!content) return { ok: false, error: '缺少可审核的回答内容' };
  const correction = redact(String(input.correction || '')).slice(0, 4000);
  const inputText = redact(String(input.input || '')).slice(0, MAX_CONTENT);
  const source = { projectRoot: path.resolve(root || '.'), sessionId: String(input.sessionId || '').slice(0, 120), runId: String(input.runId || '').slice(0, 120), messageDigest: digest({ role: input.role || 'assistant', content, tools: input.tools || [] }) };
  const record = { version: 1, id: digest({ verdict, source, inputText, correction }), ts: new Date().toISOString(), verdict, status: 'candidate', source, input: inputText || null, content, correction: correction || null,
    tools: Array.isArray(input.tools) ? input.tools.slice(0, 50).map((tool) => ({ name: String(tool && tool.name || '').slice(0, 120), ok: tool && tool.ok === true ? true : tool && tool.ok === false ? false : null, failureCode: String(tool && (tool.failureCode || tool.code) || '').slice(0, 80) || null })) : [] };
  return { ok: true, record };
}
function read(root) {
  const out = [];
  try { for (const line of fs.readFileSync(feedbackFile(root), 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; try { const item = JSON.parse(line); if (item && item.id) out.push(item); } catch {} } }
  catch (error) { if (error && error.code !== 'ENOENT') return { ok: false, error: String(error.message || error), records: [] }; }
  return { ok: true, records: out };
}
function add(root, input) {
  if (!root) return { ok: false, error: '未选择项目' };
  const parsed = normalize(root, input); if (!parsed.ok) return parsed;
  const current = read(root); if (!current.ok) return current;
  const record = parsed.record;
  if (!record) return { ok: false, error: '反馈记录无效' };
  if (current.records.some((item) => item.id === record.id)) return { ok: true, duplicate: true, record };
  const file = feedbackFile(root);
  try { if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) return { ok: false, error: '反馈候选文件已达上限，请先导出并归档' }; return appendJsonl(file, record, MAX_BYTES) ? { ok: true, duplicate: false, record } : { ok: false, error: '反馈候选无法持久化' }; }
  catch (error) { return { ok: false, error: String(error.message || error) }; }
}
function exportDataset(root, options = {}) {
  const current = read(root); if (!current.ok) return current;
  const records = options.reviewedOnly === true ? current.records.filter((item) => item.status === 'reviewed' && item.expectedOutput) : current.records.filter((item) => options.includeReviewed === true || item.status === 'candidate');
  return { ok: true, count: records.length, dataset: records.map((item) => ({ id: item.id, source: item.source, verdict: item.verdict, input: item.input || (item.source.sessionId ? 'session:' + item.source.sessionId : ''), output: item.content, expectedOutput: item.expectedOutput || null, correction: item.correction, tools: item.tools })) };
}
function review(root, id, expectedOutput, reviewer = 'user') {
  const current = read(root); if (!current.ok) return current;
  const index = current.records.findIndex((item) => item.id === String(id || ''));
  if (index < 0) return { ok: false, error: '反馈候选不存在' };
  const expected = redact(String(expectedOutput || '')).slice(0, MAX_CONTENT);
  if (!expected) return { ok: false, error: '审核时必须填写期望输出或修正说明' };
  current.records[index] = { ...current.records[index], status: 'reviewed', expectedOutput: expected, reviewedBy: String(reviewer || 'user').slice(0, 120), reviewedAt: new Date().toISOString() };
  try {
    const file = feedbackFile(root); fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = current.records.map((item) => JSON.stringify(redact(item))).join('\n') + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: '审核后反馈文件超过上限' };
    fs.writeFileSync(file + '.tmp', text, 'utf8'); fs.renameSync(file + '.tmp', file);
    return { ok: true, record: current.records[index] };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}
module.exports = { feedbackFile, normalize, read, add, review, exportDataset };
