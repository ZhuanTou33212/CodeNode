/**
 * Narrow, deterministic extraction of explicit preference changes from the current user message.
 * This is not a general fact extractor; unsupported or ambiguous wording leaves memory untouched.
 */
'use strict';

const { memoryKey, memoryKind, memorySlot, memoryStatus } = require('./memoryResolution.cjs');

const VALUES = Object.freeze({
  programming_language: [
    { value: 'typescript', re: /\btypescript\b/i },
    { value: 'javascript', re: /\bjavascript\b/i },
    { value: 'python', re: /\bpython(?:\s*3(?:\.\d+)*)?\b/i },
    { value: 'golang', re: /\bgolang\b/i },
    { value: 'go', re: /\bGo\b/ },
    { value: 'java', re: /\bJava\b/i },
    { value: 'rust', re: /\bRust\b/i },
    { value: 'ruby', re: /\bRuby\b/i },
    { value: 'php', re: /\bPHP\b/i },
    { value: 'swift', re: /\bSwift\b/i },
    { value: 'kotlin', re: /\bKotlin\b/i },
    { value: 'c++', re: /\bC\+\+\b/i },
    { value: 'c#', re: /\bC#\b/i },
  ],
  package_manager: [
    { value: 'pnpm', re: /\bpnpm\b/i },
    { value: 'npm', re: /\bnpm\b/i },
    { value: 'yarn', re: /\byarn\b/i },
    { value: 'bun', re: /\bbun\b/i },
  ],
});

const QUOTED_RE = /“[^”]*”|「[^」]*」|『[^』]*』|«[^»]*»|"[^\"]*"|'[^']*'|`[^`]*`/g;
const ATTRIBUTION_RE = /引用|转述|别人说|有人说|朋友说|同事说|他说|她说|据说|someone\s+(?:said|says)|(?:my\s+)?friend\s+(?:said|says)|quoted/i;
const CHANGE_RE = /改用|换成|切换到|设为|设置为|采用|使用|(?<!调)用(?=\s|[A-Z\p{L}]|$)|\bprefer\b|\buse\b|switch\s+to|set\s+to/iu;
const TEMPORARY_RE = /这次|本次|本轮|今天|临时|仅此任务|this\s+time|for\s+this\s+task|temporarily/i;
const PERMANENT_RE = /以后|今后|从现在起|从今以后|以后都|今后都|长期|永久|from\s+now\s+on|going\s+forward|permanently|as\s+my\s+default/i;
const NEGATION_OR_QUESTION_RE = /不要|别用|不用|不选|不想用|不使用|不改用|不是|要不要|是否|应该.*吗|\b(?:don't|do not|should I|should we|whether)\b|[?？]/i;
const PROJECT_SCOPE_RE = /本项目|这个项目|当前项目|该项目|项目内|in this project|this project/i;
const GLOBAL_SCOPE_RE = /我以后|以后我|今后我|从现在起我|我今后|for me|my default|my preference/i;
const MAX_SESSION_OVERRIDES = 8;

function maskQuoted(text) {
  return String(text || '').replace(QUOTED_RE, (match) => ' '.repeat(match.length));
}

function familyFor(entry) {
  const key = memoryKey(entry && (entry.canonicalKey || entry.key));
  const kind = memoryKind(entry && entry.kind);
  if (['programming_language', 'language'].includes(key) && ['preference', 'note'].includes(kind)) return 'programming_language';
  if (key === 'package_manager' && ['preference', 'note'].includes(kind)) return 'package_manager';
  return '';
}

function recognizedValues(text, family) {
  const found = [];
  for (const item of VALUES[family] || []) {
    const match = item.re.exec(String(text || ''));
    if (match) found.push({ value: item.value, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

function currentValue(entry, family) {
  const explicit = recognizedValues(String((entry && entry.value) || ''), family);
  if (explicit.length === 1) return explicit[0].value;
  const content = recognizedValues(String((entry && entry.content) || ''), family);
  const unique = [...new Set(content.map((item) => item.value))];
  return unique.length === 1 ? unique[0] : '';
}

function persistentScope(clause, records) {
  if (PROJECT_SCOPE_RE.test(clause)) return 'project';
  if (GLOBAL_SCOPE_RE.test(clause)) return 'user';
  const scopes = [...new Set(records.map((entry) => entry.scope === 'project' ? 'project' : 'user'))];
  return scopes.length === 1 ? scopes[0] : 'ambiguous';
}

/**
 * Only an unquoted, direct user assertion with an explicit lifetime and change verb can override a slot.
 * Temporary changes affect this prompt only. Permanent changes become candidates; the remember tool
 * still requires confirmation before persisting them.
 */
function extractSessionMemoryOverrides(prompt, input = {}) {
  const text = maskQuoted(prompt);
  const entries = [
    ...(Array.isArray(input.projectEntries) ? input.projectEntries : []),
    ...(Array.isArray(input.userEntries) ? input.userEntries : []),
  ].filter((entry) => entry && entry.content && memoryStatus(entry) === 'active');
  const overrides = new Map();
  const persistent = new Map();

  for (const rawClause of text.split(/[，,。.!?！？;；\n]+/)) {
    const clause = rawClause.trim();
    if (!clause || ATTRIBUTION_RE.test(clause) || NEGATION_OR_QUESTION_RE.test(clause) || !CHANGE_RE.test(clause)) continue;
    const temporary = TEMPORARY_RE.test(clause);
    const permanent = PERMANENT_RE.test(clause);
    if (temporary === permanent) continue;

    for (const entry of entries) {
      const family = familyFor(entry);
      if (!family) continue;
      const values = recognizedValues(clause, family);
      if (values.length !== 1) continue;
      const value = values[0].value;
      const oldValue = currentValue(entry, family);
      if (!oldValue || oldValue === value) continue;
      const slot = memorySlot(entry);
      if (!slot) continue;
      if (!overrides.has(slot)) overrides.set(slot, {
        scope: 'all', kind: memoryKind(entry.kind), key: String(entry.key || ''),
        value, lifetime: temporary ? 'session' : 'persistent_candidate', source: 'current_user_message',
      });
      if (permanent && !persistent.has(slot)) {
        const sameSlot = entries.filter((candidate) => memorySlot(candidate) === slot);
        persistent.set(slot, {
          scope: persistentScope(clause, sameSlot), kind: memoryKind(entry.kind),
          key: String(entry.key || ''), value, requiresRememberConfirmation: true,
        });
      }
    }
  }

  const allOverrides = [...overrides.values()];
  const selectedOverrides = allOverrides.slice(0, MAX_SESSION_OVERRIDES);
  const selectedSlots = new Set(selectedOverrides.map(memorySlot));
  const result = {
    overrides: selectedOverrides,
    persistentCandidates: [...persistent.entries()].filter(([slot]) => selectedSlots.has(slot)).map(([, value]) => value),
    omittedCount: Math.max(0, allOverrides.length - selectedOverrides.length),
  };
  const textPayload = JSON.stringify(result).replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]);
  return { ...result, text: result.overrides.length ? textPayload : '' };
}

module.exports = { extractSessionMemoryOverrides, familyFor, currentValue, maskQuoted };
