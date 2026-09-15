'use strict';

/**
 * 向量后端（electron/vectorStore）测试：memory 默认后端行为不变 + Milvus 适配器全分支。
 *
 * 覆盖：
 *   1  后端工厂与 rag.vector_store 归一（未知值回退 memory）
 *   2  memory 后端：记忆化、同步清理、惰性写入、不依赖外部服务
 *   3  Milvus 适配器（注入假客户端）：建表/建索引/load/分批写入/删除/全库检索
 *   4  维度不一致 → 可读错误（不写脏向量）
 *   5  SDK 缺失 → 可执行提示（未安装 SDK 时断言；已安装则明确 SKIP）
 *   6  LocalRagIndex + milvus 后端：增删落库、file 模式不检索、vector 模式走全库 ANN
 *   7  纯语义命中（BM25 未召回）并入结果并标记 vector-only
 *   8  后端不可用 → 检索降级为纯 BM25，不抛错、不静默（stats.vector.error + 工具文本告警）
 *   9  真实 Milvus 端到端：由 MILVUS_ADDR 守卫，未设置即明确 SKIP（不静默通过）
 *
 * 说明：第 3/6/7/8 节用假客户端覆盖**本适配器与索引侧的接线逻辑**，不代表真机 Milvus 行为；
 * 真机验证见第 9 节（需自建 Milvus 服务）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalRagIndex, clearIndexCache } = require('../electron/rag/index.cjs');
const { BACKENDS, createVectorStore, normalizeBackend } = require('../electron/vectorStore/index.cjs');
const { createMemoryVectorStore } = require('../electron/vectorStore/memory.cjs');
const milvus = require('../electron/vectorStore/milvus.cjs');
const { createEmbedder, cosine } = require('../electron/embedder/index.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-vector-store-test-'));

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/** 统一读取检索结果的向量诊断块（早退路径的 stats 无该字段，用 any 规避联合类型）。 */
/** @param {any} result */
function vectorStats(result) {
  return /** @type {any} */ (result.stats.vector);
}

