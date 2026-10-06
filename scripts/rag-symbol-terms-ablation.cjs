'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const vocabulary = require('../electron/rag/symbolTerms.cjs');
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
async function main() {
  const out = path.resolve(process.argv.find((item) => item.startsWith('--out='))?.slice(6) || 'out/rag-symbol-terms-ablation.json');
  if (fs.existsSync(out)) throw new Error('Output exists');
  const { dataset, lock } = loadFrozen();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-symbol-ablation-'));
  const original = vocabulary.symbolTerms;
  const report = { datasetHash: lock.datasetSha256, role: 'exposed-offline-symbol-vocabulary-ablation', variants: [] };
  try {
    for (const [file, text] of Object.entries(dataset.files)) {
      const target = path.resolve(root, file); if (!target.startsWith(root + path.sep)) throw new Error('Path escape');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
    }
    for (const enabled of [false, true]) {
      // Isolated synchronous process only: suppress retrieval vocabulary, keep all other code/options fixed.
      vocabulary.symbolTerms = enabled ? original : () => '';
      const index = new LocalRagIndex(root, { embedProvider: 'none', indexWorker: false, topK: 6, graphHops: 1, maxContextChars: 12000 });
      const rows = [];
      try {
        for (const item of dataset.cases.filter((item) => item.expectedAnswerable)) {
          const result = await index.retrieve(item.query, { mode: 'file', topK: 6 });
          const sources = result.results.flatMap((source) => [source, ...(source.contexts || [])]);
          const complete = item.sources.every((gold) => sources.some((source) => source.path === gold.path && source.excerpt.includes(gold.anchor)));
          rows.push({ id: item.id, complete, top: result.results[0]?.path, symbols: result.results.map((source) => source.symbol) });
        }
      } finally { index.close(); }
      report.variants.push({ enabled, count: rows.length, allEvidenceHits: rows.filter((row) => row.complete).length,
        allEvidenceRecallAt6: rows.filter((row) => row.complete).length / rows.length, rows });
    }
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.variants.map(({ rows, ...metrics }) => metrics)));
  } finally {
    vocabulary.symbolTerms = original;
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('rag-symbol-ablation-')) throw new Error('Cleanup boundary');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
