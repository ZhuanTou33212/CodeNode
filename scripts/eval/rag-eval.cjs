/**
 * 离线检索评测。固定问题与目标文件用于比较配置变化，不代表通用代码检索基准。
 * 用法：node scripts/eval/rag-eval.cjs [--out=out/rag-eval-report.json]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LocalRagIndex } = require("../../electron/rag/index.cjs");

const root = path.resolve(__dirname, "../..");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "./rag-eval-cases.json"), 'utf8'));
const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
const output = outputArg ? path.resolve(root, outputArg.slice('--out='.length)) : null;
const base = {
  include: ['electron/**', 'docs/**', 'README.md', 'README.zh-CN.md'],
  exclude: ['docs/eval-reports/**'],
  embedProvider: 'none', vectorStore: 'memory', topK: 6,
  bm25K1: 1.35, bm25B: 0.72, vectorWeight: 0.35, graphHops: 1,
};
const variants = [
  { name: 'default-lexical', options: {} },
  { name: 'bm25-1.2-0.75', options: { bm25K1: 1.2, bm25B: 0.75 } },
  { name: 'bm25-1.8-0.5', options: { bm25K1: 1.8, bm25B: 0.5 } },
  { name: 'hash-weight-0.1', options: { embedProvider: 'local', vectorWeight: 0.1 } },
  { name: 'hash-weight-0.2', options: { embedProvider: 'local', vectorWeight: 0.2 } },
  { name: 'hash-weight-0.4', options: { embedProvider: 'local', vectorWeight: 0.4 } },
  { name: 'lexical-only', options: { embedProvider: 'none', vectorWeight: 0 } },
  { name: 'no-graph', options: { graphHops: 0 } },
];

function summarize(rows) {
  const positive = rows.filter((row) => row.expected.length);
  const negative = rows.filter((row) => !row.expected.length);
  const n = positive.length || 1;
  return {
    fileRecallAt3: positive.filter((row) => row.pathRank > 0 && row.pathRank <= 3).length / n,
    fileRecallAt6: positive.filter((row) => row.pathRank > 0 && row.pathRank <= 6).length / n,
    spanRecallAt3: positive.filter((row) => row.rank > 0 && row.rank <= 3).length / n,
    spanRecallAt6: positive.filter((row) => row.rank > 0 && row.rank <= 6).length / n,
    spanMrr: positive.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n,
    noAnswerFalsePositiveRate: negative.length ? negative.filter((row) => row.answerable).length / negative.length : 0,
    meanMs: rows.reduce((sum, row) => sum + row.durationMs, 0) / (rows.length || 1),
    graphExpanded: rows.reduce((sum, row) => sum + row.graphExpanded, 0),
  };
}

async function main() {
  if (!Array.isArray(cases) || !cases.length) throw new Error('评测问题为空');
  for (const item of cases) {
    if (!item.query || !Array.isArray(item.expected)) throw new Error('评测条目缺少 query/expected');
    for (const file of item.expected) {
      const target = path.join(root, file);
      if (!fs.existsSync(target)) throw new Error('目标文件不存在：' + file);
      if (item.expectedText && !fs.readFileSync(target, 'utf8').includes(item.expectedText)) {
        throw new Error('目标片段不存在：' + file + ' / ' + item.expectedText);
      }
    }
  }
  const results = [];
  for (const variant of variants) {
    const index = new LocalRagIndex(root, { ...base, ...variant.options });
    const rows = [];
    for (const item of cases) {
      const result = await index.retrieve(item.query, { mode: 'auto', topK: 6 });
      const paths = [...new Set(result.results.map((hit) => hit.path))];
      const pathRank = result.results.findIndex((hit) => item.expected.includes(hit.path)) + 1;
      const rank = result.results.findIndex((hit) => item.expected.includes(hit.path) &&
        (!item.expectedText || hit.excerpt.includes(item.expectedText) || hit.contexts.some((context) => context.excerpt.includes(item.expectedText)))) + 1;
      const stats = /** @type {any} */ (result.stats);
      rows.push({ query: item.query, expected: item.expected, expectedText: item.expectedText || null, pathRank, rank, paths,
        answerable: result.quality.answerable,
        durationMs: stats.retrievalDurationMs || 0,
        graphExpanded: stats.graph?.expanded || 0 });
    }
    results.push({ name: variant.name, options: { ...base, ...variant.options }, metrics: summarize(rows), rows });
  }
  const report = { description: 'CodeNode 当前仓库的固定文件定位样例；小样本诊断，不用于宣称全局最优参数',
    cases: cases.length, results };
  for (const entry of results) {
    const m = entry.metrics;
    console.log(`${entry.name.padEnd(16)} file@6=${m.fileRecallAt6.toFixed(3)} span@6=${m.spanRecallAt6.toFixed(3)} spanMRR=${m.spanMrr.toFixed(3)} no-answer-FP=${m.noAnswerFalsePositiveRate.toFixed(3)} mean=${m.meanMs.toFixed(1)}ms graph=${m.graphExpanded}`);
  }
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('report: ' + output);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
