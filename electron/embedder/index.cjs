/**
 * CodeNode 可插拔向量嵌入器（Embedder）。
 *
 * provider：
 *   local   纯本地确定性 n-gram 哈希向量（无网络、无外部服务），默认；
 *   openai  OpenAI 兼容 /embeddings（需 rag.embed_base + rag.embed_key + rag.embed_model）；
 *   ollama  本地 Ollama /api/embeddings（需 rag.embed_base + rag.embed_model）；
 *   none    关闭向量层。
 *
 * 向量维度固定（rag.embed_dim，默认 4096），local 采用「哈希桶 + 正负号」稀疏编码后 L2 归一化，
 * 保证同一文本在不同进程/会话下得到相同向量（确定性）。
 */
'use strict';

const DEFAULTS = Object.freeze({
  provider: 'local',
  dim: 4096,
  model: '',
  base: '',
  key: '',
});

/** FNV-1a 32 位哈希，稳定确定。 */
function hashStr(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 与 RAG 保持一致的分词：ASCII 标识符/路径 + 驼峰拆分 + 中文单/双/三字。 */
function tokenizeText(text) {
  const out = [];
  const src = String(text || '');
  const ascii = src.match(/[A-Za-z][A-Za-z0-9_$.:/#-]*|\d+/g) || [];
  for (const raw of ascii) {
    out.push(raw.toLowerCase());
    for (const part of raw.split(/[^A-Za-z0-9]+/)) {
      if (!part) continue;
      out.push(part.toLowerCase());
      const camel = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
      if (camel.length > 1) for (const item of camel) out.push(item.toLowerCase());
    }
  }
  const cjkRuns = src.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 12) out.push(run);
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
      if (i + 2 < run.length) out.push(run.slice(i, i + 3));
    }
  }
  return out;
}

/** 确定性哈希桶 + 符号编码的稀疏向量，L2 归一化。 */
function localVector(text, dim) {
  const size = Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : DEFAULTS.dim;
  const vec = new Array(size).fill(0);
  for (const token of tokenizeText(text)) {
    const bucket = hashStr(token) % size;
    const sign = hashStr('s:' + token) & 1 ? 1 : -1;
    vec[bucket] += sign;
  }
  let norm = 0;
  for (let i = 0; i < size; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < size; i++) vec[i] = vec[i] / norm;
  return vec;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb) || 1;
  return dot / denom;
}

class Embedder {
  constructor(options) {
    const o = options || {};
    this.provider = String(o.embedProvider || DEFAULTS.provider).toLowerCase().trim();
    this.dim = Number.isFinite(o.embedDim) && o.embedDim > 0 ? Math.floor(o.embedDim) : DEFAULTS.dim;
    this.model = String(o.embedModel || '').trim();
    this.apiKey = String(o.embedKey || '').trim();
    const defaultBase = this.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1';
    this.base = String(o.embedBase || defaultBase).trim().replace(/\/+$/, '');
    // 与主模型共享有界并发队列与请求预算（嵌入也是模型调用，不能绕开统一成本/并发控制）
    this.queue = o.queue || null;
    this.budget = o.budget || null;
    this.onUsage = typeof o.onUsage === 'function' ? o.onUsage : null;
    this.signal = o.signal || null;
  }

  /** 估算 token 数（保守：按字符数 / 3 向上取整），用于嵌入请求的预算预留与记账 */
  estimateTokens(texts) {
    const chars = (Array.isArray(texts) ? texts : [texts]).reduce((sum, text) => sum + String(text || '').length, 0);
    return Math.max(1, Math.ceil(chars / 3));
  }

  _report(kind, model, usage, startedAt) {
    if (!this.onUsage) return;
    try {
      this.onUsage({ kind: kind || 'embedding', model, usage: usage || null, latencyMs: Date.now() - startedAt, runId: /** @type {any} */ (this).runId || null });
    } catch {}
  }

  isLocal() {
    return this.provider === 'local' || this.provider === 'none';
  }

  /** 批量嵌入。local 同步返回；API 提供方为 async 网络调用。 */
  async embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (this.provider === 'openai') return this.embedOpenAi(list);
    if (this.provider === 'ollama') return this.embedOllama(list);
    return list.map((text) => localVector(text, this.dim));
  }

  async embedOpenAi(texts) {
    if (!this.apiKey) throw new Error('openai 嵌入器缺少 rag.embed_key');
    const startedAt = Date.now();
    const release = this.queue ? await this.queue.acquire(this.signal) : null;
    const settle = this.budget ? this.budget.reserve(this.estimateTokens(texts) + 256) : null;
    try {
      return await this.embedOpenAiInner(texts, startedAt, settle);
    } catch (error) {
      if (settle) settle(null);
      throw error;
    } finally {
      if (release) release();
    }
  }

  async embedOpenAiInner(texts, startedAt, settle) {
    const res = await fetch(this.base + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey },
      body: JSON.stringify({ model: this.model || 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('openai 嵌入 HTTP ' + res.status + ': ' + text.slice(0, 200));
    }
    /** @type {any} */
    const data = await res.json();
    if (settle) settle(data.usage || null);
    this._report('embedding', this.model || 'text-embedding-3-small', data.usage || null, startedAt);
    return (data.data || [])
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((item) => item.embedding || []);
  }

  async embedOllama(texts) {
    const out = [];
    const startedAt = Date.now();
    const release = this.queue ? await this.queue.acquire(this.signal) : null;
    const settle = this.budget ? this.budget.reserve(this.estimateTokens(texts) + 256) : null;
    let reported = 0;
    try {
    for (const text of texts) {
      const res = await fetch(this.base + '/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model || 'nomic-embed-text', prompt: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('ollama 嵌入 HTTP ' + res.status + ': ' + body.slice(0, 200));
      }
      /** @type {any} */
      const data = await res.json();
      out.push(data.embedding || []);
      reported += 1;
    }
    } finally {
      // ollama 不返回 usage：按估算结算并标记保守值（不假装免费、也不编造精确值）
      if (settle) settle({ total_tokens: this.estimateTokens(texts) });
      this._report('embedding', this.model || 'nomic-embed-text', { total_tokens: this.estimateTokens(texts), estimated: true }, startedAt);
      if (release) release();
    }
    return out;
  }
}

function createEmbedder(options) {
  return new Embedder(options);
}

module.exports = {
  DEFAULTS,
  Embedder,
  cosine,
  createEmbedder,
  hashStr,
  localVector,
  tokenizeText,
};
