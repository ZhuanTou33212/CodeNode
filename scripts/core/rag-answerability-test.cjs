'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { assessAnswerability } = require("../../electron/rag/answerability.cjs");
const { LocalRagIndex } = require("../../electron/rag/index.cjs");
const { parseGroundingConfig } = require("../../electron/agent.cjs");
const { runAgentChat } = require("../../electron/agent.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { buildDefaultRegistryWithConfig } = require("../../electron/tools/toolkit.cjs");
const { installScriptedModel } = require("../lib/scripted-model.cjs");
const corpus = require("../fixtures/rag-benchmark-v1.json");
const negatives = require("../fixtures/rag-adversarial-negatives-v1.json");
const evidence = [{ citation: 'a.ts#L1-L2', excerpt: 'The attempt limit is 5. Jobs stop at the attempt limit.' }];
function judge(verdicts) {
  let requests = 0;
  return async (messages) => {
    const payload = JSON.parse(messages[1].content);
    if (++requests === 1) {
      assert.ok(!payload.sources, 'Question plan must not see retrieved sources');
      return JSON.stringify({ facts: [{ id: 1, requirement: 'Attempt threshold' }, { id: 2, requirement: 'Stop condition' }] });
    }
    return JSON.stringify({ facts: verdicts.map((verdict, index) => ({ id: index + 1, verdict,
      evidence: verdict === 'supported' ? [{ citation: 'a.ts#L1-L2', quote: index ? 'Jobs stop at the attempt limit.' : 'The attempt limit is 5.' }] : [], reason: 'test verdict' })) });
  };
}
async function main() {
  const lock = require("../fixtures/rag-adversarial-lock-v1.json");
  for (const [file, expected] of Object.entries(lock)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, "../fixtures", file))).digest('hex');
    assert.equal(actual, expected, 'Frozen development corpus changed; create a new version');
  }
  assert.equal(parseGroundingConfig({}).answerability, false);
  assert.equal(parseGroundingConfig({ 'agent.rag.answerability': 'verify' }).answerability, false);
  assert.equal(parseGroundingConfig({ 'agent.rag.answerability': 'off' }).answerability, false);
  const positive = await assessAnswerability('What is the threshold and stop condition?', evidence, judge(['supported', 'supported']));
  assert.equal(positive.answerable, true); assert.equal(positive.evidenceVerified, true);
  for (const verdict of ['missing', 'contradicted']) {
    const result = await assessAnswerability('Threshold and stop?', evidence, judge(['supported', verdict]));
    assert.equal(result.answerable, false); assert.equal(result.status, 'insufficient');
  }
  assert.equal((await assessAnswerability('Question', evidence, judge(['supported']))).status, 'unknown');
  assert.equal((await assessAnswerability('Question', evidence, async () => 'bad JSON')).status, 'unknown');
  assert.equal((await assessAnswerability('Question', evidence, null)).status, 'unknown');
  assert.equal((await assessAnswerability('Question', [], judge(['supported', 'supported']))).answerable, false);
  let count = 0;
  const forged = async () => ++count === 1 ? JSON.stringify({ facts: [{ id: 1, requirement: 'Limit' }] }) :
    JSON.stringify({ facts: [{ id: 1, verdict: 'supported', evidence: [{ citation: 'a.ts#L1-L2', quote: 'Limit is 99' }] }] });
  assert.equal((await assessAnswerability('Limit?', evidence, forged)).status, 'unknown');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-answerability-'));
  try {
    for (const [file, content] of Object.entries(corpus.files)) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    }
    assert.equal(negatives.cases.length, 30);
    assert.equal(new Set(negatives.cases.map((item) => item.id)).size, 30);
    const index = new LocalRagIndex(root);
    let candidates = 0;
    for (const item of negatives.cases) {
      assert.ok(item.requiredFacts.length >= 2 && item.missing);
      for (const file of item.nearby) assert.ok(corpus.files[file]);
      const result = await index.retrieve(item.query);
      candidates += result.results.length ? 1 : 0;
      assert.equal(result.quality.answerable, undefined);
      assert.equal(result.admission.finalSupportEvaluated, false);
    }
    assert.ok(candidates >= 20, 'Near-miss questions must retrieve related candidates');
    const supported = await index.retrieve('maxAttempts retry limit', { runtime: { answerabilityJudge: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      if (!payload.sources) return JSON.stringify({ facts: [{ id: 1, requirement: 'maxAttempts value' }] });
      const source = payload.sources.find((item) => item.text.includes('export const maxAttempts = 5'));
      return JSON.stringify({ facts: [{ id: 1, verdict: 'supported', evidence: [{ citation: source.citation, quote: 'export const maxAttempts = 5' }] }] });
    } } });
    assert.equal(supported.admission.admitted, true);
    assert.equal(supported.quality.answerable, undefined);
    const next = await index.retrieve('maxAttempts retry limit');
    assert.equal(next.quality.answerable, undefined);
    assert.equal(next.admission.finalSupportEvaluated, false);
    let rewriteCalls = 0;
    const rewritten = await index.retrieve('短暂错误可以反复尝试多少次？', { runtime: { answerabilityJudge: async (messages) => {
      rewriteCalls++;
      const payload = JSON.parse(messages[1].content);
      if (!payload.sources) return JSON.stringify({ facts: [{ id: 1, requirement: '重试次数' }], searchQueries: ['maxAttempts retry limit'] });
      const source = payload.sources.find((item) => item.text.includes('export const maxAttempts = 5'));
      return JSON.stringify({ facts: [{ id: 1, verdict: 'supported', evidence: [{ citation: source.citation, quote: 'export const maxAttempts = 5' }] }] });
    } } });
    assert.ok(!rewritten.queries.includes('maxAttempts retry limit'));
    assert.equal(rewriteCalls, 0, 'Local retrieval must never invoke a legacy model planner');
    const explicitRewrite = await index.retrieve('短暂错误可以反复尝试多少次？', { queries: ['maxAttempts retry limit'] });
    assert.ok(explicitRewrite.queries.includes('maxAttempts retry limit'));
    assert.equal(explicitRewrite.admission.admitted, true);
    const noLeak = await index.retrieve('短暂错误可以反复尝试多少次？');
    assert.ok(!noLeak.queries.includes('maxAttempts retry limit'));
    const context = new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {} });
    const registry = buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: true, toolsAllowed: ['retrieve_context'] });
    const scripted = installScriptedModel([
      { toolCalls: [{ name: 'retrieve_context', args: { query: 'maxAttempts retry limit', mode: 'file' } }] },
      { content: '尚需确认限制值，不能仅据相关代码下结论。' },
    ], { loopLast: false });
    try {
      const run = await runAgentChat({ cfg: { apiBase: 'http://127.0.0.1:9', apiKey: 'mock-key', model: 'scripted',
        maxTokens: 512, limits: {}, compression: { enabled: false }, reliability: { maxAttempts: 1 },
        grounding: { answerability: true, semanticMode: 'off', mode: 'warn' } },
        messages: [{ role: 'user', content: 'maxAttempts retry limit' }], tools: { registry, context } });
      assert.equal(scripted.calls, 2, 'One tool round and one answer, without hidden planner requests');
      const retrieval = run.toolCalls.find((call) => call.name === 'retrieve_context');
      assert.equal(retrieval.data.quality.answerable, undefined);
      assert.equal(retrieval.data.admission.admitted, true);
      assert.equal(retrieval.data.admission.finalSupportEvaluated, false);
    } finally { scripted.restore(); }
    // A candidate is admissible even when it cannot support the eventual draft.
    const { ScalarStore } = require("../../electron/scalars/index.cjs");
    const scalarStore = new ScalarStore(root);
    scalarStore.set('project:attempt', 5, 'project');
    const stagesContext = new AgentToolContext({ projectRoot: root, scalarStore, ragConfig: { enabled: true } });
    let plannerCalls = 0;
    stagesContext.setQueryPlanner(async (messages) => {
      plannerCalls++;
      assert.equal(JSON.parse(messages[1].content).sources, undefined, 'Planner cannot adjudicate sources');
      throw new Error('planner unavailable');
    });
    for (const mode of ['scalar', 'file', 'auto']) {
      const candidate = await registry.execute('retrieve_context', { query: 'maxAttempts retry limit', keys: ['project:attempt'], mode }, stagesContext);
      assert.equal(candidate.ok, true, mode);
      assert.equal(candidate.data.admission.admitted, true, mode);
      assert.equal(candidate.data.admission.finalSupportEvaluated, false, mode);
      for (const field of ['answerable', 'evidenceVerified', 'answerabilityStatus', 'evidenceChain']) assert.equal(candidate.data.quality[field], undefined, mode + field);
      const { verifyFaithfulness } = require("../../electron/rag/faithfulness.cjs");
      const verdict = await verifyFaithfulness('The attempt limit is 99 [scalar:project:attempt].',
        [{ name: 'retrieve_context', ok: true, data: candidate.data }],
        async () => JSON.stringify({ claims: [{ id: 1, verdict: 'contradicted', evidence: [], reason: 'Source value is 5' }] }));
      assert.equal(verdict.supported, false, 'Admission must never bypass final entailment');
    }
    assert.equal(plannerCalls, 0, 'Scalar, file and mixed retrieval are all free of model planning');
    const empty = await registry.execute('retrieve_context', { query: 'not-present', mode: 'scalar' }, stagesContext);
    assert.equal(empty.data.admission.status, 'empty');
    assert.equal(empty.data.quality.answerable, undefined, 'Empty retrieval is not a no-answer judgment');
    console.log(`ANSWERABILITY: PASS (30 development negatives, ${candidates} retrieve candidates; positive chain, missing link, contradiction, malformed verdict, forged quote, runtime isolation)`);
    console.log('This verifies contracts and fail-closed behavior, not real model accuracy or a zero false-positive claim.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
