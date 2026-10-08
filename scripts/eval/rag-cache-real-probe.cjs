'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEmbedder } = require("../../electron/embedder/index.cjs");
const { MemoryVectorStore } = require("../../electron/vectorStore/memory.cjs");
async function main() {
  const root = path.resolve(__dirname, "../..");
  const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const snapshot = execFileSync('git', ['show', baselineCommit + ':electron/vectorStore/memory.cjs'], { cwd: root, encoding: 'utf8' });
  const file = path.join(root, 'out/memory-before-concurrency-probe.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot.replace("require('../embedder/index.cjs')", 'require(' + JSON.stringify(path.join(root, 'electron/embedder/index.cjs')) + ')'));
  const OldStore = require(file).MemoryVectorStore;
  const embedder = createEmbedder({ embedProvider: 'openai', embedModel: 'jina-code', embedDim: 768,
    embedBase: 'http://127.0.0.1:18767/v1', embedKey: 'local-experiment' });
  await embedder.embed(['warmup']);
  const chunks = Array.from({ length: 32 }, (_, i) => ({ id: 'probe' + i + '.ts:1:1', path: 'probe' + i + '.ts',
    content: 'export const retryBudget' + i + ' = ' + (i + 1) + ';' }));
  const results = [];
  for (const [name, Store] of [['old-cache', OldStore], ['scoped-cache', MemoryVectorStore]]) {
    let documentRequests = 0;
    const tracked = { isLocal: () => false, model: 'jina-code', budget: null, signal: null,
      embed: async (texts, options) => { if (texts.length > 1) documentRequests++; return embedder.embed(texts, options); } };
    const store = new Store();
    const started = performance.now();
    const rows = await Promise.all([1, 2, 3].map(() => store.scoreCandidates('retry budget', chunks, tracked)));
    if (rows.some((row) => row.size !== 32)) throw new Error('Probe lost vector scores');
    results.push({ name, documentRequests, ms: performance.now() - started, stats: await store.stats() });
    await store.close();
  }
  const report = { baselineCommit, scenario: '32 local synthetic code documents, 3 simultaneous same-scope queries; single CPU measurement, not SLA', results };
  fs.writeFileSync(path.join(root, 'out/rag-real-cache-concurrency.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (results[0].documentRequests !== 3 || results[1].documentRequests !== 1) throw new Error('Concurrent request dedupe not observed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