/** 假 Milvus 客户端：只实现本适配器用到的 SDK 表面，行为可控（失败注入 / 强制命中）。 */
function createFakeMilvusClient() {
  const state = {
    collections: new Map(),
    rows: [],
    created: [],
    indexes: [],
    loaded: [],
    searches: 0,
    deletedRows: 0,
    closed: false,
    failing: false,
    statusError: null,
    rejectConsistency: false,
    lastSearchArgs: null,
    forceHits: null,
  };
  return {
    state,
    DataType: { VarChar: 21, FloatVector: 101 },
    async hasCollection({ collection_name }) {
      return { value: state.collections.has(collection_name) };
    },
    async describeCollection({ collection_name }) {
      const entry = state.collections.get(collection_name);
      return {
        fields: [
          { name: 'id', data_type: 21 },
          { name: 'file', data_type: 21 },
          { name: 'vector', data_type: 101, typeParams: { dim: String(entry ? entry.dim : '') } },
        ],
      };
    },
    async createCollection(schema) {
      const vectorField = (schema.fields || []).find((field) => field.name === 'vector');
      state.collections.set(schema.collection_name, { dim: vectorField ? vectorField.dim : null });
      state.created.push({ name: schema.collection_name, dim: vectorField ? vectorField.dim : null });
      return { status: {} };
    },
    async createIndex(args) {
      state.indexes.push(args);
      state.indexType = args.index_type;
      return { status: {} };
    },
    async describeIndex() {
      return {
        status: { error_code: 'Success', code: 0 },
        index_descriptions: [
          {
            field_name: 'vector',
            params: [
              { key: 'index_type', value: state.indexType || 'HNSW' },
              { key: 'metric_type', value: 'COSINE' },
            ],
          },
        ],
      };
    },
    async loadCollection({ collection_name }) {
      state.loaded.push(collection_name);
      return { status: {} };
    },
    async flushSync() {
      return { status: {} };
    },
    async insert({ data }) {
      for (const row of data) {
        state.rows = state.rows.filter((item) => item.id !== row.id);
        state.rows.push(row);
      }
      return { insert_cnt: data.length };
    },
    async delete({ filter }) {
      const matched = /^file == "(.*)"$/.exec(String(filter || ''));
      const file = matched ? matched[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
      const before = state.rows.length;
      if (file) state.rows = state.rows.filter((row) => row.file !== file);
      const removed = before - state.rows.length;
      state.deletedRows += removed;
      return { delete_cnt: removed };
    },
    async search(args) {
      const { data, limit } = args;
      state.searches += 1;
      state.lastSearchArgs = args;
      if (state.failing) throw new Error('fake milvus 不可用');
      // 模拟「服务端不支持该一致性级别」（如部分云托管只支持 Bounded）
      if (state.rejectConsistency && args.consistency_level) {
        return { status: { error_code: 'UnexpectedError', reason: 'consistency level not supported', code: 65535 }, results: [] };
      }
      // 真实 SDK 的失败形态：不抛异常，而是 status.error_code + 空 results（实测 "topk is required" 即如此）
      if (state.statusError) return { status: { error_code: 'UnexpectedError', reason: state.statusError, code: 65535 }, results: [] };
      if (state.forceHits) return { results: [state.forceHits.slice()] };
      const query = data[0];
      const ranked = state.rows
        .map((row) => ({ id: row.id, score: cosine(query, row.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { results: [ranked] };
    },
    close() {
      state.closed = true;
    },
  };
}

async function main() {
  const embedder = createEmbedder({ embedProvider: 'local', embedDim: 256 });

  // ---- 1. 工厂与配置归一 ----
  assert.deepStrictEqual(BACKENDS, ['memory', 'milvus']);
  assert.strictEqual(normalizeBackend('MILVUS'), 'milvus');
  assert.strictEqual(normalizeBackend('weaviate'), 'memory', '未知后端应回退 memory');
  assert.strictEqual(normalizeBackend(undefined), 'memory');
  const memoryDefault = createVectorStore({});
  assert.strictEqual(memoryDefault.kind, 'memory', '不配置时应为 memory 后端');
  assert.strictEqual(memoryDefault.prefiltered, true, 'memory 后端只对 BM25 预筛候选打分');
  await memoryDefault.close();

  // ---- 2. memory 后端：记忆化 / 同步清理 / 惰性写入 ----
  const memoryStore = createMemoryVectorStore();
  const sampleChunk = { id: 'a.ts:1:3', path: 'a.ts', content: 'refreshSessionToken 轮换 令牌' };
  const vectorA = await memoryStore.chunkVector(sampleChunk, embedder);
  const vectorB = await memoryStore.chunkVector(sampleChunk, embedder);
  assert.ok(Array.isArray(vectorA) && vectorA.length === 256, 'local 向量维度应等于 embed_dim');
  assert.deepStrictEqual(vectorA, vectorB, '同一块应命中记忆化结果');
  let memoryStats = await memoryStore.stats();
  assert.strictEqual(memoryStats.vectors, 1);
  assert.strictEqual(memoryStats.external, false);
  assert.strictEqual(memoryStore.dropLocal('a.ts', [sampleChunk.id]), 1, 'dropLocal 应清理记忆化条目');
  memoryStats = await memoryStore.stats();
  assert.strictEqual(memoryStats.vectors, 0);
  const memoryApply = await memoryStore.applyChanges({ upserted: [{ id: 'x', path: 'x', text: 't' }] }, embedder);
  assert.strictEqual(memoryApply.lazy, true, 'memory 后端写入应惰性（无外部存储）');
  const memoryScored = await memoryStore.scoreCandidates('refreshSessionToken 令牌', [sampleChunk], embedder);
  assert.ok(memoryScored.get(sampleChunk.id) > 0, 'memory 后端候选打分应返回余弦分');
  await memoryStore.close();

  // ---- 3. Milvus 适配器（假客户端）：建表 / 索引 / 写入 / 删除 / 检索 ----
  const fake = createFakeMilvusClient();
  const collection = 'codenode_test_rag';
  const store = createVectorStore({ backend: 'milvus', client: fake, root, dim: 256, topK: 8, collection });
  assert.strictEqual(store.kind, 'milvus');
  assert.strictEqual(store.prefiltered, false, 'milvus 后端应走全库 ANN');
  assert.strictEqual(await store.chunkVector(sampleChunk, embedder), null, 'milvus 后端不做进程内记忆化');

  const records = [
    { id: 'src/auth.ts:1:8', path: 'src/auth.ts', text: 'src/auth.ts\nexport function refreshSessionToken() { return rotate(); }' },
    { id: 'src/auth.ts:9:16', path: 'src/auth.ts', text: 'src/auth.ts\nfunction rotate() { return "nonce"; }' },
    { id: 'docs/guide.md:1:4', path: 'docs/guide.md', text: 'docs/guide.md\n登录会话使用刷新令牌轮换机制。' },
  ];
  const applied = await store.applyChanges({ deleted: [], upserted: records }, embedder);
  assert.strictEqual(fake.state.created.length, 1, '首次写入应创建 collection');
  assert.strictEqual(fake.state.created[0].dim, 256, 'collection 维度应取 rag.embed_dim');
  // 生产档：HNSW + COSINE + M16/efConstruction200
  assert.strictEqual(fake.state.indexes[0].index_type, 'HNSW', '默认应按生产档建 HNSW 索引');
  assert.strictEqual(fake.state.indexes[0].metric_type, 'COSINE');
  assert.deepStrictEqual(fake.state.indexes[0].params, { M: 16, efConstruction: 200 }, 'HNSW 建索引参数应可配且默认 M16/efC200');
  assert.deepStrictEqual(fake.state.loaded, [collection], '建表后必须 load 才能检索');
  assert.strictEqual(applied.inserted, records.length);
  assert.strictEqual(fake.state.rows.length, records.length);
  assert.ok(fake.state.rows.every((row) => row.vector.length === 256), '每行向量维度应为 embed_dim');

  const scores = await store.scoreCandidates('refreshSessionToken 令牌', null, embedder);
  assert.ok(scores instanceof Map && scores.size > 0, '全库检索应返回 Map<id, score>');
  assert.ok([...scores.values()].every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(scores.has('src/auth.ts:1:8'), '命中应包含写入过的块 id');
  // 真机踩坑的回归断言：不传 search_params（否则 SDK 不注入 topk）、主键进 output_fields、默认 Strong 一致性
  assert.strictEqual(fake.state.lastSearchArgs.search_params, undefined, '不得显式传 search_params（SDK 会原样透传，服务端报 topk is required）');
  assert.ok(fake.state.lastSearchArgs.limit > 0 && fake.state.lastSearchArgs.topk > 0, '必须下发 limit/topk');
  assert.deepStrictEqual(fake.state.lastSearchArgs.output_fields, ['id', 'file'], '主键必须显式列入 output_fields');
  assert.strictEqual(fake.state.lastSearchArgs.consistency_level, 'Strong', '默认应以 Strong 一致性检索（否则刚删的旧块仍可见）');
  assert.strictEqual(fake.state.lastSearchArgs.metric_type, 'COSINE');
  assert.deepStrictEqual(fake.state.lastSearchArgs.params, { ef: 64 }, 'HNSW 检索参数 ef 应经简单形态 params 下发且默认 64');

  // ---- 3b. 写入批量与 flush 节流（百万级不能逐批 flushSync） ----
  const bulkClient = createFakeMilvusClient();
  const bulkStore = createVectorStore({
    backend: 'milvus',
    client: bulkClient,
    root,
    dim: 256,
    topK: 8,
    collection: 'codenode_bulk_rag',
    batchSize: 2,
    flushEveryBatches: 2,
  });
  const bulkRecords = [1, 2, 3, 4, 5].map((n) => ({ id: 'bulk.ts:' + n + ':' + n, path: 'bulk.ts', text: 'chunk ' + n }));
  const bulkApplied = await bulkStore.applyChanges({ deleted: [], upserted: bulkRecords }, embedder);
  const bulkStats = await bulkStore.stats();
  assert.strictEqual(bulkApplied.inserted, 5, '分批写入应覆盖全部记录');
  assert.strictEqual(bulkStats.batches, 3, 'batchSize=2 时 5 条应分 3 批');
  assert.strictEqual(bulkStats.flushes, 2, 'flushEveryBatches=2 时应只刷 2 次（逐批刷会是 3 次）');
  assert.strictEqual(bulkStats.batchSize, 2);
  await bulkStore.close();

  // ---- 3c. 既有 collection 的索引与配置不一致 → 可诊断提示（不阻断） ----
  const legacyClient = createFakeMilvusClient();
  legacyClient.state.collections.set('codenode_legacy_rag', { dim: 256 });
  legacyClient.state.indexType = 'AUTOINDEX';
  const legacyStore = createVectorStore({ backend: 'milvus', client: legacyClient, root, dim: 256, topK: 8, collection: 'codenode_legacy_rag' });
  await /** @type {any} */ (legacyStore).ensureCollection();
  const legacyStats = await legacyStore.stats();
  assert.match(String(legacyStats.indexNote), /AUTOINDEX/, '既有索引与配置不一致时必须给出提示');
  assert.strictEqual(legacyStats.indexType, 'HNSW', '配置侧的期望索引类型应如实暴露');
  await legacyStore.close();

  // 服务端不支持 Strong（如部分云托管）→ 自动退回服务端默认并记录一次
  const fallbackClient = createFakeMilvusClient();
  fallbackClient.state.rejectConsistency = true;
  const fallbackStore = createVectorStore({ backend: 'milvus', client: fallbackClient, root, dim: 256, topK: 8, collection: 'codenode_consistency_fallback' });
  await fallbackStore.applyChanges({ deleted: [], upserted: [records[0]] }, embedder);
  const fallbackScores = await fallbackStore.scoreCandidates('refreshSessionToken', null, embedder);
  assert.ok(fallbackScores.size > 0, '一致性级别被拒后应退回服务端默认并正常返回命中');
  const fallbackStats = await fallbackStore.stats();
  assert.strictEqual(fallbackStats.consistencyLevel, 'server-default');
  assert.match(String(fallbackStats.consistencyFallback), /consistency level not supported/, '降级原因必须可诊断');
  await fallbackStore.close();

  const deleted = await store.applyChanges({ deleted: [{ relative: 'src/auth.ts', chunkIds: ['src/auth.ts:1:8', 'src/auth.ts:9:16'] }], upserted: [] }, embedder);
  assert.ok(deleted.deleted >= 2, '按 file 过滤的删除应回报条数');
  assert.ok(fake.state.rows.every((row) => row.file !== 'src/auth.ts'), '变更文件的旧块必须删除，避免残留旧版本');
  assert.ok(fake.state.rows.some((row) => row.file === 'docs/guide.md'), '其他文件的向量不得被误删');
  await store.close();
  assert.strictEqual(fake.state.closed, false, '注入的客户端不应由适配器关闭（生命周期归调用方）');

  // ---- 4. 维度不一致 → 可读错误 ----
  const mismatchClient = createFakeMilvusClient();
  await mismatchClient.createCollection({
    collection_name: 'codenode_dim_mismatch',
    fields: [
      { name: 'id', data_type: 21, max_length: 2048 },
      { name: 'file', data_type: 21, max_length: 2048 },
      { name: 'vector', data_type: 101, dim: 128 },
    ],
  });
  const mismatchStore = createVectorStore({ backend: 'milvus', client: mismatchClient, root, dim: 256, collection: 'codenode_dim_mismatch' });
  await assert.rejects(() => /** @type {any} */ (mismatchStore).ensureCollection(), /维度/, '已有 collection 维度不一致应给出可读错误');
  await mismatchStore.close();

  // ---- 5. SDK 缺失提示（未安装时才可断言） ----
  let sdkInstalled = false;
  try {
    milvus.loadSdk();
    sdkInstalled = true;
  } catch (error) {
    assert.match(error.message, /npm i @zilliz\/milvus2-sdk-node/, '缺 SDK 时应给出可执行安装指令');
  }
  assert.match(milvus.stringLiteral('a"b\\c'), /^".*"$/, 'filter 字面量应加引号');

  // ---- 6. LocalRagIndex + milvus 后端：写入 / file 模式 / vector 模式 ----
  write('src/auth/session.ts', 'export function refreshSessionToken(token) { return token + "-rotated"; }');
  write('docs/guide.md', '登录会话使用刷新令牌轮换机制，客户端无需交互登录。');
  write('src/payments/invoice.ts', 'export function calculateInvoiceTotal(items) { return items.reduce((n, x) => n + x.price, 0); }');
  const indexClient = createFakeMilvusClient();
  const config = {
    enabled: true,
    embedProvider: 'local',
    embedDim: 256,
    vectorStore: 'milvus',
    vectorStoreClient: indexClient,
    milvusCollection: 'codenode_test_index',
    chunkLines: 8,
    chunkOverlap: 2,
    topK: 5,
    maxChars: 4000,
    maxQueries: 3,
    minCoverage: 0.2,
    embedTopK: 10,
  };
  const index = new LocalRagIndex(root, config);

  const fileMode = await index.retrieve('refreshSessionToken', { mode: 'file' });
  assert.strictEqual(vectorStats(fileMode).backend, 'none', 'file 模式不启用向量层');
  assert.ok(indexClient.state.rows.length >= 3, 'refresh 期间的增删应在检索时落库（与检索模式无关）');
  assert.strictEqual(indexClient.state.searches, 0, 'file 模式不得调用向量检索');

  const vectorMode = await index.retrieve('refreshSessionToken 轮换', { mode: 'vector' });
  assert.strictEqual(vectorStats(vectorMode).backend, 'milvus');
  assert.strictEqual(vectorStats(vectorMode).prefiltered, false);
  assert.ok(indexClient.state.searches >= 1, 'vector 模式应调用全库检索');
  assert.ok(vectorMode.results.some((item) => item.vectorScore > 0), '结果应携带向量分');

  // 增量：未变文件不重写（第二次检索无新写入）
  const rowsBefore = indexClient.state.rows.length;
  await index.retrieve('refreshSessionToken 轮换', { mode: 'vector' });
  assert.strictEqual(indexClient.state.rows.length, rowsBefore, '未变文件不应重复写入向量');

  // ---- 7. 纯语义命中（BM25 未召回）并入结果 ----
  const guideChunk = index.chunks.find((chunk) => chunk.path === 'docs/guide.md');
  assert.ok(guideChunk, '应存在 docs/guide.md 的块');
  indexClient.state.forceHits = [{ id: guideChunk.id, score: 0.92 }];
  const semantic = await index.retrieve('totallyAbsentQuantumBananaIdentifier', { mode: 'vector' });
  assert.strictEqual(semantic.results.length, 1, 'BM25 无命中时，向量后端命中应并入结果');
  assert.strictEqual(semantic.results[0].path, 'docs/guide.md');
  assert.strictEqual(semantic.results[0].vectorOnly, true, '纯语义命中必须标记 vector-only');
  assert.ok(semantic.results[0].vectorScore > 0.9);
  assert.strictEqual(vectorStats(semantic).vectorOnly, 1);
  const bm25Only = await index.retrieve('totallyAbsentQuantumBananaIdentifier', { mode: 'file' });
  assert.strictEqual(bm25Only.results.length, 0, '对照：关闭向量层时同一查询无结果');
  indexClient.state.forceHits = null;

  // ---- 8. 后端不可用 → 降级为纯 BM25（不抛错、不静默） ----
  indexClient.state.failing = true;
  const degraded = await index.retrieve('refreshSessionToken 轮换', { mode: 'vector' });
  assert.ok(degraded.results.some((item) => item.path === 'src/auth/session.ts'), '向量后端失败时 BM25 结果仍应返回');
  assert.strictEqual(vectorStats(degraded).rankedWithVector, 0);
  assert.match(String(vectorStats(degraded).error), /fake milvus 不可用/, '降级原因必须出现在诊断中');

  const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });
  const toolContext = new AgentToolContext({ projectRoot: root, ragConfig: config });
  const degradedTool = await registry.execute('retrieve_context', { query: 'refreshSessionToken 轮换', mode: 'vector' }, toolContext);
  assert.strictEqual(degradedTool.ok, true, '后端不可用时检索工具仍应成功（降级而非失败）');
  assert.match(degradedTool.text, /向量后端降级/, '降级必须在工具文本中可见');
  assert.match(degradedTool.text, /fake milvus 不可用/);

  indexClient.state.failing = false;
  const healthyTool = await registry.execute('retrieve_context', { query: 'refreshSessionToken 轮换', mode: 'vector' }, toolContext);
  assert.strictEqual(healthyTool.ok, true);
  assert.ok(!/向量后端降级/.test(healthyTool.text), '恢复后不应再提示降级');
  assert.strictEqual(healthyTool.data.index.vector.backend, 'milvus');

  // ---- 8b. 服务端「状态失败」不得被当成零命中（真机实测：topk 缺失时 SDK 不抛异常，只回空 results） ----
  indexClient.state.statusError = 'topk is required';
  const statusFailed = await index.retrieve('refreshSessionToken 轮换', { mode: 'vector' });
  assert.match(
    String(vectorStats(statusFailed).error),
    /topk is required/,
    '服务端 status 失败必须浮出到 stats.vector.error（否则表现为「静默零命中」）'
  );
  assert.ok(statusFailed.results.some((item) => item.path === 'src/auth/session.ts'), 'status 失败时仍应返回 BM25 结果');
  const statusFailedTool = await registry.execute('retrieve_context', { query: 'refreshSessionToken 轮换', mode: 'vector' }, toolContext);
  assert.match(statusFailedTool.text, /向量后端降级/);
  indexClient.state.statusError = null;

  // 写入侧同理：insert 的 status 失败必须抛错（不能把失败算成写入成功）
  const insertStatusClient = createFakeMilvusClient();
  insertStatusClient.insert = async () => ({ status: { error_code: 'UnexpectedError', reason: 'insert rejected', code: 65535 }, insert_cnt: '0' });
  const insertStatusStore = createVectorStore({ backend: 'milvus', client: insertStatusClient, root, dim: 256, topK: 5, collection: 'codenode_status_guard' });
  await assert.rejects(
    () => insertStatusStore.applyChanges({ deleted: [], upserted: records }, embedder),
    /insert rejected/,
    'insert 的 status 失败必须抛错，不能静默计为成功'
  );
  await insertStatusStore.close();

  // ---- 9. 真实 Milvus 端到端（MILVUS_ADDR 守卫） ----
  const address = String(process.env.MILVUS_ADDR || '').trim();
  let realMilvus = 'skipped';
  let realDetail = null;
  if (!address) {
    console.log('[skip] 未设置 MILVUS_ADDR：跳过真实 Milvus 端到端（不影响适配器覆盖）');
  } else {
    const realProvider = String(process.env.EMBED_PROVIDER || 'local');
    const realModel = String(process.env.EMBED_MODEL || '');
    const realBase = String(process.env.EMBED_BASE || '');
    const realKey = String(process.env.EMBED_KEY || (realProvider === 'local' ? '' : 'local-embed'));
    const realDim = Number(process.env.MILVUS_DIM || 256);
    const realEmbedder = createEmbedder({
      embedProvider: realProvider,
      embedModel: realModel,
      embedBase: realBase,
      embedKey: realKey,
      embedDim: realDim,
      embedDimensions: process.env.EMBED_DIMENSIONS || '',
    });
    let semanticDetail = null;
    const userCollection = String(process.env.MILVUS_COLLECTION || '').trim();
    const baseCollection = userCollection || milvus.defaultCollectionName(root);
    const storeCollection = baseCollection + '_store';
    const indexCollection = baseCollection + '_index';
    // 用户显式指定的 collection 不删除；测试自建的两个在结束时清理
    const ownedCollections = userCollection ? [] : [storeCollection, indexCollection];
    const realStore = createVectorStore({ backend: 'milvus', root, dim: realDim, topK: 8, address, collection: storeCollection });
    try {
      // 9a 后端直连：建表（HNSW）/写入/检索/删除
      const realApplied = await realStore.applyChanges({ deleted: [], upserted: records }, realEmbedder);
      assert.ok(realApplied.inserted >= records.length, '真实 Milvus 应写入全部记录');
      const searchStarted = Date.now();
      const realScores = await realStore.scoreCandidates('refreshSessionToken', null, realEmbedder);
      const searchMs = Date.now() - searchStarted;
      assert.ok(realScores.size > 0, '真实 Milvus 应返回检索命中');
      assert.ok([...realScores.values()].every((value) => Number.isFinite(value) && value >= 0));

      // 9b 索引端到端：不注入客户端，走真服务（refresh → syncVectorStore → 全库 ANN → 融合）
      const realConfig = {
        ...config,
        embedProvider: realProvider,
        embedModel: realModel,
        embedBase: realBase,
        embedKey: realKey,
        embedDim: realDim,
        vectorStoreClient: null,
        milvusCollection: indexCollection,
      };
      const realIndex = new LocalRagIndex(root, realConfig);
      const realRetrieval = await realIndex.retrieve('refreshSessionToken 轮换 令牌', { mode: 'vector' });
      assert.strictEqual(vectorStats(realRetrieval).backend, 'milvus', '真实服务下后端应为 milvus');
      assert.strictEqual(vectorStats(realRetrieval).error, undefined, '真实 Milvus 不应降级（' + vectorStats(realRetrieval).error + '）');
      assert.ok(realRetrieval.results.length > 0, '真实 Milvus 下应召回结果');
      assert.ok(realRetrieval.results.some((item) => item.vectorScore > 0), '真实 Milvus 应给出非零向量分');
      if (realProvider === 'local') {
        assert.strictEqual(realRetrieval.results[0].path, 'src/auth/session.ts', '向量模式应优先命中实现文件');
      } else {
        assert.ok(
          realRetrieval.results.some((item) => item.path === 'src/auth/session.ts'),
          '真嵌入下实现文件应出现在结果中'
        );
      }
      const realStoreStats = vectorStats(realRetrieval).store || {};
      assert.strictEqual(realStoreStats.indexType, 'HNSW', '真实服务应按配置建 HNSW 索引');
      assert.strictEqual(realStoreStats.metricType, 'COSINE');

      // 9b2 真嵌入的语义判别（哈希向量必然通不过）：中文改写 vs 无关代码，无共同词面
      if (realProvider !== 'local') {
        const semanticRecords = [
          {
            id: 'src/auth.ts:1:8',
            path: 'src/auth.ts',
            text: 'src/auth.ts\nexport function refreshSessionToken(token) { return token + "-rotated"; }',
          },
          {
            id: 'src/payments/invoice.ts:1:2',
            path: 'src/payments/invoice.ts',
            text: 'src/payments/invoice.ts\nexport function calculateInvoiceTotal(items) { return items.reduce((n, x) => n + x.price, 0); }',
          },
        ];
        await realStore.applyChanges(
          {
            deleted: [
              { relative: 'src/auth.ts', chunkIds: [] },
              { relative: 'src/payments/invoice.ts', chunkIds: [] },
            ],
            upserted: semanticRecords,
          },
          realEmbedder
        );
        const paraphraseQuery = '会话令牌续期怎么做';
        const paraphrase = await realStore.scoreCandidates(paraphraseQuery, null, realEmbedder);
        const authScore = paraphrase.get('src/auth.ts:1:8') || 0;
        const paymentsScore = paraphrase.get('src/payments/invoice.ts:1:2') || 0;
        assert.ok(authScore > 0.3, '真嵌入应对相关代码给出正相关（实测 ' + authScore.toFixed(4) + '）');
        assert.ok(
          authScore > paymentsScore,
          '真嵌入应能区分相关/无关（会话令牌 ' + authScore.toFixed(4) + ' vs 支付发票 ' + paymentsScore.toFixed(4) + '）'
        );
        semanticDetail = {
          provider: realProvider,
          model: realModel || '(默认)',
          query: paraphraseQuery,
          authScore: Number(authScore.toFixed(4)),
          paymentsScore: Number(paymentsScore.toFixed(4)),
        };
      }

      // 9c 删除传播：按 file 过滤删除后不得再召回该文件的块
      //    Milvus 默认 Bounded 一致性，删除有几秒可见性延迟（实测 ~3s），故轮询等待而非立即断言
      await realStore.applyChanges({ deleted: [{ relative: 'src/auth.ts', chunkIds: [] }], upserted: [] }, realEmbedder);
      let afterDelete = await realStore.scoreCandidates('refreshSessionToken', null, realEmbedder);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (![...afterDelete.keys()].some((id) => id.startsWith('src/auth.ts'))) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        afterDelete = await realStore.scoreCandidates('refreshSessionToken', null, realEmbedder);
      }
      assert.ok(
        ![...afterDelete.keys()].some((id) => id.startsWith('src/auth.ts')),
        '按 file 删除后（等待可见性）不应再召回该文件的块，实际仍为：' + [...afterDelete.keys()].join(',')
      );

      const storeStats = await realStore.stats();
      realDetail = {
        store: storeCollection,
        index: indexCollection,
        dim: realDim,
        embedProvider: realProvider,
        embedModel: realModel || '(provider 默认)',
        semantic: semanticDetail,
        indexType: storeStats.indexType,
        metricType: storeStats.metricType,
        indexM: storeStats.indexM,
        indexEfConstruction: storeStats.indexEfConstruction,
        searchEf: storeStats.searchEf,
        consistency: storeStats.consistencyLevel,
        inserted: realApplied.inserted,
        hits: realScores.size,
        indexResults: realRetrieval.results.length,
        topVectorScore: realRetrieval.results[0].vectorScore,
        singleSearchMs: searchMs,
        afterDeleteRemaining: afterDelete.size,
        storeCounters: { batches: storeStats.batches, searches: storeStats.searches, flushes: storeStats.flushes },
      };
      realMilvus = 'pass';
    } finally {
      await realStore.close();
      if (ownedCollections.length) {
        try {
          const sdk = milvus.loadSdk();
          const admin = new sdk.MilvusClient({ address });
          for (const name of ownedCollections) {
            await admin.dropCollection({ collection_name: name });
          }
          if (typeof admin.close === 'function') admin.close();
          realDetail = { ...(realDetail || {}), dropped: ownedCollections };
        } catch (error) {
          console.log('[warn] 测试自建 collection 清理失败（可忽略）：' + ((error && error.message) || error));
        }
      }
    }
  }

  console.log(
    'VECTOR STORE TEST: PASS',
    JSON.stringify({
      backends: BACKENDS,
      sdkInstalled,
      collectionCreated: fake.state.created[0],
      insertedRows: fake.state.rows.length,
      vectorStoreModes: ['file', 'vector'],
      vectorOnlySources: vectorStats(semantic).vectorOnly,
      degradedReported: true,
      realMilvus,
      realDetail,
    })
  );
}

main()
  .catch((error) => {
    console.error('VECTOR STORE TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearIndexCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
