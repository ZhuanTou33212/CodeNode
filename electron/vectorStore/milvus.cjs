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
  batchSize: 128,
  flushEveryBatches: 4,
  maxIdLength: 2048,
  maxFileLength: 2048,
  consistencyLevel: 'strong',
  // 生产档（百万级向量 / 1024 维 / HNSW）：默认按此建索引与检索，可用 rag.milvus_* 覆盖
  indexType: 'HNSW',
  metricType: 'COSINE',
  indexM: 16,
  indexEfConstruction: 200,
  searchEf: 64,
});

/** HNSW 家族才吃 search 参数 ef（其他索引带 ef 可能被服务端拒绝）。 */
function usesSearchEf(indexType) {
  return /^HNSW/i.test(String(indexType || '').trim());
}

/** 一致性级别归一：strong/bounded/eventually/session；default/空 = 用服务端默认（不下发该字段）。 */
const CONSISTENCY_LEVELS = Object.freeze({
  strong: 'Strong',
  bounded: 'Bounded',
  eventually: 'Eventually',
  session: 'Session',
  default: '',
  none: '',
});

function normalizeConsistency(value) {
  const raw = String(value == null ? DEFAULTS.consistencyLevel : value).trim();
  if (!raw) return '';
  const mapped = CONSISTENCY_LEVELS[raw.toLowerCase()];
  return mapped === undefined ? raw : mapped;
}

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

/** 命中列表在不同 SDK 版本下可能是 [[hits]] / [{data:[hits],top_k}] / [hits]，逐层解包。 */
function pickHitList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['results', 'data', 'hits', 'rows']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return null;
}

