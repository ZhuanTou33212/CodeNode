'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
// v2 retains the judge implementations used for its first measured baseline.
const frozenAnswerability = require("../fixtures/rag-judges-v2/answerability.cjs");
const frozenFaithfulness = require("../fixtures/rag-judges-v2/faithfulness.cjs");
const { LocalRagIndex } = require("../../electron/rag/index.cjs");
const agent = require("../../electron/agent.cjs");
const { RequestBudget } = require("../../electron/requestBudget.cjs");
const root = path.resolve(__dirname, "../..");
const datasetFile = path.join(__dirname, "../fixtures/rag-acceptance-v2.json");
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const arg = (name, fallback) => process.argv.find((value) => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=') || fallback;
function wilson(success, total) {
  if (!total) return null;
  const z = 1.96, p = success / total, d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function summarize(rows, key) {
  const matrix = { TP: 0, TN: 0, FP: 0, FN: 0, unknownPositive: 0, unknownNegative: 0 };
  for (const row of rows) {
    const result = row[key];
    if (!result || ['unknown', 'unverified', 'pending', 'not_available'].includes(result.status)) {
      matrix[row.expected ? 'unknownPositive' : 'unknownNegative']++; continue;
    }
    const value = key === 'answerability' ? result.answerable : result.supported;
    matrix[row.expected ? value ? 'TP' : 'FN' : value ? 'FP' : 'TN']++;
  }
  const positive = rows.filter((row) => row.expected).length, negative = rows.length - positive;
  const valid = matrix.TP + matrix.TN + matrix.FP + matrix.FN;
  return { count: rows.length, ...matrix, verificationCoverage: valid / rows.length,
    accuracyWithUnknownAsError: (matrix.TP + matrix.TN) / rows.length,
    conditionalAccuracy: valid ? (matrix.TP + matrix.TN) / valid : null,
    positivePassRate: positive ? matrix.TP / positive : null,
    negativeFalsePassRate: negative ? matrix.FP / negative : null,
    correctRefusalRate: negative ? matrix.TN / negative : null,
    nominalWilson95: wilson(matrix.TP + matrix.TN, rows.length) };
}
function loadFrozen() {
  const raw = fs.readFileSync(datasetFile), dataset = JSON.parse(raw.toString());
  const lock = JSON.parse(fs.readFileSync(datasetFile.replace('.json', '.lock.json'), 'utf8'));
  if (hash(raw) !== lock.datasetSha256) throw new Error('Dataset freeze hash mismatch');
  for (const [name, digest] of Object.entries(lock.judgeHashes)) {
    if (hash(fs.readFileSync(path.join(__dirname, '../fixtures/rag-judges-v2/' + name + '.cjs'))) !== digest) throw new Error('Frozen judge hash mismatch; use new dataset version');
  }
  if (dataset.cases.length !== 100 || new Set(dataset.cases.map((item) => item.query)).size !== 100) throw new Error('Expected 100 distinct queries');
  for (const [file, content] of Object.entries(dataset.files)) {
    if (hash(content) !== dataset.sourceHashes[file]) throw new Error('Snapshot hash mismatch: ' + file);
  }
  for (const item of dataset.cases) {
    for (const source of item.sources) {
      const excerpt = dataset.files[source.path].replace(/\r\n?/g, '\n').split('\n').slice(source.startLine - 1, source.endLine).join('\n');
      if (excerpt !== source.excerpt || !excerpt.includes(source.anchor)) throw new Error('Invalid source mapping: ' + item.id);
    }
  }
  return { dataset, lock };
}
async function main() {
  const { dataset, lock } = loadFrozen();
  const live = arg('judge', 'frozen') === 'live';
  if (live && !process.argv.includes('--allow-exposed')) throw new Error('Live judge on exposed v2 is a regression experiment; require --allow-exposed');
  const { assessAnswerability } = live ? require("../../electron/rag/answerability.cjs") : frozenAnswerability;
  const { verifyFaithfulness } = live ? require("../../electron/rag/faithfulness.cjs") : frozenFaithfulness;
  if (process.argv.includes('--validate')) { console.log('100 frozen scenarios PASS; labels pending human review'); return; }
  if (process.argv.includes('--export-review')) {
    const out = path.resolve(arg('out', 'out/rag-human-review.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ datasetHash: lock.datasetSha256, reviews: dataset.cases.map((item) => ({
      id: item.id, query: item.query, sources: item.sources, authorLabel: item.expectedAnswerable,
      humanLabel: null, reviewer: '', reviewedAt: '', note: '' })) }, null, 2));
    console.log('Review template exported: ' + out); return;
  }
  const offline = process.argv.includes('--retrieval-only');
  if (!offline && !process.argv.includes('--confirm-send')) throw new Error('Real model evaluation requires --confirm-send; sends frozen source excerpts to configured model');
  const cfg = agent.loadConfig(root);
  cfg.apiKey = process.env.CODENODE_API_KEY || cfg.apiKey;
  cfg.apiBase = process.env.CODENODE_API_BASE || cfg.apiBase;
  cfg.model = process.env.CODENODE_MODEL || cfg.model;
  if (!offline && !cfg.apiKey) throw new Error('No model API credential configured');
  cfg.maxTokens = live ? 3072 : 1536; cfg.reasoningEffort = null;
  cfg.jsonOutput = live && /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(cfg.apiBase);
  cfg.modelRouting = { candidates: {}, routes: {}, fallbacks: [] };
  cfg.reliability = { ...cfg.reliability, maxAttempts: 1, streamMaxAttempts: 0 };
  cfg.requestBudget = new RequestBudget(Number(arg('token-budget', '1000000')), { retryLimit: 0,
    costLimitUsd: cfg.limits.maxCostUsd, prices: cfg.costPrices });
  const controller = new AbortController();
  let calls = 0, usageTokens = 0;
  const judge = async (messages) => {
    calls++;
    const result = await agent.chatCompletion(cfg, messages, { signal: controller.signal, timeoutMs: 45000 });
    usageTokens += Number(result.usage?.total_tokens || 0);
    if (result.error || !result.content) throw new Error('Model request failed or empty response');
    return result.content;
  };
  if (!offline) {
    const preflight = await judge([{ role: 'user', content: 'Return a JSON object containing the boolean field ok set to true. No other text.' }]);
    if (JSON.parse(preflight).ok !== true) throw new Error('Model preflight failed');
    if (process.argv.includes('--preflight')) { console.log(JSON.stringify({ model: cfg.model, ok: true })); return; }
  }
  const mode = offline ? 'retrieval' : arg('mode', 'oracle');
  if (!['oracle', 'retrieval'].includes(mode)) throw new Error('mode must be oracle or retrieval');
  const selected = dataset.cases.slice(0, Number(arg('limit', '100')));
  const out = path.resolve(arg('out', 'out/rag-acceptance-' + mode + '.json'));
  if (fs.existsSync(out)) throw new Error('Result file already exists; choose a new --out path to preserve the measured baseline');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const report = { datasetHash: lock.datasetSha256, judgeHashes: lock.judgeHashes,
    liveJudge: live, experimentRole: live ? 'exposed-regression' : 'frozen-baseline',
    liveJudgeHashes: live ? Object.fromEntries(['answerability', 'faithfulness', 'judgeJson'].map((name) => [name,
      hash(fs.readFileSync(path.join(root, 'electron/rag/' + name + '.cjs')))])) : null,
    startedAt: new Date().toISOString(), model: offline ? null : cfg.model, mode, offline,
    labels: 'AI-author labels, not human adjudicated gold', independentJudgeModel: false,
    warnings: ['Source-related cases are correlated; Wilson interval is nominal, not proof of generalization.',
      'Oracle tests bounded supplied evidence. Retrieval tests may find extra evidence; inspect disagreements.',
      'Do not tune judge prompts on this run and continue calling the dataset unseen.'], rows: [], metrics: {}, humanReviewedCount: 0, acceptance: 'provisional' };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-rag-acceptance-'));
  try {
    for (const [file, content] of Object.entries(dataset.files)) {
      const target = path.resolve(temp, file);
      if (!target.startsWith(temp + path.sep)) throw new Error('Unsafe snapshot path');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    }
    const retrievalProfile = arg('retrieval-profile', 'bm25');
    if (!['bm25', 'local-jina'].includes(retrievalProfile)) throw new Error('Unknown retrieval profile');
    const localEmbeddingBase = process.env.EMBED_BASE || 'http://127.0.0.1:18767/v1';
    if (retrievalProfile === 'local-jina' && !/^http:\/\/127\.0\.0\.1:\d+\//.test(localEmbeddingBase)) throw new Error('local-jina profile requires loopback embeddings');
    const retrievalOptions = retrievalProfile === 'local-jina' ? { embedProvider: 'openai', embedBase: localEmbeddingBase,
      embedKey: 'local-experiment', embedModel: 'jina-embeddings-v2-base-code-int8', embedDim: 768,
      memorySemanticMaxChunks: 5000, vectorWeight: 0.35 } : { embedProvider: 'none' };
    report.retrievalProfile = retrievalProfile;
    const index = new LocalRagIndex(temp, retrievalOptions);
    let next = 0;
    const runCase = async () => {
      while (next < selected.length) {
        const item = selected[next++], started = Date.now();
        const retrieved = mode === 'retrieval' ? await index.retrieve(item.query, live && !offline ? { runtime: { answerabilityJudge: judge } } : undefined) : null;
        const sources = retrieved ? retrieved.results.flatMap((source) => [source, ...(source.contexts || [])]) : item.sources;
        const answerability = live && retrieved && !offline ? retrieved.quality.evidenceChain || { status: 'unknown', answerable: false } : await assessAnswerability(item.query, sources, offline ? null : judge);
        const answer = item.expectedAnswerable ? item.referenceAnswer + ' [' + item.sources[0].citation + ']' :
          '项目已经完整实现以下机制：' + item.query + ' [' + item.sources[0].citation + ']';
        const faithfulness = offline ? { status: 'unknown', supported: false, reason: 'No real judge in retrieval-only mode' } :
          await verifyFaithfulness(answer, [{ name: 'retrieve_context', ok: true, data: { sources } }], judge);
        const ranks = retrieved ? item.sources.map((gold) => retrieved.results.findIndex((hit) => hit.path === gold.path &&
          (hit.excerpt.includes(gold.anchor) || hit.contexts.some((context) => context.excerpt.includes(gold.anchor)))) + 1) : null;
        report.rows.push({ id: item.id, type: item.type, domain: item.domain, expected: item.expectedAnswerable,
          query: item.query, answerability, faithfulness, goldEvidenceRanks: ranks,
          suppliedSources: sources.map((source) => source.citation), ms: Date.now() - started });
        report.metrics = { answerability: summarize(report.rows, 'answerability'), faithfulness: summarize(report.rows, 'faithfulness') };
        fs.writeFileSync(out, JSON.stringify({ ...report, modelCalls: calls, reportedTokens: usageTokens }, null, 2));
        console.log(`${report.rows.length}/${selected.length} ${item.id} answerability=${answerability.status} faithfulness=${faithfulness.status}`);
      }
    };
    await Promise.all([runCase(), runCase(), runCase()]);
    report.rows.sort((a, b) => a.id.localeCompare(b.id));
    if (mode === 'retrieval') {
      const positive = report.rows.filter((row) => row.expected);
      report.metrics.retrieval = { positiveCount: positive.length,
        allEvidenceRecallAt6: positive.filter((row) => row.goldEvidenceRanks.every((rank) => rank > 0)).length / positive.length,
        allEvidenceMrr: positive.reduce((sum, row) => sum + (row.goldEvidenceRanks.every((rank) => rank > 0) ? 1 / Math.max(...row.goldEvidenceRanks) : 0), 0) / positive.length };
    }
    const reviewArg = arg('reviews', '');
    if (reviewArg) {
      const review = JSON.parse(fs.readFileSync(path.resolve(reviewArg), 'utf8'));
      if (review.datasetHash !== lock.datasetSha256) throw new Error('Human review dataset hash mismatch');
      const valid = review.reviews.filter((item) => typeof item.humanLabel === 'boolean' && item.reviewer && item.reviewedAt && Number.isFinite(Date.parse(item.reviewedAt)));
      if (new Set(valid.map((item) => item.id)).size !== valid.length) throw new Error('Duplicate review IDs');
      const byId = new Map(valid.map((item) => [item.id, item]));
      report.humanReviewedCount = report.rows.filter((row) => byId.has(row.id)).length;
      const reviewedRows = report.rows.filter((row) => byId.has(row.id)).map((row) => ({ ...row, expected: byId.get(row.id).humanLabel }));
      report.metrics.humanLabelAnswerability = summarize(reviewedRows, 'answerability');
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify({ ...report, modelCalls: calls, reportedTokens: usageTokens }, null, 2));
    console.log(JSON.stringify(report.metrics));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { wilson, summarize, loadFrozen };
