/**
 * CodeNode 本地标量存储（ScalarStore）。
 *
 * 用途：画布节点等「精准、结构化、需按需查询」的数据不随工具结果返回云端，
 * 而是以 键值标量 记录在工程本地 .codenode/scalars.json，由 Agent 通过
 * query_scalars 工具按 key / prefix 精确查询。
 *
 * 特性：
 * - 零网络：全部本地持久化；
 * - 原子写入（临时文件 + rename），避免写坏工程；
 * - 与 RAG 文件索引隔离（.codenode 目录被 RAG 硬排除），标量内容不会泄漏进检索；
 * - 按 projectRoot 缓存单例，跨工具调用共享。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tokenizeText } = require('../embedder/index.cjs');

const STORE_CACHE = new Map();

/** 标量语义搜索的去停用词：过滤无信息量中文/虚词。 */
const SEARCH_STOP = new Set([
  '一个', '什么', '如何', '怎么', '怎样', '为什么', '是否', '这个', '那个', '以及', '进行', '相关',
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们', '请', '给', '把',
  '让', '有', '与', '和', '或', '及', '被', '对', '从', '为', '其', '该', '哪', '个', '中', '于',
  '都', '也', '很', '等', '要', '用', '找', '查', '看', '获取', '返回', '列出', '的，', '一下',
]);

/** 属性别名：查询中出现这些词时，对应单属性记录（node:<id>:<attr>）获得加权。 */
const ATTR_ALIASES = [
  ['prompt', ['prompt', '提示', '提示词', '提示内容']],
  ['label', ['label', 'name', '名字', '名称', '标题', '标签']],
  ['goal', ['goal', '目标']],
  ['status', ['status', '状态']],
  ['members', ['members', '成员', '子节点']],
  ['variables', ['variables', '变量']],
  ['role', ['role', '角色']],
  ['category', ['category', '分类', '类别']],
  ['filePath', ['filepath', '文件路径']],
  ['position', ['position', '位置', '坐标']],
];

