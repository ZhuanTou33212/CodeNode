/**
 * 记忆槽位与版本裁决。旧记录没有这些字段时仍视为有效的 note；无 key 的记录保持追加语义。
 * 这里仅处理结构化记录，绝不从自由文本猜测用户是否要求永久修改记忆。
 */
'use strict';

const { randomUUID } = require('crypto');

const KINDS = new Set(['note', 'preference', 'fact', 'decision']);
const KEY_ALIASES = Object.freeze({
  pkg_manager: 'package_manager',
  package_mgr: 'package_manager',
  '包管理器': 'package_manager',
  '常用包管理器': 'package_manager',
  coding_language: 'programming_language',
  programming_lang: 'programming_language',
  preferred_language: 'programming_language',
  preferred_lang: 'programming_language',
  preferred_programming_language: 'programming_language',
  language_preference: 'programming_language',
  '编程语言': 'programming_language',
  '常用编程语言': 'programming_language',
  '首选编程语言': 'programming_language',
});

function memoryKind(value) {
  const kind = String(value || 'note').trim().toLowerCase();
  return KINDS.has(kind) ? kind : 'note';
}

function memoryKey(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  const key = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_.]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return KEY_ALIASES[key] || key;
}

/** 同一作用域内的稳定槽位；没有 key 的便笺不参与互相取代。 */
function memorySlot(entry) {
  const key = memoryKey(entry && (entry.canonicalKey || entry.key));
  return key ? memoryKind(entry && entry.kind) + '\u0000' + key : '';
}

function memoryStatus(entry) {
  if (!entry) return 'inactive';
  if (entry.status === 'superseded') return 'superseded';
  if (entry.is_active === false) return 'inactive';
  if (entry.status == null) return 'active'; // v1 旧记录
  return entry.status === 'active' ? 'active' : 'inactive';
}

function memoryVersion(entry) {
  const n = Number(entry && entry.version);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function memoryTime(entry) {
  const n = Date.parse(String((entry && (entry.validFrom || entry.updatedAt || entry.createdAt)) || ''));
  return Number.isFinite(n) ? n : 0;
}

function newer(a, b) {
  const av = memoryVersion(a.entry);
  const bv = memoryVersion(b.entry);
  if (av !== bv) return av > bv;
  const at = memoryTime(a.entry);
  const bt = memoryTime(b.entry);
  return at !== bt ? at > bt : a.index > b.index;
}

/**
 * 每个 scope + kind + key 只返回一条当前有效记忆。项目层传入 excludedSlots 可屏蔽
 * 同槽位的全局默认值；sessionOverrides 只屏蔽本轮旧值，不会写入长期库。
 */
function resolveMemory(entries, options = {}) {
  const scope = options.scope === 'user' ? 'user' : 'project';
  const list = Array.isArray(entries) ? entries : [];
  const excluded = new Set(Array.isArray(options.excludedSlots) ? options.excludedSlots : []);
  for (const override of Array.isArray(options.sessionOverrides) ? options.sessionOverrides : []) {
    if (override && (!override.scope || override.scope === scope || override.scope === 'all')) {
      const slot = memorySlot(override);
      if (slot) excluded.add(slot);
    }
  }
  if (options.includeHistory === true) {
    return { entries: list.filter((entry) => entry && entry.content), suppressed: [], conflicts: [] };
  }

  const chosen = new Map();
  const unkeyed = [];
  const suppressed = [];
  const conflicts = [];
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (!entry || !entry.content) continue;
    if ((entry.scope && entry.scope !== scope) || memoryStatus(entry) !== 'active') {
      suppressed.push(entry);
      continue;
    }
    const slot = memorySlot(entry);
    if (slot && excluded.has(slot)) {
      suppressed.push(entry);
      continue;
    }
    if (!slot) {
      unkeyed.push({ entry, index });
      continue;
    }
    const prior = chosen.get(slot);
    if (!prior) {
      chosen.set(slot, { entry, index });
      continue;
    }
    if (String(prior.entry.content) !== String(entry.content)) {
      conflicts.push({ slot, ids: [prior.entry.id || null, entry.id || null] });
    }
    if (newer({ entry, index }, prior)) {
      suppressed.push(prior.entry);
      chosen.set(slot, { entry, index });
    } else {
      suppressed.push(entry);
    }
  }
  const selected = [...unkeyed, ...chosen.values()].sort((a, b) => a.index - b.index);
  return { entries: selected.map((item) => item.entry), suppressed, conflicts };
}

function currentSlot(entries, input, scope) {
  const slot = memorySlot(input);
  if (!slot) return null;
  return resolveMemory(entries, { scope }).entries.find((entry) => memorySlot(entry) === slot) || null;
}

