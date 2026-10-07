'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { CostLedger } = require('../electron/costLedger.cjs');
const { RequestBudget } = require('../electron/requestBudget.cjs');
const references = require('../electron/toolResultReferences.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-result-reference-'));
const text = Array.from({ length: 180 }, (_, i) => 'line ' + (i + 1) + ': ' + 'source payload '.repeat(5)).join('\n') + '\nANSWER=6174\n';
fs.writeFileSync(path.join(root, 'source.txt'), text);
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');

async function run(enabled, trim = false) {
  const cfg = agent.loadConfig(root);
  const ledger = new CostLedger({ runId: enabled ? 'references' : 'baseline', prices: { fixture: { in: 1, out: 2 } } });
  Object.assign(cfg, { model: 'fixture', apiBase: 'http://scripted.local', apiKey: 'synthetic', maxTokens: 1024,
    costLedger: ledger, costRunId: ledger.runId, costPrices: ledger.prices, requestBudget: new RequestBudget(1000000),
    costSettings: { ...cfg.costSettings, repeatResultReferences: enabled },
    limits: { ...cfg.limits, maxToolIterations: 8, maxTotalTokens: 1000000, progressEvery: 0 },
    compaction: { enabled: false }, compression: { enabled: false }, observation: { enabled: false },
    context: trim ? { enabled: true, maxInputChars: 1800, keepRecentMessages: 2, minResultChars: 200 } : { enabled: false },
  });
  const stub = installScriptedModel([
    { toolCalls: [{ id: 'read-first', name: 'read_file', args: { path: 'source.txt', maxChars: 24000 } }] },
    { toolCalls: [{ id: 'read-repeat-1', name: 'read_file', args: { path: 'source.txt', maxChars: 24000 } }] },
    { toolCalls: [{ id: 'read-repeat-2', name: 'read_file', args: { path: 'source.txt', maxChars: 24000 } }] },
    { content: 'ANSWER=6174' },
  ], { loopLast: false });
  const scriptedFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    // Controlled provider usage: same tokenizer estimate for both variants.
    // This measures request shape, not real-model quality or a real invoice.
    const prompt = require('../electron/requestBudget.cjs').estimateInputTokens(body.messages, body.tools);
    stub.state.script[stub.calls].usage = { prompt_tokens: prompt, completion_tokens: 30, total_tokens: prompt + 30 };
    sent.push(body);
    return scriptedFetch(url, init);
  };
  try {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
    const result = await agent.runAgentChat({ cfg, messages: [{ role: 'system', content: 'Read the file and report ANSWER.' }, { role: 'user', content: 'What is ANSWER?' }],
      tools: { registry, context: new AgentToolContext({ projectRoot: root, audit: () => {} }) } });
    assert.equal(result.error, undefined); assert.equal(result.content, 'ANSWER=6174');
    assert.equal(result.toolCalls.length, 3); assert.equal(result.toolCalls[1].repeated, true);
    assert.equal(result.toolCalls[2].repeated, true);
    for (const call of result.toolCalls) assert.match(call.result, /ANSWER=6174/);
    return { result, sent, totals: ledger.summary(), attribution: ledger.entries.at(-1).meta.attribution };
  } finally { stub.restore(); }
}

(async () => {
  const baseline = await run(false);
  const compact = await run(true);
  assert.equal(baseline.sent.length, compact.sent.length, 'Same model rounds');
  assert.equal(baseline.result.content, compact.result.content);
  assert.deepEqual(baseline.result.toolCalls.map(call => call.data), compact.result.toolCalls.map(call => call.data), 'Raw results stay intact');
  const messages = compact.sent.at(-1).messages.filter(message => message.role === 'tool');
  assert.match(messages[0].content, /ANSWER=6174/); assert.doesNotMatch(messages[1].content, /ANSWER=6174/);
  assert.ok(messages[1].content.includes('read-first')); assert.ok(messages[2].content.includes('read-first'));
  assert.ok(compact.totals.promptTokens < baseline.totals.promptTokens * 0.7, 'Repeated full bodies materially inflate inputs');
  assert.equal(compact.totals.requests, baseline.totals.requests);
  const referenceMessages = JSON.parse(JSON.stringify(messages));
  assert.equal(references.repair(referenceMessages), 0, 'Marker works after persistence');
  referenceMessages[0].content = 'summary without original body';
  assert.equal(references.repair(referenceMessages), 2); assert.equal(referenceMessages[1].content, references.LOST);
  const removed = JSON.parse(JSON.stringify(messages)).slice(1);
  assert.equal(references.repair(removed), 2, 'Pruned source cannot leave dangling references');
  assert.equal(references.project('tiny', 'read_file', messages, true).source, null, 'No reference overhead for tiny bodies');
  assert.equal(references.project(messages[0].content, 'view_image', [{ ...messages[0], name: 'view_image' }], true).source, null, 'Multimodal results retain existing behavior');
  const afterTrim = await run(true, true);
  assert.ok(afterTrim.result.contextTrims > 0);
  assert.ok(afterTrim.sent.slice(2).some(body => body.messages.some(message => message.role === 'tool' && String(message.content).includes('ANSWER=6174'))), 'Repeated read restores body after trimming');
  const report = { ok: true, method: 'controlled scripted responses; estimated serialized input tokens; no real-model quality claim',
    rounds: compact.sent.length, toolCalls: compact.result.toolCalls.length,
    baselinePromptTokens: baseline.totals.promptTokens, referencePromptTokens: compact.totals.promptTokens,
    inputReduction: Number((1 - compact.totals.promptTokens / baseline.totals.promptTokens).toFixed(4)),
    sameResult: true, rawResultsIntact: true, staleReferencesRejected: true, trimmedBodyRestored: true };
  fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../out/token-result-reference-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('RESULT REFERENCES: PASS ' + JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