/** 提取有信息量的查询词（与 RAG 分词保持一致，过滤停用词与单字）。 */
function searchTerms(query) {
  const seen = new Set();
  const out = [];
  for (const token of tokenizeText(String(query || ''))) {
    if (token.length < 2 || SEARCH_STOP.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 单个标量记录与查询的匹配打分。
 * 分数构成：精确 key 命中 +1000；key 子串 +120；值/词频覆盖率 ×100；属性词加权 +60；label 精确值 +50。
 */
function scoreScalarEntry(key, entry, searchable, qLower, terms) {
  const keyLower = String(key).toLowerCase();
  let score = 0;
  let exact = false;
  const matchedTerms = [];
  if (keyLower === qLower) {
    score += 1000;
    exact = true;
  } else if (qLower.includes(keyLower) || keyLower.includes(qLower)) {
    score += 120;
  }
  if (terms.length) {
    let matched = 0;
    for (const term of terms) {
      if (searchable.terms.has(term) || searchable.text.includes(term)) {
        matched++;
        matchedTerms.push(term);
      }
    }
    score += (matched / terms.length) * 100;
  }
  for (const [attr, aliases] of ATTR_ALIASES) {
    if (!keyLower.endsWith(':' + attr)) continue;
    if (aliases.some((alias) => qLower.includes(alias))) score += 60;
  }
  if (/^node:[\w-]+:label$/.test(keyLower) && terms.some((term) => searchable.text === term)) score += 50;
  return { score, matchedTerms, exact };
}

/** 节点 → 标量记录列表。key 形如 node:<id>（完整属性）与 node:<id>:<attr>（单属性）。 */
function nodeToScalarRecords(node) {
  const records = [];
  if (!node || !node.id) return records;
  const d = node.data || {};
  const attrs = {};
  for (const key of ['label', 'subtitle', 'status', 'goal', 'prompt', 'filePath', 'role', 'name', 'category', 'accent', 'muted', 'collapsed', 'objectName', 'parentId', 'memberBadge']) {
    if (d[key] != null) attrs[key] = d[key];
  }
  if (Array.isArray(d.members)) attrs.members = d.members;
  if (Array.isArray(d.childIds)) attrs.childIds = d.childIds;
  if (Array.isArray(d.variables)) attrs.variables = d.variables;
  const position = node.position ? { x: Math.round(node.position.x || 0), y: Math.round(node.position.y || 0) } : null;
  if (position) attrs.position = position;
  const value = {
    id: node.id,
    type: node.type || 'task',
    ...attrs,
  };
  const idKey = 'node:' + node.id;
  const ts = Date.now();
  records.push({ key: idKey, value, kind: 'node', ts });
  for (const [attr, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v) || v == null) {
      records.push({ key: idKey + ':' + attr, value: v, kind: 'node', ts });
    }
  }
  return records;
}

class ScalarStore {
  constructor(root) {
    this.root = path.resolve(root || '.');
    this.file = path.join(this.root, '.codenode', 'scalars.json');
    this.records = new Map(); // key -> { kind, value, ts }
    this.loaded = false;
    this.searchCache = new Map(); // key -> { text, terms }，供 search() 复用
  }

  load() {
    if (this.loaded) return this.records;
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const data = JSON.parse(raw);
      const map = data && typeof data === 'object' ? data.records || data : {};
      this.records = new Map();
      for (const [key, entry] of Object.entries(map)) {
        if (entry && typeof entry === 'object' && 'value' in entry) {
          this.records.set(key, { kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0 });
        } else {
          this.records.set(key, { kind: 'scalar', value: entry, ts: 0 });
        }
      }
    } catch {
      this.records = new Map();
    }
    this.loaded = true;
    this.searchCache = new Map();
    return this.records;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = { version: 1, updatedAt: new Date().toISOString(), records: {} };
      for (const [key, entry] of this.records) {
        payload.records[key] = { kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0 };
      }
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  set(key, value, kind) {
    this.load();
    const k = String(key);
    this.records.set(k, { kind: kind || 'scalar', value, ts: Date.now() });
    this.searchCache.delete(k);
    this.save();
    return true;
  }

  setMany(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    this.load();
    let count = 0;
    const ts = Date.now();
    for (const item of records) {
      if (!item || item.key == null) continue;
      const k = String(item.key);
      this.records.set(k, { kind: item.kind || 'scalar', value: item.value, ts: item.ts || ts });
      this.searchCache.delete(k);
      count++;
    }
    this.save();
    return count;
  }

  get(key) {
    this.load();
    const entry = this.records.get(String(key));
    return entry ? entry.value : undefined;
  }

  has(key) {
    this.load();
    return this.records.has(String(key));
  }

  /** 精确 key 优先；无精确命中时按 prefix 前缀匹配。
   * 兼容写法：prefix=node:<部分id> 严格前缀无命中时，会按「同类型 key 的 id 是否包含该片段」回退，
   * 从而命中 node:start-<部分id>-xxxx（修复“节点明明存在却查不到”的误判）。 */
  query({ key, prefix, max } = {}) {
    this.load();
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 50;
    const out = [];
    if (key != null && String(key).trim() !== '') {
      const exact = String(key).trim();
      const entry = this.records.get(exact);
      if (entry) out.push({ key: exact, kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0, exact: true });
    }
    if (prefix != null && String(prefix).trim() !== '') {
      const pre = String(prefix).trim();
      const strictKeys = [...this.records.keys()]
        .filter((k) => k.startsWith(pre))
        .sort((a, b) => a.localeCompare(b));
      for (const k of strictKeys) {
        if (out.some((item) => item.key === k)) continue;
        const entry = this.records.get(k);
        out.push({ key: k, kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0, exact: false });
        if (out.length >= limit) break;
      }
      // 严格前缀无命中时：node:<部分id> 命中 node:<type>-<部分id>-<rand>
      if (strictKeys.length === 0) {
        const kindMatch = /^(node|edge|project|task|tool|file|stage|scope):(.+)$/.exec(pre);
        if (kindMatch && kindMatch[2]) {
          const kind = kindMatch[1] + ':';
          const idPart = kindMatch[2];
          const containsKeys = [...this.records.keys()]
            .filter((k) => k.startsWith(kind) && k.slice(kind.length).includes(idPart))
            .sort((a, b) => a.localeCompare(b));
          for (const k of containsKeys) {
            if (out.some((item) => item.key === k)) continue;
            const entry = this.records.get(k);
            out.push({ key: k, kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0, exact: false });
            if (out.length >= limit) break;
          }
        }
      }
    }
    return out;
  }

  all() {
    this.load();
    return [...this.records.entries()]
      .map(([key, entry]) => ({ key, kind: entry.kind || 'scalar', value: entry.value, ts: entry.ts || 0 }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  keys() {
    this.load();
    return [...this.records.keys()].sort((a, b) => a.localeCompare(b));
  }

  remove(key) {
    this.load();
    const k = String(key);
    const removed = this.records.delete(k);
    if (removed) {
      this.searchCache.delete(k);
      this.save();
    }
    return removed;
  }

  removePrefix(prefix) {
    this.load();
    const pre = String(prefix || '');
    let removed = 0;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(pre)) {
        this.records.delete(key);
        this.searchCache.delete(key);
        removed++;
      }
    }
    if (removed) this.save();
    return removed;
  }

  /** 缓存单条记录的搜索文本与词集。 */
  searchableFor(key, entry) {
    let cached = this.searchCache.get(key);
    if (cached) return cached;
    const value = entry.value;
    let searchable;
    if (typeof value === 'string') searchable = key + ' ' + value;
    else if (value == null) searchable = key + ' ' + String(value);
    else searchable = key + ' ' + JSON.stringify(value);
    const text = searchable.toLowerCase();
    cached = { text, terms: new Set(tokenizeText(text)) };
    this.searchCache.set(key, cached);
    return cached;
  }

  /**
   * 语义搜索：无需知道精确 key，按名字/具体数据/prompt 等自然语言匹配标量记录。
   * 返回 [{ key, kind, value, ts, score, matchedTerms, exact }]，按分数降序。
   * 精确 key 命中（node:n1 等）会获得极高分数并被标记 exact=true。
   */
  search({ query, max, minScore, kinds } = {}) {
    this.load();
    const q = String(query || '').trim();
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 20;
    if (!q) return [];
    const terms = searchTerms(q);
    const qLower = q.toLowerCase();
    const out = [];
    for (const [key, entry] of this.records) {
      if (kinds && Array.isArray(kinds) && kinds.length && !kinds.includes(entry.kind)) continue;
      const searchable = this.searchableFor(key, entry);
      const { score, matchedTerms, exact } = scoreScalarEntry(key, entry, searchable, qLower, terms);
      if (score <= 0) continue;
      out.push({
        key,
        kind: entry.kind || 'scalar',
        value: entry.value,
        ts: entry.ts || 0,
        score: Number(score.toFixed(2)),
        matchedTerms,
        exact,
      });
    }
    out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    const filtered = Number.isFinite(minScore) ? out.filter((item) => item.score >= minScore) : out;
    return filtered.slice(0, limit);
  }

  summary() {
    this.load();
    let nodes = 0;
    let edges = 0;
    let other = 0;
    for (const entry of this.records.values()) {
      if (entry.kind === 'node') nodes++;
      else if (entry.kind === 'edge') edges++;
      else other++;
    }
    return { total: this.records.size, nodes, edges, other };
  }
}

/** 按工程根获取单例标量存储（缓存），目录不存在时返回 null。 */
function getScalarStore(root) {
  const resolved = path.resolve(String(root || '.'));
  let store = STORE_CACHE.get(resolved);
  if (!store) {
    store = new ScalarStore(resolved);
    STORE_CACHE.set(resolved, store);
  }
  return store;
}

function clearScalarCache() {
  STORE_CACHE.clear();
}

module.exports = {
  ScalarStore,
  clearScalarCache,
  getScalarStore,
  nodeToScalarRecords,
};
