/**
 * Milvus 向量后端（`rag.vector_store=milvus`，非默认）。
 *
 * 与内存后端的区别：
 *   - chunk 向量写入 Milvus collection，**检索走全库 ANN**（prefiltered=false），
 *     因此语义命中不再受 BM25 预筛限制；BM25 结果仍然保留，两者按 rankScore 融合。
 *   - 需要外部 Milvus 服务（自建 standalone / Zilliz Cloud），是本项目里唯一会
 *     把 chunk 文本经嵌入提供方外送并落到外部索引的形态——默认不启用。
 *
 * SDK：官方 @zilliz/milvus2-sdk-node（纯 JS，无原生二进制）。
 * 刻意**不写进 package.json**：保持默认零依赖、打包体积不变；需要 Milvus 时执行
 *   npm i @zilliz/milvus2-sdk-node
 * 之后 `npm run dist:win` 会把该依赖一并打进产物（electron-builder 默认包含生产依赖）。
 *
 * 测试：可注入 client（`options.client`）——scripts/vector-store-test.cjs 用假客户端
 * 覆盖建表/写入/删除/检索/维度校验全部分支，无需真实 Milvus；真实服务端到端由
 * MILVUS_ADDR 环境变量守卫（未设置则明确 SKIP，不静默通过）。
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

const DEFAULTS = Object.freeze({
  address: 'http://127.0.0.1:19530',
  collection: '',
  dim: 4096,
  batchSize: 32,
  maxIdLength: 2048,
  maxFileLength: 2048,
});

const SDK_NAME = '@zilliz/milvus2-sdk-node';
const VECTOR_FIELD = 'vector';

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 官方 SDK 惰性加载：缺失时给出可执行的修复指令，而不是一个 MODULE_NOT_FOUND 栈。 */
function loadSdk() {
  try {
    return require(SDK_NAME);
  } catch (error) {
    const detail = (error && error.message) || String(error);
    throw new Error(
      'rag.vector_store=milvus 需要官方 SDK（默认不打进依赖以保持零依赖/体积不变）。' +
        '请在本项目根目录执行 `npm i ' + SDK_NAME + '` 后重启；若使用打包版需重新打包。原始错误：' + detail
    );
  }
}

/** 从工程根派生 collection 名：可读 + 稳定，避免多工程共用服务时互相覆盖。 */
function defaultCollectionName(root) {
  const resolved = path.resolve(root || '.');
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^([^a-z_])/, 'p_$1')
    .slice(0, 24) || 'project';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return ('codenode_rag_' + base + '_' + hash).slice(0, 200);
}

/** Milvus 布尔返回在 2.x/3.x 与不同封装层下形状不一，这里统一归一。 */
function truthyCollection(result) {
  if (result === true || result === false) return result;
  if (!result || typeof result !== 'object') return false;
  for (const key of ['value', 'exists', 'has_collection', 'is_exist', 'exist']) {
    if (typeof result[key] === 'boolean') return result[key];
  }
  if (result.data && typeof result.data === 'object') return truthyCollection(result.data);
  return false;
}

/** search 返回 [[{id, score}]] / {results:[[...]]} / {data:[...]} 等形状的归一。 */
function normalizeSearchHits(result) {
  const rows = Array.isArray(result)
    ? result
    : (result && (result.results || result.data || result.hits)) || [];
  const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
  if (!Array.isArray(first)) return [];
  const out = [];
  for (const hit of first) {
    if (!hit || typeof hit !== 'object') continue;
    const id = hit.id != null ? hit.id : hit.ID != null ? hit.ID : hit.pk != null ? hit.pk : null;
    if (id == null) continue;
    const raw = hit.score != null ? hit.score : hit.distance != null ? hit.distance : hit.Score;
    const score = Number(raw);
    out.push({ id: String(id), score: Number.isFinite(score) ? score : 0 });
  }
  return out;
}

/** 不同 SDK/服务端版本的 insert/delete 返回计数键名不一，做保守提取。 */
function extractCount(result) {
  if (!result || typeof result !== 'object') return 0;
  for (const key of ['insert_cnt', 'insertCount', 'upsert_cnt', 'upsertCount', 'delete_cnt', 'deleteCount', 'row_count']) {
    const n = Number(result[key]);
    if (Number.isFinite(n)) return n;
  }
  if (result.data && typeof result.data === 'object') return extractCount(result.data);
  return 0;
}

