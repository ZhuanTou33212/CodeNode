/**
 * 向量后端工厂。
 *
 * `rag.vector_store` 决定 chunk 向量的存放与检索方式：
 *   memory（默认）  进程内记忆化 + BM25 预筛后逐候选余弦；零外部服务、零网络，行为与历史版本一致。
 *   milvus         外部 Milvus 服务：chunk 向量写入 collection，检索走全库 ANN（不再依赖 BM25 预筛）。
 *
 * 统一契约（两个后端都实现）：
 *   kind                      'memory' | 'milvus'
 *   prefiltered               true=只对 BM25 预筛候选打分；false=全库语义检索（命中可能不在 BM25 候选内）
 *   dropLocal(rel, chunkIds)  同步清理进程内记忆化（memory 有实际作用，milvus no-op）
 *   async applyChanges({deleted, upserted}, embedder)  把文件增删落到后端（memory 惰性 no-op）
 *   async chunkVector(chunk, embedder)                 单块向量（memory 记忆化，milvus 返回 null）
 *   async scoreCandidates(query, candidates, embedder) Map<chunkId, score>
 *   async stats() / close()
 *
 * 安全边界：Milvus 后端会把 chunk 文本经嵌入提供方送出，并在外部服务上建立索引——
 * 与「零云端」默认形态不同，只有显式配置 rag.vector_store=milvus 才会启用。
 */
'use strict';

const { createMemoryVectorStore } = require('./memory.cjs');

const BACKENDS = ['memory', 'milvus'];
const DEFAULT_BACKEND = 'memory';

/**
 * 向量后端统一契约（memory / milvus 都实现）。索引侧只依赖这些成员。
 *
 * @typedef {object} VectorStoreContract
 * @property {string} kind                     'memory' | 'milvus'
 * @property {boolean} prefiltered             true=只对 BM25 预筛候选打分；false=全库语义检索
 * @property {(relative: string, chunkIds: string[]) => number} dropLocal
 * @property {(change: {deleted: any[], upserted: any[]}, embedder: any) => Promise<any>} applyChanges
 * @property {(chunk: any, embedder: any) => Promise<any[]|null>} chunkVector
 * @property {(query: string, candidates: any[]|null, embedder: any) => Promise<Map<string, number>>} scoreCandidates
 * @property {() => Promise<any>} stats
 * @property {() => Promise<any>} close
 */

/** 未知取值一律回退 memory（配置容错，与其余 rag.* 的 clamp 风格一致）。 */
function normalizeBackend(value) {
  const normalized = String(value == null ? '' : value).toLowerCase().trim();
  return BACKENDS.includes(normalized) ? normalized : DEFAULT_BACKEND;
}

/** @returns {VectorStoreContract} */
function createVectorStore(options) {
  const o = options || {};
  if (normalizeBackend(o.backend) === 'milvus') {
    // 惰性 require：未安装 SDK 时不应影响默认（memory）路径的启动
    return require('./milvus.cjs').createMilvusVectorStore(o);
  }
  return createMemoryVectorStore(o);
}

module.exports = { BACKENDS, DEFAULT_BACKEND, createVectorStore, normalizeBackend };
