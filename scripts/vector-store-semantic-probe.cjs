'use strict';

/**
 * 真嵌入 + Milvus 的语义检索验证（可选，需外部服务；不进 core 门禁）。
 *
 * 用途：证明「真嵌入 + 全库 ANN」相对纯 BM25 的语义收益——中文问句检索英文代码，
 * 词面无交集（BM25 必然 0 命中），向量层应正确命中并以 vector-only 标记返回。
 *
 * 前置：
 *   1) Milvus 服务（本仓库可用 .cache/milvus-dev/docker-compose.yml 起）
 *   2) OpenAI 兼容的嵌入服务（如 llama.cpp：llama-server -m bge-m3-Q8_0.gguf --embeddings --pooling cls）
 *
 * 运行（示例：本地 llama-server + bge-m3）：
 *   MILVUS_ADDR=http://127.0.0.1:19530 \
 *   EMBED_BASE=http://127.0.0.1:8080/v1 EMBED_MODEL=bge-m3 EMBED_DIM=1024 \
 *   node scripts/vector-store-semantic-probe.cjs
 *
 * 未设置 MILVUS_ADDR 时明确 SKIP（不静默通过）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalRagIndex, clearIndexCache } = require('../electron/rag/index.cjs');
// 可选 SDK（@zilliz/milvus2-sdk-node）只经生产入口惰性加载：模块名不做字面量 require，
// 否则 check:js（tsc）会在「未安装该可选依赖」的环境（CI 三平台）报 TS2307 而整条门禁变红。
const { loadSdk } = require('../electron/vectorStore/milvus.cjs');

const MILVUS_ADDR = String(process.env.MILVUS_ADDR || '').trim();
const EMBED_BASE = String(process.env.EMBED_BASE || '').trim();
const EMBED_MODEL = String(process.env.EMBED_MODEL || 'bge-m3').trim();
const EMBED_DIM = Number(process.env.EMBED_DIM || 1024);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-semantic-probe-'));

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/** 词面完全无交集的中文问句 → 期望命中的文件（英文代码）。 */
const CASES = [
  { query: '会话怎么续期', expected: 'src/auth/session.ts' },
  { query: '账单金额怎么算', expected: 'src/payments/invoice.ts' },
  { query: '日期格式化', expected: 'src/format/date.ts' },
];

async function main() {
  if (!MILVUS_ADDR) {
    console.log('[skip] 未设置 MILVUS_ADDR：跳过语义检索验证（需要 Milvus + 嵌入服务）');
    return;
  }
  if (!EMBED_BASE) {
    console.log('[skip] 未设置 EMBED_BASE：跳过语义检索验证（需要 OpenAI 兼容嵌入服务）');
    return;
  }

  write(
    'src/auth/session.ts',
    ['export function refreshSessionToken(token: string) {', '  const nonce = rotateNonce(token);', '  return exchange(nonce);', '}'].join('\n')
  );
  write(
    'src/payments/invoice.ts',
    ['export function calculateInvoiceTotal(items) {', '  return items.reduce((sum, item) => sum + item.price, 0);', '}'].join('\n')
  );
  write('src/format/date.ts', 'export function formatDate(value: Date) { return value.toISOString().slice(0, 10); }');
  write('docs/architecture.md', '# 架构说明\n\nsrc 为业务代码，docs 为文档。');

  const collection = 'codenode_semantic_probe_' + Date.now().toString(36);
  const config = {
    enabled: true,
    embedProvider: 'openai',
    embedModel: EMBED_MODEL,
    embedBase: EMBED_BASE,
    embedKey: process.env.EMBED_KEY || 'local-embed',
    embedDim: EMBED_DIM,
    vectorStore: 'milvus',
    milvusAddress: MILVUS_ADDR,
    milvusCollection: collection,
    chunkLines: 12,
    chunkOverlap: 2,
    topK: 3,
    maxChars: 4000,
    maxQueries: 3,
    minCoverage: 0.2,
    embedTopK: 20,
  };

  const index = new LocalRagIndex(root, config);
  const summary = [];
  try {
    for (const item of CASES) {
      const bm25 = await index.retrieve(item.query, { mode: 'file' });
      const semantic = await index.retrieve(item.query, { mode: 'vector' });
      const top = semantic.results[0];
      summary.push({
        query: item.query,
        bm25Hits: bm25.results.length,
        semanticTop: top ? top.path : null,
        vectorScore: top ? top.vectorScore : null,
        vectorOnly: !!(top && top.vectorOnly),
      });
      assert.strictEqual(bm25.results.length, 0, '中文问句与英文代码无词面交集，纯 BM25 应为 0 命中：' + item.query);
      assert.ok(top, '语义检索应有结果：' + item.query);
      assert.strictEqual(top.path, item.expected, '语义检索应命中预期文件：' + item.query);
      assert.strictEqual(top.vectorOnly, true, 'BM25 未召回、仅向量命中时应标记 vector-only：' + item.query);
      assert.ok(top.vectorScore > 0.3, '真嵌入应给出明确的正相关分数：' + item.query);
    }
    console.log('SEMANTIC PROBE: PASS', JSON.stringify({ embedModel: EMBED_MODEL, dim: EMBED_DIM, cases: summary }));
  } finally {
    clearIndexCache();
    try {
      const milvus = loadSdk();
      const admin = /** @type {any} */ (new milvus.MilvusClient({ address: MILVUS_ADDR }));
      await admin.dropCollection({ collection_name: collection });
      if (typeof admin.close === 'function') admin.close();
    } catch (error) {
      console.log('[warn] 临时 collection 清理失败：' + ((error && error.message) || error));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('SEMANTIC PROBE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
