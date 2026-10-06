/**
 * 内存向量后端（默认，零外部服务）。
 *
 * 契约（与 milvus 后端保持一致，见 vectorStore/index.cjs 的说明）：
 *   kind / prefiltered        后端标识与「是否只对 BM25 预筛候选打分」
 *   dropLocal(rel, chunkIds)  同步：清理进程内记忆化向量（refresh() 内同步调用）
 *   applyChanges(change, emb) 异步：把增删落到后端（memory 无外部存储 → 惰性，交给 scoreCandidates）
 *   chunkVector(chunk, emb)   取/算单块向量（记忆化）
 *   scoreCandidates(q, cand, emb) 查询向量 vs 候选块向量的余弦
 *   stats() / close()
 *
 * 块向量按 id 记忆化；远端嵌入按有界批次请求，文件变更时清除旧向量。
 */
'use strict';

const { cosine } = require('../embedder/index.cjs');
const { createHash } = require('node:crypto');

class MemoryVectorStore {
  constructor(options) {
    const o = options || {};
    this.kind = 'memory';
    // No ANN. The caller may supply a full bounded learned-embedding corpus or lexical candidates.
    this.prefiltered = true;
    this.vectors = new Map();
    this.cacheKeys = new Map();
    this.latestKeys = new Map();
    this.epochs = new Map();
    this.inflight = new Map();
    this.storeEpoch = 0;
    this.maxVectors = Math.max(32, Math.min(5000, Math.floor(Number(o.maxVectors) || 2048)));
    this.embedBatchSize = 32;
    this.cachedHits = 0;
    this.computed = 0;
  }

  /** 同步清理指定块向量：文件变更/删除时调用（保持 refresh() 的同步语义）。 */
  dropLocal(relative, chunkIds) {
    this.epochs.set(relative, (this.epochs.get(relative) || 0) + 1);
    let removed = 0;
    for (const id of chunkIds || []) {
      if (this.vectors.delete(id)) removed += 1;
      this.cacheKeys.delete(id); this.latestKeys.delete(id);
    }
    return removed;
  }

  /**
   * 内存后端没有外部存储：向量按需计算，无需预写。
   *
   * @param {{ deleted?: any[], upserted?: any[] }} [change]
   * @param {any} [embedder]
   */
  async applyChanges(change, embedder) {
    void change;
    void embedder;
    return { backend: this.kind, inserted: 0, deleted: 0, lazy: true };
  }

  async chunkVector(chunk, embedder) {
    if (!chunk || !embedder) return null;
    const vectors = await this.ensureDocuments([chunk], embedder);
    return vectors.get(chunk.id) || null;
  }

  remember(id, vector, key) {
    this.vectors.delete(id);
    this.vectors.set(id, vector);
    this.cacheKeys.set(id, key);
    while (this.vectors.size > this.maxVectors) {
      const oldest = this.vectors.keys().next().value;
      if (this.latestKeys.get(oldest) === this.cacheKeys.get(oldest)) this.latestKeys.delete(oldest);
      this.vectors.delete(oldest); this.cacheKeys.delete(oldest);
    }
  }