/** 未指定 kind 时沿用该 key 唯一的有效类型；存在多种类型则要求调用方说清楚。 */
function inferMemoryKind(entries, key, scope, requestedKind) {
  if (requestedKind != null && String(requestedKind).trim()) return { ok: true, kind: memoryKind(requestedKind) };
  const normalized = memoryKey(key);
  if (!normalized) return { ok: true, kind: 'note' };
  const kinds = new Set((Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (!entry.scope || entry.scope === scope) &&
      memoryStatus(entry) === 'active' && memoryKey(entry.key) === normalized)
    .map((entry) => memoryKind(entry.kind)));
  if (kinds.size > 1) {
    return { ok: false, code: 'MEMORY_AMBIGUOUS_KIND',
      error: '该 key 下存在多种记忆类型，请指定 kind 后再更新' };
  }
  return { ok: true, kind: kinds.values().next().value || 'note' };
}

/** 纯函数：生成一个新版本，并将同槽位的旧有效版本标为 superseded。 */
function upsertMemory(entries, input, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const scope = options.scope === 'user' ? 'user' : 'project';
  const content = String((input && input.content) || '').trim();
  if (!content) return { ok: false, code: 'EMPTY_CONTENT', error: '记忆内容不能为空' };
  const validFromRaw = String((input && input.validFrom) || '').trim();
  const validFromTime = validFromRaw ? Date.parse(validFromRaw) : null;
  if (validFromRaw && !Number.isFinite(validFromTime)) {
    return { ok: false, code: 'INVALID_VALID_FROM', error: 'validFrom 必须是可解析的日期时间' };
  }
  const validFrom = validFromRaw ? new Date(validFromTime).toISOString() : '';
  const tags = Array.isArray(input && input.tags) ? input.tags.map(String) : [];
  const key = String((input && input.key) || '').trim();
  const value = input && input.value != null ? String(input.value).trim() : '';
  const inferred = inferMemoryKind(list, key, scope, input && input.kind);
  if (!inferred.ok) return inferred;
  const kind = inferred.kind;
  const slot = memorySlot({ key, kind });
  const prior = slot ? currentSlot(list, { key, kind }, scope) : null;
  if (slot && Object.prototype.hasOwnProperty.call(options, 'expectedRecordId') &&
      String((prior && prior.id) || '') !== String(options.expectedRecordId || '')) {
    return { ok: false, code: 'MEMORY_CONFLICT', error: '确认期间该记忆已变化，请重新读取并确认' };
  }
  const duplicate = slot
    ? prior && String(prior.content).trim() === content &&
      String(prior.value || '').trim() === value &&
      String(prior.validFrom || '') === validFrom &&
      JSON.stringify(Array.isArray(prior.tags) ? prior.tags : []) === JSON.stringify(tags)
    : list.find((entry) => entry && !memorySlot(entry) && memoryStatus(entry) === 'active' && String(entry.content).trim() === content);
  if (duplicate) {
    return { ok: true, duplicate: true, record: duplicate, entries: list, replacedIds: [] };
  }

  const now = new Date().toISOString();
  const id = String((input && input.id) || (scope === 'user' ? 'umem-' : 'mem-') + randomUUID());
  const related = slot ? list.filter((entry) => entry && memorySlot(entry) === slot && (!entry.scope || entry.scope === scope)) : [];
  const version = related.length ? Math.max(...related.map(memoryVersion)) + 1 : 1;
  const replacedIds = [];
  const updated = list.map((entry) => {
    if (!slot || !entry || memorySlot(entry) !== slot || (entry.scope && entry.scope !== scope) || memoryStatus(entry) !== 'active') return entry;
    if (entry.id) replacedIds.push(String(entry.id));
    return { ...entry, status: 'superseded', is_active: false, supersededBy: id, updatedAt: now };
  });
  const record = {
    id, scope, kind, key, canonicalKey: memoryKey(key), content,
    ...(value ? { value } : {}),
    tags,
    source: String((input && input.source) || 'remember_tool'),
    ...(input && input.sourceRef ? { sourceRef: String(input.sourceRef) } : {}),
    ...(input && input.sourceMessageId ? { sourceMessageId: String(input.sourceMessageId) } : {}),
    confirmedAt: String((input && input.confirmedAt) || now),
    status: 'active', version,
    ...(prior && prior.id ? { supersedesId: String(prior.id) } : {}),
    ...(validFrom ? { validFrom } : {}),
    createdAt: now, updatedAt: now,
  };
  updated.push(record);
  return { ok: true, duplicate: false, record, entries: updated, replacedIds };
}

module.exports = { memoryKind, memoryKey, memorySlot, memoryStatus, resolveMemory, currentSlot, inferMemoryKind, upsertMemory };
