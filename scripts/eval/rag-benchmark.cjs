/** Frozen corpus evaluation. No network unless --real --confirm-send is explicit. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalRagIndex } = require("../../electron/rag/index.cjs");
const fixturePath = path.join(__dirname, "../fixtures/rag-benchmark-v1.json");
const baselinePath = path.join(__dirname, "../fixtures/rag-benchmark-baseline-v1.json");
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
async function main() {
  const raw = fs.readFileSync(fixturePath);
  const fixture = JSON.parse(raw.toString('utf8'));
  const hash = digest(raw);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  if (baseline && baseline.corpusHash !== hash) throw new Error('Frozen corpus changed: create a new benchmark version');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-rag-benchmark-'));
  const base = { embedProvider: 'none', topK: 6, graphHops: 1, maxContextChars: 12000 };
  const variants = [{ name: 'default-lexical', options: base, mode: 'auto' }];
  if (process.argv.includes('--ablation')) {
    variants.push({ name: 'bm25-no-graph', options: { ...base, graphHops: 0 }, mode: 'file' });
    variants.push({ name: 'hash-hybrid-control', options: { ...base, embedProvider: 'local' }, mode: 'auto' });
  }
  if (process.argv.includes('--real')) {
    if (!process.argv.includes('--confirm-send')) throw new Error('--real requires --confirm-send (sends frozen corpus to configured services)');
    if (!process.env.EMBED_BASE || !process.env.EMBED_MODEL) throw new Error('EMBED_BASE and EMBED_MODEL required');
    const real = { ...base, embedProvider: 'openai', embedBase: process.env.EMBED_BASE,
      embedModel: process.env.EMBED_MODEL, embedKey: process.env.EMBED_KEY || '',
      embedDim: Number(process.env.EMBED_DIM || 1024), memorySemanticMaxChunks: 10000 };
    variants.push({ name: 'real-dense', options: real, mode: 'vector' });
    variants.push({ name: 'real-hybrid', options: real, mode: 'hybrid' });
    if (process.env.RERANK_URL) variants.push({ name: 'real-hybrid-rerank', options: { ...real,
      rerankUrl: process.env.RERANK_URL, rerankKey: process.env.RERANK_KEY || '',
      rerankModel: process.env.RERANK_MODEL || '', rerankTopK: 24 }, mode: 'hybrid' });
  }
  const report = { version: fixture.version, corpusHash: hash, results: [] };
  try {
    for (const [relative, content] of Object.entries(fixture.files)) {
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) throw new Error('Invalid fixture path');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    }
    for (const variant of variants) {
      const index = new LocalRagIndex(root, variant.options);
      const rows = [];
      for (const item of fixture.cases) {
        for (const evidence of item.evidence) {
          if (!fixture.files[evidence.path]?.includes(evidence.text)) throw new Error('Missing gold evidence: ' + item.id);
        }
        const started = performance.now();
        const result = await index.retrieve(item.query, { mode: variant.mode });
        const stats = /** @type {any} */ (result.stats);
        const error = stats.vector?.error || stats.rerank?.error;
        if (variant.name.startsWith('real-') && !stats.vector?.rankedWithVector) throw new Error('Real experiment produced no vector scores');
        if (variant.name.endsWith('-rerank') && !stats.rerank?.applied) throw new Error('Reranker not applied');
        if (variant.name.startsWith('real-') && error) throw new Error('Real experiment degraded: ' + error);
        const rankOf = (evidence) => result.results.findIndex((hit) => hit.path === evidence.path &&
          (hit.excerpt.includes(evidence.text) || hit.contexts.some((context) => context.excerpt.includes(evidence.text)))) + 1;
        const ranks = item.evidence.map(rankOf);
        rows.push({ id: item.id, split: item.split, category: item.category, negative: !item.evidence.length,
          fileHit: item.evidence.every((e) => result.results.some((hit) => hit.path === e.path)),
          spanHit: ranks.every((rank) => rank > 0), ranks, answerable: result.quality.answerable,
          answerabilityStatus: result.quality.answerabilityStatus || 'unverified',
          ms: performance.now() - started });
      }
      const metrics = {};
      for (const split of ['development', 'holdout']) {
        const selected = rows.filter((row) => row.split === split);
        const positive = selected.filter((row) => !row.negative), negative = selected.filter((row) => row.negative);
        const latency = selected.map((row) => row.ms).sort((a, b) => a - b);
        metrics[split] = { positive: positive.length, negative: negative.length,
          fileRecallAt6: positive.filter((row) => row.fileHit).length / positive.length,
          allEvidenceRecallAt6: positive.filter((row) => row.spanHit).length / positive.length,
          mrr: positive.reduce((sum, row) => sum + (row.spanHit ? 1 / Math.max(...row.ranks) : 0), 0) / positive.length,
          noAnswerFalsePositiveRate: negative.filter((row) => row.answerable).length / negative.length,
          positiveAnswerableRate: positive.filter((row) => row.answerable).length / positive.length,
          verificationCoverage: selected.filter((row) => ['supported', 'insufficient'].includes(row.answerabilityStatus)).length / selected.length,
          p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] };
      }
      report.results.push({ name: variant.name, metrics, rows });
      console.log(variant.name, JSON.stringify(metrics));
      if (index.vectorStore) await index.vectorStore.close();
    }
    if (process.argv.includes('--freeze')) {
      if (baseline) throw new Error('Baseline already frozen; do not overwrite');
      fs.writeFileSync(baselinePath, JSON.stringify({ corpusHash: hash, metrics: report.results[0].metrics }, null, 2) + '\n');
    }
    if (process.argv.includes('--check')) {
      if (!baseline) throw new Error('Frozen baseline missing');
      for (const split of ['development', 'holdout']) {
        const current = report.results[0].metrics[split], gold = baseline.metrics[split];
        for (const metric of ['fileRecallAt6', 'allEvidenceRecallAt6', 'mrr']) {
          if (current[metric] + 1e-9 < gold[metric]) throw new Error('Regression: ' + split + '.' + metric);
        }
        if (current.noAnswerFalsePositiveRate > gold.noAnswerFalsePositiveRate) throw new Error('No-answer regression: ' + split);
      }
    }
    const out = process.argv.find((arg) => arg.startsWith('--out='));
    if (out) { const target = path.resolve(out.slice(6)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n'); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