/** 不同 SDK/服务端版本的 describeCollection 都会把 dim 放在嵌套结构里，做保守递归扫描。 */
function extractVectorDim(result) {
  const seen = new Set();
  const stack = [result];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }
    if (typeof node.dimension === 'number' && node.dimension > 0) return node.dimension;
    for (const key of ['dim', 'vector_dim', 'vectorDim']) {
      const n = Number(node[key]);
      if (node[key] != null && Number.isFinite(n) && n > 0) return n;
    }
    for (const key of ['typeParams', 'type_params']) {
      const n = Number(node[key] && node[key].dim);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof node.name === 'string' && node.name === VECTOR_FIELD) {
      for (const key of ['dim', 'dimension']) {
        const n = Number(node.params && node.params[key]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    for (const key of ['fields', 'data', 'schema', 'desc', 'coll_schema']) {
      const child = node[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

/** Milvus 表达式里的字符串字面量转义（filter 用）。 */
function stringLiteral(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function chunkText(chunk) {
  return chunk.path + '\n' + chunk.content;
}

class MilvusVectorStore {
  constructor(options) {
    const o = options || {};
    this.kind = 'milvus';
    this.prefiltered = false;
    this.root = path.resolve(o.root || '.');
    this.address = String(o.address || '').trim() || DEFAULTS.address;
    this.token = String(o.token || '').trim();
    this.username = String(o.username || '').trim();
    this.password = String(o.password || '').trim();
    this.dim = clampInteger(o.dim, DEFAULTS.dim, 256, 8192);
    this.collection = String(o.collection || '').trim() || defaultCollectionName(this.root);
    this.batchSize = clampInteger(o.batchSize, DEFAULTS.batchSize, 1, 256);
    this.searchLimit = clampInteger(o.topK, 40, 1, 16384);
    this.injectedClient = o.client || null;
    this.client = o.client || null;
    this.sdk = null;
    this.ready = null;
    this.lastError = null;
    this.counters = { inserted: 0, deleted: 0, searches: 0, batches: 0, flushes: 0, failures: 0 };
  }

  /** 连接/建表都是惰性的：构造不该因为服务未启动而抛错。 */
  ensureClient() {
    if (this.client) return this.client;
    const sdk = loadSdk();
    this.sdk = sdk;
    const clientOptions = { address: this.address };
    if (this.token) clientOptions.token = this.token;
    if (this.username) clientOptions.username = this.username;
    if (this.password) clientOptions.password = this.password;
    this.client = new sdk.MilvusClient(clientOptions);
    return this.client;
  }

  async ensureCollection() {
    if (this.ready) return this.ready;
    const client = this.ensureClient();
    const existed = truthyCollection(await client.hasCollection({ collection_name: this.collection }));
    if (existed) {
      let remoteDim = null;
      try {
        const described = typeof client.describeCollection === 'function'
          ? await client.describeCollection({ collection_name: this.collection })
          : null;
        remoteDim = extractVectorDim(described);
      } catch (error) {
        this.lastError = (error && error.message) || String(error);
      }
      if (remoteDim && remoteDim !== this.dim) {
        throw new Error(
          'Milvus collection ' + this.collection + ' 的向量维度为 ' + remoteDim +
            '，与 rag.embed_dim=' + this.dim + ' 不一致。请删除该 collection 或统一 embed_dim 后重试。'
        );
      }
      if (typeof client.loadCollection === 'function') {
        try {
          await client.loadCollection({ collection_name: this.collection });
        } catch (error) {
          this.lastError = (error && error.message) || String(error);
        }
      }
      this.ready = { collection: this.collection, dim: remoteDim || this.dim, created: false };
      return this.ready;
    }

    const DataType = (this.sdk && this.sdk.DataType) || (this.injectedClient && this.injectedClient.DataType) || {};
    const schema = {
      collection_name: this.collection,
      description: 'CodeNode Agentic RAG chunk vectors (auto-managed)',
      fields: [
        { name: 'id', data_type: DataType.VarChar || 21, max_length: DEFAULTS.maxIdLength, is_primary_key: true, autoID: false },
        { name: 'file', data_type: DataType.VarChar || 21, max_length: DEFAULTS.maxFileLength },
        { name: VECTOR_FIELD, data_type: DataType.FloatVector || 101, dim: this.dim },
      ],
      enable_dynamic_field: false,
    };
    await client.createCollection(schema);
    if (typeof client.createIndex === 'function') {
      await client.createIndex({
        collection_name: this.collection,
        field_name: VECTOR_FIELD,
        index_type: 'AUTOINDEX',
        metric_type: 'COSINE',
        params: {},
      });
    }
    if (typeof client.loadCollection === 'function') {
      await client.loadCollection({ collection_name: this.collection });
    }
    this.ready = { collection: this.collection, dim: this.dim, created: true };
    return this.ready;
  }

  /** 写入后需要 flush，否则紧随其后的 search 可能看不到新数据。 */
  async flush() {
    const client = this.client;
    if (!client) return false;
    const attempts = [
      () => (typeof client.flushSync === 'function' ? client.flushSync({ collection_names: [this.collection] }) : null),
      () => (typeof client.flush === 'function' ? client.flush({ collection_names: [this.collection] }) : null),
      () => (typeof client.flushSync === 'function' ? client.flushSync({ collection_name: this.collection }) : null),
    ];
    for (const attempt of attempts) {
      try {
        const pending = attempt();
        if (pending && typeof pending.then === 'function') {
          await pending;
          this.counters.flushes += 1;
          return true;
        }
      } catch (error) {
        this.lastError = (error && error.message) || String(error);
      }
    }
    return false;
  }

  /** 分批嵌入并写入；维度不符时早失败，避免把脏向量写进 collection。 */
  async insertChunks(records, embedder) {
    const client = this.ensureClient();
    let inserted = 0;
    for (let start = 0; start < records.length; start += this.batchSize) {
      const batch = records.slice(start, start + this.batchSize);
      const vectors = await embedder.embed(batch.map((item) => item.text));
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error('嵌入返回数量与请求不一致：' + (vectors ? vectors.length : 0) + ' != ' + batch.length);
      }
      const first = vectors[0];
      if (Array.isArray(first) && first.length !== this.dim) {
        throw new Error('嵌入维度 ' + first.length + ' 与 rag.embed_dim=' + this.dim + ' 不一致（collection ' + this.collection + '）');
      }
      const rows = batch.map((item, i) => ({ id: item.id, file: item.path, [VECTOR_FIELD]: vectors[i] }));
      const result = await client.insert({ collection_name: this.collection, data: rows });
      inserted += extractCount(result) || rows.length;
      this.counters.batches += 1;
      this.counters.inserted += rows.length;
      await this.flush();
    }
    return inserted;
  }

  /** 内存后端有记忆化缓存需要同步清理；Milvus 的删除走 applyChanges（异步）。 */
  dropLocal() {
    return 0;
  }

  /**
   * 把 refresh() 期间收集到的文件变更落到 Milvus：
   * 先按 file 过滤删除（变更/删除文件的旧块），再写入新块——保证同一 chunk id 不残留旧版本。
   */
  async applyChanges(change, embedder) {
    const deleted = (change && Array.isArray(change.deleted) ? change.deleted : []).filter((item) => item && item.relative);
    const upserted = (change && Array.isArray(change.upserted) ? change.upserted : []).filter((item) => item && item.id && typeof item.text === 'string');
    if (!deleted.length && !upserted.length) return { backend: this.kind, inserted: 0, deleted: 0 };
    const client = this.ensureClient();
    const ready = await this.ensureCollection();
    let removed = 0;
    if (deleted.length) {
      for (const item of deleted) {
        const result = await client.delete({
          collection_name: this.collection,
          filter: 'file == ' + stringLiteral(item.relative),
        });
        const cnt = extractCount(result);
        removed += cnt || (Array.isArray(item.chunkIds) ? item.chunkIds.length : 0);
        this.counters.deleted += 1;
      }
      await this.flush();
    }
    let inserted = 0;
    if (upserted.length) {
      if (!embedder) throw new Error('Milvus 写入需要嵌入提供方（rag.embed_provider 不能为 none）');
      inserted = await this.insertChunks(upserted, embedder);
    }
    return { backend: this.kind, inserted, deleted: removed, collection: ready.collection, dim: ready.dim };
  }

  /**
   * Milvus 后端的向量写在服务端，不做进程内记忆化。
   *
   * @param {any} [chunk]
   * @param {any} [embedder]
   */
  async chunkVector(chunk, embedder) {
    void chunk;
    void embedder;
    return null;
  }

  /** 全库 ANN：candidates 参数在 Milvus 后端被忽略（这正是接入向量库的意义）。 */
  async scoreCandidates(query, candidates, embedder) {
    const out = new Map();
    if (!embedder) return out;
    await this.ensureCollection();
    const [queryVec] = await embedder.embed([query]);
    if (!Array.isArray(queryVec) || !queryVec.length) return out;
    const result = await this.client.search({
      collection_name: this.collection,
      data: [queryVec],
      limit: this.searchLimit,
      anns_field: VECTOR_FIELD,
      output_fields: ['file'],
      search_params: { metric_type: 'COSINE', params: {} },
    });
    this.counters.searches += 1;
    for (const hit of normalizeSearchHits(result)) {
      out.set(hit.id, Math.max(0, hit.score));
    }
    return out;
  }

  async stats() {
    return {
      backend: this.kind,
      external: true,
      persisted: true,
      address: this.address,
      collection: this.collection,
      dim: this.dim,
      ready: !!this.ready,
      created: !!(this.ready && this.ready.created),
      searchLimit: this.searchLimit,
      ...this.counters,
      lastError: this.lastError || undefined,
      sdkLoaded: !!this.sdk || !!this.injectedClient,
    };
  }

  async close() {
    const client = this.client;
    this.ready = null;
    if (!client || this.injectedClient) return;
    try {
      if (typeof client.close === 'function') client.close();
    } catch (error) {
      this.lastError = (error && error.message) || String(error);
    }
    this.client = null;
  }
}

function createMilvusVectorStore(options) {
  return new MilvusVectorStore(options);
}

module.exports = {
  DEFAULTS,
  MilvusVectorStore,
  SDK_NAME,
  chunkText,
  createMilvusVectorStore,
  defaultCollectionName,
  extractCount,
  extractVectorDim,
  loadSdk,
  normalizeSearchHits,
  stringLiteral,
  truthyCollection,
};
