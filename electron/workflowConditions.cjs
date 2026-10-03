'use strict';

const OPS = new Set(['equals', 'not_equals', 'contains', 'truthy', 'falsy']);
function normalize(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !OPS.has(String(raw.op || ''))) throw new Error('条件边 DSL 无效：op 必须是 equals/not_equals/contains/truthy/falsy');
  const path = String(raw.path || 'output');
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(path)) throw new Error('条件边 DSL path 无效');
  if (!['truthy', 'falsy'].includes(raw.op) && (typeof raw.value !== 'string' && typeof raw.value !== 'number' && typeof raw.value !== 'boolean')) throw new Error('条件边 DSL value 无效');
  return { op: String(raw.op), path, ...(raw.value === undefined ? {} : { value: raw.value }) };
}
function get(value, path) { return String(path || 'output').split('.').reduce((current, key) => current == null ? undefined : current[key], value); }
function evaluate(condition, output) {
  const c = normalize(condition); if (!c) return true;
  const actual = get({ output }, c.path);
  if (c.op === 'truthy') return !!actual;
  if (c.op === 'falsy') return !actual;
  if (c.op === 'contains') return String(actual == null ? '' : actual).includes(String(c.value));
  if (c.op === 'equals') return actual === c.value || String(actual) === String(c.value);
  return !(actual === c.value || String(actual) === String(c.value));
}
function completionCheck(condition, output) {
  if (condition && typeof condition === 'object') return { enforced: true, ok: evaluate(condition, output), reason: '结构化条件' };
  const text = String(condition || '').trim();
  const contains = /^contains\s*:\s*(.+)$/i.exec(text);
  if (contains) return { enforced: true, ok: String(output || '').includes(contains[1]), reason: 'contains' };
  const equals = /^equals\s*:\s*(.*)$/i.exec(text);
  if (equals) return { enforced: true, ok: String(output || '') === equals[1], reason: 'equals' };
  return { enforced: false, ok: true, reason: '自然语言条件需人工核对' };
}
module.exports = { normalize, evaluate, completionCheck };
