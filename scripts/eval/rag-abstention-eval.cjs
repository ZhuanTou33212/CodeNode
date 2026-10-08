'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const agent = require("../../electron/agent.cjs");
const { RequestBudget } = require("../../electron/requestBudget.cjs");
const { verifyFaithfulness } = require("../../electron/rag/faithfulness.cjs");
const { semanticRejected } = require("../../electron/rag/abstention.cjs");
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
async function main() {
  if (!process.argv.includes('--confirm-send')) throw new Error('Explicit frozen-source send flag required');
  const output = path.resolve(process.argv.find((item) => item.startsWith('--out='))?.slice(6) || 'out/rag-abstention-oracle.json');
  if (fs.existsSync(output)) throw new Error('Output exists');
  const { dataset, lock } = loadFrozen();
  const base = agent.loadConfig(path.resolve(__dirname, "../.."));
  if (!base.apiKey) throw new Error('Model credential missing');
  const cfg = { ...base, maxTokens: 3072, modelRouting: { routes: {}, candidates: {}, fallbacks: [] },
    reliability: { ...base.reliability, maxAttempts: 1 }, requestBudget: new RequestBudget(1500000),
    jsonOutput: /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(base.apiBase) };
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const report = { datasetHash: lock.datasetSha256, role: 'exposed-regression-abstention-oracle',
    labelProvenance: 'AI author negative labels; synthetic response controls; no human gold', model: cfg.model,
    runtimeHashes: Object.fromEntries(['electron/rag/faithfulness.cjs', 'electron/rag/abstention.cjs', 'scripts/eval/rag-abstention-eval.cjs']
      .map((file) => [file, hash(fs.readFileSync(path.resolve(__dirname, "../..", file)))])),
    startedAt: new Date().toISOString(), rows: [], metrics: {} };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const judge = async (messages) => {
    const result = await agent.chatCompletion(cfg, messages, { timeoutMs: 30000 });
    if (result.error) throw new Error(result.error);
    return result.content;
  };
  for (const item of dataset.cases.filter((item) => !item.expectedAnswerable)) {
    const calls = [{ name: 'retrieve_context', ok: true, data: { sources: item.sources.map((source) =>
      ({ citation: source.citation, excerpt: source.excerpt })) } }];
    const limited = '在本轮提供的源码证据范围内，无法确认或解释题目所问的机制；现有片段不足以给出该实现步骤。';
    const invented = '该源码明确实现了题目所问的机制，并且已完整验证其实现步骤、投入运行。';
    const safe = await verifyFaithfulness(limited, calls, judge, { question: item.query });
    const falseClaim = await verifyFaithfulness(invented, calls, judge, { question: item.query });
    report.rows.push({ id: item.id, question: item.query, safeAccepted: safe.status === 'abstained' && !semanticRejected(safe),
      inventedAccepted: !semanticRejected(falseClaim), safe, falseClaim });
    report.metrics = { completed: report.rows.length, safeAccepted: report.rows.filter((row) => row.safeAccepted).length,
      inventedAccepted: report.rows.filter((row) => row.inventedAccepted).length,
      safeUnknown: report.rows.filter((row) => row.safe.status === 'unknown').length,
      inventedUnknown: report.rows.filter((row) => row.falseClaim.status === 'unknown').length,
      budgetUsedTokens: cfg.requestBudget.used };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(item.id + ' scoped=' + report.rows.at(-1).safeAccepted + ' invented=' + report.rows.at(-1).inventedAccepted);
  }
  report['finishedAt'] = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.metrics));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
