'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ScalarStore,
  clearScalarCache,
  getScalarStore,
  nodeToScalarRecords,
} = require('../electron/scalars/index.cjs');
const { localVector, cosine, tokenizeText } = require('../electron/embedder/index.cjs');
const {
  clearIndexCache,
  getProjectIndex,
} = require('../electron/rag/index.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const {
  shouldCompress,
  buildToolContent,
  compressorSystemPrompt,
  compressToolContent,
  SCALAR_BACKED_TOOLS,
  loadConfig,
} = require('../electron/agent.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-scalar-vector-test-'));

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function compactNode(id, label, prompt, status) {
  return { id, type: 'task', position: { x: 10, y: 20 }, data: { label, prompt, status: status || 'pending' } };
}

async function main() {
  // ---- 1. ScalarStore 基础读写与持久化 ----
  const store = new ScalarStore(root);
  store.set('node:n1', { id: 'n1', type: 'task', label: '登录模块', prompt: '实现登录与令牌轮换' }, 'node');
  store.set('node:n1:prompt', '实现登录与令牌轮换', 'node');
  store.set('node:n1:label', '登录模块', 'node');
  store.set('project:name', 'demo', 'project');
  assert.strictEqual(store.get('node:n1').label, '登录模块');
  assert.strictEqual(store.get('node:n1:prompt'), '实现登录与令牌轮换');
  const byPrefix = store.query({ prefix: 'node:n1' });
  assert.ok(byPrefix.length >= 3, 'prefix 应命中多个标量');
  const exact = store.query({ key: 'node:n1' });
  assert.strictEqual(exact[0].exact, true);
  assert.strictEqual(exact[0].value.prompt, '实现登录与令牌轮换');
  // 持久化：新实例重新加载同一文件
  const store2 = new ScalarStore(root);
  assert.strictEqual(store2.get('node:n1').label, '登录模块', 'scalars.json 应持久化');

  // ---- 2. 节点标量提取 ----
  const records = nodeToScalarRecords(compactNode('n2', '检索模块', '用 RAG 检索项目'));
  assert.ok(records.some((r) => r.key === 'node:n2' && r.value.prompt === '用 RAG 检索项目'));
  assert.ok(records.some((r) => r.key === 'node:n2:prompt'));
  assert.ok(records.some((r) => r.key === 'node:n2:label'));

  // ---- 3. query_scalars 工具（注册 + 端到端） ----
  clearScalarCache();
  const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });
  assert.ok(registry.listTools().some((t) => t.name === 'query_scalars'), '应注册 query_scalars');
  const toolContext = new AgentToolContext({ projectRoot: root, scalarStore: getScalarStore(root), ragConfig: { enabled: true } });
  const qr = await registry.execute('query_scalars', { key: 'node:n1' }, toolContext);
  assert.strictEqual(qr.ok, true);
  assert.ok(qr.data.items.some((i) => i.key === 'node:n1'), 'query_scalars 应返回精确标量');
  assert.ok(qr.text.includes('node:n1'), '文本应包含 key');

  // ---- 4. 画布工具：属性入本地标量，返回结果不含完整 prompt ----
  const doc = { root: { nodes: [compactNode('n3', '画布任务', '这是一个很长很长的节点提示词不应返回云端', 'pending')], edges: [] } };
  const GraphModel = require('../electron/tools/GraphModel.cjs').GraphModel;
  const model = new GraphModel(JSON.parse(JSON.stringify(doc)));
  const ctx2 = new AgentToolContext({
    projectRoot: root,
    model,
    scalarStore: getScalarStore(root),
    ragConfig: { enabled: true },
    mutateWorkbench: async (fn) => {
      fn(model);
      return true;
    },
  });
  const gwm = await registry.execute('get_workbench_model', { view: 'full' }, ctx2);
  assert.strictEqual(gwm.ok, true);
  assert.ok(!gwm.text.includes('这是一个很长很长的节点提示词'), '画布工具文本不得把完整 prompt 返回上下文');
  assert.ok(gwm.text.includes('本地标量'), '应提示标量已本地化');
  assert.strictEqual(getScalarStore(root).get('node:n3:prompt'), '这是一个很长很长的节点提示词不应返回云端', '完整 prompt 应写入本地标量');
  const gwmCounts = await registry.execute('get_workbench_model', { view: 'counts' }, ctx2);
  assert.strictEqual(gwmCounts.data.nodeCount, 1);

  // 画布修改工具：workbench_edit 创建节点 → 标量入库
  const edits = await registry.execute('workbench_edit', { operations: [{ action: 'create', name: '新增节点', prompt: '节点职责：写接口' }] }, ctx2);
  assert.strictEqual(edits.ok, true);
  const createdId = edits.data.created[0];
  assert.strictEqual(getScalarStore(root).get('node:' + createdId + ':prompt'), '节点职责：写接口', 'workbench_edit 创建节点应写入标量');
  const scalarQuery = await registry.execute('query_scalars', { key: 'node:' + createdId + ':label' }, ctx2);
  assert.strictEqual(scalarQuery.data.items[0].value, '新增节点');

  // ---- 5. retrieve_context scalar 模式 ----
  const sr = await registry.execute('retrieve_context', { query: 'node:' + createdId, mode: 'scalar' }, ctx2);
  assert.strictEqual(sr.ok, true);
  assert.ok(sr.data.sources.some((s) => s.citation === 'scalar:node:' + createdId), '标量模式应返回 scalar:<key> 来源');

  // ---- 5b. 标量语义搜索（无需精确 key）+ auto 自动路由 ----
  const searchHits = getScalarStore(root).search({ query: '登录模块的 prompt', max: 5 });
  assert.ok(searchHits.length >= 1, '语义搜索应命中标量');
  assert.ok(searchHits.some((h) => h.key === 'node:n1:prompt'), '语义搜索应命中 prompt 单属性记录');
  assert.ok(searchHits[0].score > 0, '语义搜索应带分数');
  const autoR = await registry.execute('retrieve_context', { query: '新增节点的名字', mode: 'auto' }, ctx2);
  assert.strictEqual(autoR.ok, true);
  assert.ok(autoR.data.routing && autoR.data.routing.source, 'auto 模式应返回路由决策');
  assert.ok(autoR.data.sources.some((s) => s.kind === 'scalar' && s.key === 'node:' + createdId + ':label'), 'auto 应按名字语义路由到标量 label');
  const fileR = await registry.execute('retrieve_context', { query: '这段代码如何实现', mode: 'auto' }, ctx2);
  assert.strictEqual(fileR.ok, true);
  assert.ok(fileR.data.routing, 'auto 模式应带路由信息');
  const semanticScalarTool = await registry.execute('query_scalars', { query: '登录模块的 prompt' }, ctx2);
  assert.strictEqual(semanticScalarTool.ok, true);
  assert.ok(semanticScalarTool.data.items.some((i) => i.key === 'node:n1:prompt'), 'query_scalars 应支持自然语言语义查询');

  // ---- 6. 本地向量：相关文本余弦更高且确定 ----
  const v1 = localVector('refreshSessionToken 登录 令牌 轮换', 1024);
  const v2 = localVector('refreshSessionToken session token rotate', 1024);
  const v3 = localVector('支付 发票 金额 计算', 1024);
  assert.ok(cosine(v1, v2) > 0, '相关文本应有正余弦');
  assert.ok(cosine(v1, v2) > cosine(v1, v3), '语义相近应高于无关');
  const v1b = localVector('refreshSessionToken 登录 令牌 轮换', 1024);
  assert.deepStrictEqual(v1, v1b, 'local 向量必须确定性');
  assert.ok(tokenizeText('refreshSessionToken').includes('session'), '嵌入分词应拆驼峰');

  // ---- 7. RAG 向量融合 ----
  write('src/auth/session.ts', 'export function refreshSessionToken(token: string) { return token + "-rotated"; }');
  write('docs/guide.md', '登录会话使用刷新令牌轮换机制，无需交互登录。');
  const ragCfg = { enabled: true, maxFiles: 100, maxFileBytes: 100000, chunkLines: 8, chunkOverlap: 2, topK: 5, maxContextChars: 4000, maxQueries: 3, minCoverage: 0.2, embedProvider: 'local', embedDim: 1024, vectorWeight: 0.35 };
  const idx = getProjectIndex(root, ragCfg);
  const withVec = await idx.retrieve('refreshSessionToken', { mode: 'vector' });
  assert.ok(withVec.results.length > 0, '向量模式应有结果');
  assert.ok(withVec.results.every((r) => typeof r.vectorScore === 'number'), '结果应带 vectorScore');
  assert.strictEqual(withVec.stats.vector.provider, 'local');
  assert.ok(withVec.results[0].path.includes('session'), '向量模式应优先命中实现文件');
  const noVec = await idx.retrieve('refreshSessionToken', { mode: 'file' });
  assert.ok(noVec.results.every((r) => r.vectorScore === 0), 'file 模式不启用向量');

  // ---- 8. 压缩配置与判定 ----
  const cfgFromProps = loadConfig(root);
  assert.strictEqual(cfgFromProps.compression.enabled, true);
  assert.ok(cfgFromProps.compression.exclude.includes('retrieve_context'), 'RAG 结果默认不压缩（保证引用保真）');
  assert.ok(cfgFromProps.scalars.enabled !== false);
  assert.ok(['local', 'openai', 'ollama', 'none'].includes(cfgFromProps.rag.embedProvider));

  const comp = { enabled: true, thresholdChars: 100, budgetChars: 300, maxCalls: 3, exclude: ['ask_user'] };
  assert.strictEqual(shouldCompress(comp, 'read_file', 500, 0), true);
  assert.strictEqual(shouldCompress(comp, 'read_file', 50, 0), false, '低于阈值不压缩');
  assert.strictEqual(shouldCompress(comp, 'ask_user', 500, 0), false, 'exclude 列表不压缩');
  assert.strictEqual(shouldCompress(comp, 'read_file', 500, 3), false, '达到调用上限不压缩');
  assert.strictEqual(shouldCompress({ enabled: false }, 'read_file', 500, 0), false, '总开关关闭不压缩');

  // ---- 9. buildToolContent：标量工具不追加 [data] ----
  const result = { ok: true, text: '紧凑摘要', data: { nodeIds: ['n1'], prompt: 'secret-prompt-data' } };
  const scalarBacked = buildToolContent(result, 'get_workbench_model', false, false, 100000);
  assert.ok(!scalarBacked.includes('[data]'), '标量工具不得把 data 追加进上下文');
  assert.ok(SCALAR_BACKED_TOOLS.has('get_workbench_model'));
  const fileBacked = buildToolContent(result, 'read_file', false, false, 100000);
  assert.ok(fileBacked.includes('[data]'), '普通工具应追加 data');

  // ---- 10. 子代理压缩：失败时降级为截断（用不可达端口快速失败） ----
  assert.ok(compressorSystemPrompt(300).includes('300'), '压缩提示应带预算');
  const raw = 'line1\n'.repeat(400) + 'KEY_DETAIL=' + 'x'.repeat(600);
  const failedCfg = { apiBase: 'http://127.0.0.1:9', apiKey: '', model: 'test', maxTokens: 256, reasoningEffort: '', compression: { budgetChars: 300 } };
  const compressed = await compressToolContent(failedCfg, 'read_file', raw);
  assert.ok(compressed.includes('子代理压缩失败'), '压缩失败应降级为截断');
  assert.ok(compressed.length <= 400, '降级输出不应超过预算过多');

  console.log(
    'SCALAR VECTOR TEST: PASS',
    JSON.stringify({
      scalars: getScalarStore(root).summary(),
      createdNode: createdId,
      scalarModeSources: sr.data.sources.length,
      vectorTop: withVec.results[0] && withVec.results[0].path,
      vectorScore: withVec.results[0] && withVec.results[0].vectorScore,
    })
  );
}

main()
  .catch((error) => {
    console.error('SCALAR VECTOR TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearScalarCache();
    clearIndexCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