  async ensureDocuments(chunks, embedder) {
    const family = JSON.stringify([embedder.provider, embedder.model, embedder.base, embedder.dim,
      embedder.dimensions, embedder.queryPrefix, embedder.documentPrefix]);
    const wanted = chunks.map((chunk) => {
      const text = chunk.searchText || chunk.path + '\n' + chunk.content;
      const key = this.storeEpoch + ':' + (this.epochs.get(chunk.path) || 0) + ':' + chunk.id + ':' +
        createHash('sha256').update(family + '\n' + text).digest('hex');
      this.latestKeys.set(chunk.id, key);
      return { chunk, key, text };
    });
    const budget = embedder.budget || null, signal = embedder.signal || null;
    const cached = new Map();
    const pending = new Map();
    const fresh = [];
    for (const item of wanted) {
      if (this.cacheKeys.get(item.chunk.id) === item.key && this.vectors.has(item.chunk.id)) {
        const vector = this.vectors.get(item.chunk.id);
        this.vectors.delete(item.chunk.id); this.vectors.set(item.chunk.id, vector);
        cached.set(item.chunk.id, vector); this.cachedHits++;
      } else {
        const shared = (this.inflight.get(item.key) || []).find((entry) => entry.budget === budget && entry.signal === signal);
        if (shared) pending.set(item.chunk.id, shared.promise);
        else fresh.push(item);
      }
    }
    if (fresh.length) {
      const work = (async () => {
        signal?.throwIfAborted();
        const vectors = await embedder.embed(fresh.map((item) => item.text), { inputType: 'document' });
        signal?.throwIfAborted();
        if (!Array.isArray(vectors) || vectors.length !== fresh.length || vectors.some((vector) =>
          !Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite))) throw new Error('内存向量后端：嵌入数量或数值无效');
        for (let index = 0; index < fresh.length; index++) {
          const item = fresh[index];
          if (this.latestKeys.get(item.chunk.id) === item.key) this.remember(item.chunk.id, vectors[index], item.key);
          this.computed++;
        }
        return vectors;
      })();
      for (let index = 0; index < fresh.length; index++) {
        const item = fresh[index];
        const entry = { budget, signal, promise: work.then((vectors) => vectors[index]) };
        entry.promise = entry.promise.finally(() => {
          const remaining = (this.inflight.get(item.key) || []).filter((candidate) => candidate !== entry);
          if (remaining.length) this.inflight.set(item.key, remaining); else this.inflight.delete(item.key);
          if (!remaining.length && this.latestKeys.get(item.chunk.id) === item.key && this.cacheKeys.get(item.chunk.id) !== item.key) this.latestKeys.delete(item.chunk.id);
        });
        const entries = this.inflight.get(item.key) || [];
        entries.push(entry); this.inflight.set(item.key, entries);
        pending.set(item.chunk.id, entry.promise);
      }
    }
    const resolved = await Promise.all(wanted.map(async (item) => [item.chunk.id,
      cached.get(item.chunk.id) || await pending.get(item.chunk.id)]));
    return new Map(resolved);
  }

  async scoreCandidates(query, candidates, embedder, options) {
    void options;
    const out = new Map();
    if (!embedder || !Array.isArray(candidates) || !candidates.length) return out;
    if (embedder.isLocal()) {
      const [queryVec] = await embedder.embed([query], { inputType: 'query' });
      if (!Array.isArray(queryVec) || !queryVec.length || !queryVec.every(Number.isFinite)) throw new Error('内存向量后端：查询向量无效');
      for (const chunk of candidates) {
        const vec = await this.chunkVector(chunk, embedder);
        if (vec) out.set(chunk.id, Math.max(0, cosine(queryVec, vec)));
      }
      return out;
    }
    const [queryVec] = await embedder.embed([query], { inputType: 'query' });
    if (!Array.isArray(queryVec) || !queryVec.length || !queryVec.every(Number.isFinite)) throw new Error('内存向量后端：查询向量无效');
    for (let start = 0; start < candidates.length; start += this.embedBatchSize) {
      const batch = candidates.slice(start, start + this.embedBatchSize);
      const vectors = await this.ensureDocuments(batch, embedder);
      for (const chunk of batch) {
        const vec = vectors.get(chunk.id);
        if (!vec) continue;
        if (vec.length !== queryVec.length) throw new Error('查询与文档向量维度不一致');
        out.set(chunk.id, Math.max(0, cosine(queryVec, vec)));
      }
    }
    return out;
  }

  async stats() {
    return {
      backend: this.kind,
      external: false,
      persisted: false,
      vectors: this.vectors.size,
      memoHits: this.cachedHits,
      computed: this.computed,
      maxVectors: this.maxVectors,
      pending: [...this.inflight.values()].reduce((sum, entries) => sum + entries.length, 0),
    };
  }

  async close() {
    this.storeEpoch++;
    this.vectors.clear(); this.cacheKeys.clear(); this.latestKeys.clear(); this.epochs.clear();
  }
}

function createMemoryVectorStore(options) {
  return new MemoryVectorStore(options);
}

module.exports = { MemoryVectorStore, createMemoryVectorStore };
