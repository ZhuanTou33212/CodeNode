'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const agent = require('../electron/agent.cjs');
const { RequestBudget } = require('../electron/requestBudget.cjs');
const { verifyFaithfulness } = require('../electron/rag/faithfulness.cjs');
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
async function main() {
  if (!process.argv.includes('--confirm-send')) throw new Error('Frozen-source send flag required');
  const output = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || 'out/rag-subject-binding-eval.json');
  if (fs.existsSync(output)) throw new Error('Report exists');
  const { dataset, lock } = loadFrozen();
  const base = agent.loadConfig(path.resolve(__dirname, '..'));
  if (!base.apiKey) throw new Error('Model credential missing');
  const cfg = { ...base, maxTokens: 3072, modelRouting: { routes: {}, candidates: {}, fallbacks: [] },
    reliability: { ...base.reliability, maxAttempts: 1 }, requestBudget: new RequestBudget(400000),
    jsonOutput: /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(base.apiBase) };
  const judge = async (messages) => {
    const result = await agent.chatCompletion(cfg, messages, { timeoutMs: 30000 });
    if (result.error) throw new Error(result.error);
    return result.content;
  };
  const makeSource = (file) => ({ citation: file + '#L1-L' + dataset.files[file].split('\n').length, excerpt: dataset.files[file] });
  const planning = makeSource('electron/rag/answerability.cjs'), final = makeSource('electron/rag/faithfulness.cjs');
  const report = { datasetHash: lock.datasetSha256, role: 'exposed-subject-binding-controls', model: cfg.model,
    labels: 'Source-defined component controls, not human annotation',
    judgeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../electron/rag/faithfulness.cjs'))).digest('hex'),
    startedAt: new Date().toISOString(), rows: [], metrics: {} };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const [id, explicitQuestion, correct, wrong] of [
    ['S13', 'verifyFaithfulness 对最终答案最多接受多少条断言？', '最终答案断言上限为 24 条。', '最多 12 条。'],
    ['S15', 'verifyFaithfulness 的事实断言判定允许哪三种 verdict？', '允许 entailed、contradicted 和 insufficient。', '允许 supported、contradicted 和 missing。'],
  ]) {
    const originalQuestion = dataset.cases.find((item) => item.id === id).query;
    for (const [scope, question] of [['original', originalQuestion], ['explicit', explicitQuestion]]) {
      const variants = /** @type {Array<[string,string,{citation:string,excerpt:string}]>} */ ([['correct', correct, final], ['wrong-component', wrong, planning]]);
      for (const [kind, text, source] of variants) {
        const verdict = await verifyFaithfulness(text + ' [' + source.citation + ']',
          [{ name: 'retrieve_context', ok: true, data: { sources: [source] } }], judge, { question });
        report.rows.push({ id, scope, kind, question, expectedSupported: kind === 'correct', verdict,
          agrees: verdict.status === 'judged' && verdict.supported === (kind === 'correct') });
        report.metrics = { completed: report.rows.length, agrees: report.rows.filter((row) => row.agrees).length,
          wrongAccepted: report.rows.filter((row) => row.kind === 'wrong-component' && row.verdict.supported === true).length,
          correctAccepted: report.rows.filter((row) => row.kind === 'correct' && row.verdict.supported === true).length,
          unknown: report.rows.filter((row) => row.verdict.status === 'unknown').length, budgetUsedTokens: cfg.requestBudget.used };
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        console.log(id + ' ' + scope + ' ' + kind + ' agrees=' + report.rows.at(-1).agrees);
      }
    }
  }
  report['finishedAt'] = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.metrics));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
