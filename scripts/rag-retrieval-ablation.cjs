'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const arg = (name, fallback) => process.argv.find((item) => item.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
async function main() {
  const { dataset, lock } = loadFrozen();
  const output = path.resolve(arg('out', 'out/rag-retrieval-ablation.json'));
  if (fs.existsSync(output)) throw new Error('Report exists; choose a new output path');
  const embedBase = process.env.EMBED_BASE || 'http://127.0.0.1:18765/v1';
  const rerankUrl = process.env.RERANK_URL || 'http://127.0.0.1:18766/rerank';
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(embedBase) || !/^http:\/\/127\.0\.0\.1:\d+\//.test(rerankUrl)) throw new Error('This experiment only permits loopback model services');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-retrieval-ablation-'));
  const base = { embedProvider: 'none', topK: 6, graphHops: 1, maxContextChars: 12000 };
  const embedding = arg('embedding', 'e5');
  if (!['e5', 'jina'].includes(embedding)) throw new Error('embedding must be e5 or jina');
  const semantic = { ...base, embedProvider: 'openai', embedBase, embedKey: 'local-experiment',
    embedModel: embedding === 'e5' ? 'multilingual-e5-small-int8' : 'jina-embeddings-v2-base-code-int8',
    embedDim: embedding === 'e5' ? 384 : 768, embedQueryPrefix: embedding === 'e5' ? 'query: ' : '',
    embedDocumentPrefix: embedding === 'e5' ? 'passage: ' : '', memorySemanticMaxChunks: 5000, vectorWeight: 0.35 };
  const variants = [
    { name: 'bm25', options: base, mode: 'file', pureVector: false },
    { name: 'strict-dense-e5', options: { ...semantic, graphHops: 0 }, mode: 'vector', pureVector: true },
    { name: 'hybrid-e5', options: semantic, mode: 'hybrid', pureVector: false },
    { name: 'hybrid-e5-crossencoder', options: { ...semantic, rerankUrl, rerankModel: 'mmarco-mMiniLMv2-L12-H384-v1-int8', rerankTimeoutMs: 60000 }, mode: 'hybrid', pureVector: false },
  ];
  if (embedding === 'jina') for (const variant of variants) variant.name = variant.name.replace('-e5', '-jina');
  const report = { datasetHash: lock.datasetSha256, role: 'exposed-regression-ablation',
    labels: 'AI authored; no human gold', embedding,
    retrievalHashes: Object.fromEntries(['index', 'codeStructure', 'rerank'].map((name) => [name,
      require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../electron/rag/' + name + '.cjs'))).digest('hex')])),
    startedAt: new Date().toISOString(), results: [] };
  try {
    for (const [file, text] of Object.entries(dataset.files)) {
      const target = path.resolve(root, file);
      if (!target.startsWith(root + path.sep)) throw new Error('Unsafe snapshot path');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
    }
    const selected = arg('variants', '').split(',').filter(Boolean);
    if (selected.some((name) => !variants.some((variant) => variant.name === name))) throw new Error('Unknown experiment variant');
    for (const variant of variants.filter((item) => !selected.length || selected.includes(item.name))) {
      const index = new LocalRagIndex(root, variant.options);
      const rows = [];
      for (const item of dataset.cases) {
        const started = performance.now();
        const result = await index.retrieve(item.query, { mode: variant.mode, pureVector: variant.pureVector });
        const stats = /** @type {any} */ (result.stats);
        if (variant.name !== 'bm25' && (stats.vector?.error || !stats.vector?.rankedWithVector)) throw new Error('Vector experiment failed/degraded: ' + stats.vector?.error);
        if (variant.name.endsWith('crossencoder') && !stats.rerank?.applied) throw new Error('Cross-encoder experiment failed/degraded: ' + stats.rerank?.error);
        const ranks = item.sources.map((gold) => result.results.findIndex((hit) => hit.path === gold.path &&
          (hit.excerpt.includes(gold.anchor) || hit.contexts.some((part) => part.excerpt.includes(gold.anchor)))) + 1);
        rows.push({ id: item.id, type: item.type, expected: item.expectedAnswerable, ranks,
          fileHit: item.sources.every((gold) => result.results.some((hit) => hit.path === gold.path)),
          durationMs: performance.now() - started, sourceIds: result.results.map((hit) => hit.citation),
          pureVector: stats.pureVector, reranked: stats.rerank?.applied || false });
        if (rows.length % 20 === 0) console.log(variant.name, rows.length + '/100');
      }
      const positive = rows.filter((row) => row.expected);
      const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
      const metrics = { positiveCount: positive.length,
        allFileRecallAt6: positive.filter((row) => row.fileHit).length / positive.length,
        allEvidenceRecallAt6: positive.filter((row) => row.ranks.every((rank) => rank > 0)).length / positive.length,
        allEvidenceMrr: positive.reduce((sum, row) => sum + (row.ranks.every((rank) => rank > 0) ? 1 / Math.max(...row.ranks) : 0), 0) / positive.length,
        p50Ms: durations[Math.floor(durations.length / 2)], p95Ms: durations[Math.ceil(durations.length * 0.95) - 1], coldMs: rows[0].durationMs };
      report.results.push({ name: variant.name, metrics, rows });
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(variant.name, JSON.stringify(metrics));
      if (index.vectorStore) await index.vectorStore.close();
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