/** search 返回 [[{id, score}]] / {results:[[...]]} / {data:[...]} 等形状的归一。 */
function normalizeSearchHits(result) {
  const rows = pickHitList(result) || [];
  const first = pickHitList(rows[0]) || rows;
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
      const raw = node[key];
      const direct = Number(raw && raw.dim);
      if (Number.isFinite(direct) && direct > 0) return direct;
      // SDK 的 FieldSchema.type_params 是 KeyValuePair[]：[{key:'dim', value:'256'}]
      if (Array.isArray(raw)) {
        for (const pair of raw) {
          const name = String((pair && (pair.key != null ? pair.key : pair.name)) || '').toLowerCase();
          if (name !== 'dim' && name !== 'dimension') continue;
          const n = Number(pair.value);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
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

/** describeIndex 的描述里 index_type/metric_type 放在 params: KeyValuePair[]（也兼容扁平字段）。 */
function extractIndexField(description, key) {
  if (!description || typeof description !== 'object') return null;
  const params = Array.isArray(description.params) ? description.params : [];
  for (const pair of params) {
    if (pair && String(pair.key) === key) return String(pair.value);
  }
  return description[key] == null ? null : String(description[key]);
}

function chunkText(chunk) {
  return chunk.path + '\n' + chunk.content;
}

/** SDK 把失败放在 status.error_code 里（不抛异常），且不同方法有的返回裸 status、有的包一层 {status}。 */
function statusOf(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.status && typeof result.status === 'object') return result.status;
  if (result.error_code != null || result.code != null) return result;
  return null;
}

/** 统一把 SDK 的失败状态转成异常：否则会出现「零命中」这种静默错误（实测 topk 缺失即如此）。 */
function assertSuccess(result, action) {
  const status = statusOf(result);
  if (!status) return result;
  const code = status.error_code != null ? status.error_code : status.code;
  const ok = code == null || code === 'Success' || code === 0;
  if (!ok) {
    const reason = status.reason || status.detail || 'unknown';
    throw new Error('Milvus ' + action + ' 失败：' + reason + '（error_code=' + code + '）');
  }
  return result;
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
    this.batchSize = clampInteger(o.batchSize, DEFAULTS.batchSize, 1, 1024);
    this.flushEveryBatches = clampInteger(o.flushEveryBatches, DEFAULTS.flushEveryBatches, 1, 1000);
    this.searchLimit = clampInteger(o.topK, 40, 1, 16384);
    this.indexType = String(o.indexType || DEFAULTS.indexType).trim() || DEFAULTS.indexType;
    this.metricType = String(o.metricType || DEFAULTS.metricType).trim() || DEFAULTS.metricType;
    this.indexM = clampInteger(o.indexM, DEFAULTS.indexM, 4, 2048);
    this.indexEfConstruction = clampInteger(o.indexEfConstruction, DEFAULTS.indexEfConstruction, 8, 4096);
    this.searchEf = clampInteger(o.searchEf, DEFAULTS.searchEf, 8, 16384);
    this.indexNote = null;
    this.consistencyLevel = normalizeConsistency(o.consistencyLevel === undefined ? DEFAULTS.consistencyLevel : o.consistencyLevel);
    this.consistencyFallback = null;
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
    const existed = truthyCollection(assertSuccess(await client.hasCollection({ collection_name: this.collection }), 'hasCollection'));
    if (existed) {
      let remoteDim = null;
      try {
        const described = typeof client.describeCollection === 'function'
          ? assertSuccess(await client.describeCollection({ collection_name: this.collection }), 'describeCollection')
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
          assertSuccess(await client.loadCollection({ collection_name: this.collection }), 'loadCollection');
        } catch (error) {
          this.lastError = (error && error.message) || String(error);
        }
      }
      // 既有 collection 不会重建索引：把「实际索引 ≠ 配置」这个事实记下来（不阻断，但可诊断）
      if (typeof client.describeIndex === 'function') {
        try {
          const described = assertSuccess(
            await client.describeIndex({ collection_name: this.collection, field_name: VECTOR_FIELD }),
            'describeIndex'
          );
          const descriptions = Array.isArray(described.index_descriptions) ? described.index_descriptions : [];
          const current = descriptions
            .map((item) => ({
              field: item.field_name,
              type: extractIndexField(item, 'index_type'),
              metric: extractIndexField(item, 'metric_type'),
            }))
            .find((item) => !item.field || item.field === VECTOR_FIELD);
          const notes = [];
          if (current && current.type && current.type.toUpperCase() !== this.indexType.toUpperCase()) {
            notes.push(
              '既有 collection 的向量索引为 ' + current.type + '，与 rag.milvus_index_type=' + this.indexType +
                ' 不一致（已存在的 collection 不会重建索引；要按新参数建索引需重建该 collection）'
            );
          }
          if (current && current.metric && current.metric.toUpperCase() !== this.metricType.toUpperCase()) {
            notes.push('既有索引的 metric 为 ' + current.metric + '，与 rag.milvus_metric_type=' + this.metricType + ' 不一致');
          }
          if (notes.length) this.indexNote = notes.join('；');
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
    await assertSuccess(await client.createCollection(schema), 'createCollection');
    if (typeof client.createIndex === 'function') {
      await assertSuccess(
        await client.createIndex({
          collection_name: this.collection,
          field_name: VECTOR_FIELD,
          index_type: this.indexType,
          metric_type: this.metricType,
          // HNSW 建索引参数：M（每层邻居数）与 efConstruction（建图深度）
          params: usesSearchEf(this.indexType) ? { M: this.indexM, efConstruction: this.indexEfConstruction } : {},
        }),
        'createIndex'
      );
    }
    if (typeof client.loadCollection === 'function') {
      await assertSuccess(await client.loadCollection({ collection_name: this.collection }), 'loadCollection');
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
    let batchesSinceFlush = 0;
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
      const result = assertSuccess(await client.insert({ collection_name: this.collection, data: rows }), 'insert');
      inserted += extractCount(result) || rows.length;
      this.counters.batches += 1;
      this.counters.inserted += rows.length;
      batchesSinceFlush += 1;
      // 百万级写入时逐批 flushSync 代价太高：每 flushEveryBatches 批刷一次，收尾再补一次
      if (batchesSinceFlush >= this.flushEveryBatches) {
        await this.flush();
        batchesSinceFlush = 0;
      }
    }
    if (batchesSinceFlush > 0) await this.flush();
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
        const result = assertSuccess(
          await client.delete({
            collection_name: this.collection,
            filter: 'file == ' + stringLiteral(item.relative),
          }),
          'delete'
        );
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

  /** 检索参数（不传 search_params：显式传会让 SDK 不再注入 topk）。 */
  buildSearchArgs(queryVec) {
    const args = {
      collection_name: this.collection,
      data: [queryVec],
      limit: this.searchLimit,
      topk: this.searchLimit,
      anns_field: VECTOR_FIELD,
      output_fields: ['id', 'file'],
      metric_type: this.metricType,
      // HNSW 检索参数 ef（候选面宽）：经简单形态的 params 下发，SDK 会 JSON 化后塞进 search_params
      params: usesSearchEf(this.indexType) ? { ef: this.searchEf } : {},
    };
    // Strong 让「刚写入的向量 / 刚按文件删除的旧块」立即可见（默认 Bounded 时删除有数秒延迟）
    if (this.consistencyLevel) args.consistency_level = this.consistencyLevel;
    return args;
  }

  /** 全库 ANN：candidates 参数在 Milvus 后端被忽略（这正是接入向量库的意义）。 */
  async scoreCandidates(query, candidates, embedder) {
    const out = new Map();
    if (!embedder) return out;
    await this.ensureCollection();
    const [queryVec] = await embedder.embed([query]);
    if (!Array.isArray(queryVec) || !queryVec.length) return out;
    // 注意（真机实测）：
    // 1) 主键 id 不会自动出现在命中里，必须显式列入 output_fields（否则只剩 score + 请求字段）；
    // 2) 一旦显式传 search_params，SDK 会原样透传（utils/Search.js 的 buildSearchParams 不再注入 topk），
    //    服务端会以 "topk is required" 报错；这里走 SDK 的简单形态由 SDK 组装 search_params。
    let result;
    try {
      result = assertSuccess(await this.client.search(this.buildSearchArgs(queryVec)), 'search');
    } catch (error) {
      const message = (error && error.message) || String(error);
      // 服务端不接受该一致性级别（如部分云托管只支持 Bounded）：退回服务端默认并记录一次
      if (!this.consistencyLevel) throw error;
      this.consistencyFallback = message;
      this.consistencyLevel = '';
      result = assertSuccess(await this.client.search(this.buildSearchArgs(queryVec)), 'search');
    }
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
      indexType: this.indexType,
      metricType: this.metricType,
      indexM: this.indexM,
      indexEfConstruction: this.indexEfConstruction,
      searchEf: usesSearchEf(this.indexType) ? this.searchEf : null,
      batchSize: this.batchSize,
      flushEveryBatches: this.flushEveryBatches,
      indexNote: this.indexNote || undefined,
      consistencyLevel: this.consistencyLevel || 'server-default',
      consistencyFallback: this.consistencyFallback || undefined,
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
  extractIndexField,
  extractVectorDim,
  loadSdk,
  normalizeSearchHits,
  stringLiteral,
  truthyCollection,
  usesSearchEf,
};
