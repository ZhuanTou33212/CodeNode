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
 * 行为与重构前 LocalRagIndex 内联实现完全一致：local 提供方按块记忆化，
 * API 提供方（openai/ollama）一次批量请求，避免逐块往返。
 */
'use strict';

const { cosine } = require('../embedder/index.cjs');

class MemoryVectorStore {
  constructor(options) {
    const o = options || {};
    this.kind = 'memory';
    // 无 ANN：只对 BM25 预筛出的候选打分，全库扫描在内存后端没有收益
    this.prefiltered = true;
    this.vectors = new Map();
    this.cachedHits = 0;
    this.computed = 0;
  }

  /** 同步清理指定块向量：文件变更/删除时调用（保持 refresh() 的同步语义）。 */
  dropLocal(relative, chunkIds) {
    let removed = 0;
    for (const id of chunkIds || []) {
      if (this.vectors.delete(id)) removed += 1;
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
    const memo = this.vectors.get(chunk.id);
    if (memo) {
      this.cachedHits += 1;
      return memo;
    }
    const [computed] = await embedder.embed([chunk.path + '\n' + chunk.content]);
    if (!computed) return null;
    this.vectors.set(chunk.id, computed);
    this.computed += 1;
    return computed;
  }

  async scoreCandidates(query, candidates, embedder) {
    const out = new Map();
    if (!embedder || !Array.isArray(candidates) || !candidates.length) return out;
    if (embedder.isLocal()) {
      const [queryVec] = await embedder.embed([query]);
      if (!queryVec) return out;
      for (const chunk of candidates) {
        const vec = await this.chunkVector(chunk, embedder);
        if (vec) out.set(chunk.id, Math.max(0, cosine(queryVec, vec)));
      }
      return out;
    }
    const vectors = await embedder.embed([query, ...candidates.map((chunk) => chunk.path + '\n' + chunk.content)]);
    const queryVec = vectors[0];
    for (let i = 0; i < candidates.length; i += 1) {
      const vec = vectors[i + 1];
      if (queryVec && vec) out.set(candidates[i].id, Math.max(0, cosine(queryVec, vec)));
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
    };
  }

  async close() {
    this.vectors.clear();
  }
}

function createMemoryVectorStore(options) {
  return new MemoryVectorStore(options);
}

module.exports = { MemoryVectorStore, createMemoryVectorStore };
