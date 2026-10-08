'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CostBudget, parseCostLimit } = require("../../electron/costBudget.cjs");
const { RequestBudget, createSubagentBudget, withAttemptBudget, estimateInputTokens } = require("../../electron/requestBudget.cjs");
const { createEmbedder } = require("../../electron/embedder/index.cjs");
const { getProjectIndex, clearIndexCache } = require("../../electron/rag/index.cjs");
const { rerankCandidates } = require("../../electron/rag/rerank.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { createExecutionContext } = require("../../electron/tools/executionContext.cjs");

async function main() {
  assert.equal(parseCostLimit(''), 0);
  for (const invalid of [-1, Infinity, 'bad', 0.0000001]) assert.throws(() => parseCostLimit(invalid), { code: 'COST_CONFIG_INVALID' });
  const prices = { main: { in: 1000, out: 2000, cachedIn: 100 }, embedding: { in: 1000, out: 0 } };
  const budget = new RequestBudget(100000, { costLimitUsd: 1, prices });
  const child = createSubagentBudget(budget, 10000);
  const first = budget.reserveRequest('main', 400, 100);
  const second = child.reserveRequest('main', 200, 100);
  assert.throws(() => child.reserveRequest('main', 1, 0), { code: 'COST_BUDGET_EXCEEDED' });
  assert.equal(budget.reserved, 800);
  first({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 }, total_tokens: 120 });
  first(null);
  second(null);
  assert.equal(budget.costSnapshot().usedUsd, 0.495);
  assert.equal(budget.costSnapshot().reservedUsd, 0);
  assert.equal(budget.costSnapshot().uncertainRequests, 1);
  assert.equal(child.costSnapshot().usedUsd, budget.costSnapshot().usedUsd);
  assert.throws(() => budget.reserveRequest('unpriced', 5, 5), { code: 'COST_PRICE_MISSING' });
  assert.equal(budget.reserved, 0);
  const cancelled = budget.reserveRequest('main', 10, 10);
  cancelled(null, { notSent: true });
  assert.equal(budget.costSnapshot().usedUsd, 0.495);

  // Unknown usage keeps the complete reservation and can stop a retry before IO.
  const oneAttemptCost = (estimateInputTokens([], []) + 10) / 1e6;
  const retryBudget = new RequestBudget(100000, { costLimitUsd: oneAttemptCost * 1.5, prices: { main: { in: 1, out: 1 } } });
  let sent = 0;
  const ref = { count: 0, maxAttempts: 2 };
  await assert.rejects(withAttemptBudget({ model: 'main', maxTokens: 10, requestBudget: retryBudget }, [], [], async () => {
    const finish = ref.beginAttempt(); sent += 1;
    finish(null, { failed: true });
    ref.beginAttempt(); sent += 1;
  }, ref), { code: 'COST_BUDGET_EXCEEDED' });
  assert.equal(ref.count, 1);
  assert.equal(sent, 1);
  assert.equal(retryBudget.reserved, 0);
  const hiddenReasoning = new CostBudget({ limitUsd: 10, prices });
  hiddenReasoning.reserveTokens('main', 100, 1000)({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 1000 });
  assert.equal(hiddenReasoning.snapshot().usedUsd, 1.99, 'total-only reasoning difference must not disappear');
  const geminiUsage = require("../../electron/modelProtocol.cjs").usageFromGemini({
    promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 980, totalTokenCount: 1000,
  });
  assert.equal(geminiUsage.completion_tokens, 990);
  assert.equal(geminiUsage.completion_tokens_details.reasoning_tokens, 980);
  assert.equal(require("../../electron/costLedger.cjs").costOf('main', geminiUsage, prices), 1.99);
  const failedPartial = new RequestBudget(100000, { costLimitUsd: 3, prices });
  const partialRef = { count: 0, maxAttempts: 2 };
  await assert.rejects(withAttemptBudget({ model: 'main', maxTokens: 1000, requestBudget: failedPartial }, [], [], async () => {
    partialRef.beginAttempt()({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 }, { failed: true, partialChars: 4000 });
    partialRef.beginAttempt();
  }, partialRef), { code: 'COST_BUDGET_EXCEEDED' });
  assert.equal(failedPartial.costSnapshot().uncertainRequests, 1);
  const imageMessages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/tiny.png' } }] }];
  const imageBudget = new RequestBudget(100000, { costLimitUsd: 1, prices });
  const imageRef = { count: 0, maxAttempts: 1 };
  await assert.rejects(withAttemptBudget({ model: 'main', maxTokens: 10, requestBudget: imageBudget }, imageMessages, [],
    async () => { throw new Error('must not invoke image transport'); }, imageRef), { code: 'COST_IMAGE_BOUND_MISSING' });
  await assert.rejects(withAttemptBudget({ model: 'main', maxTokens: 10, requestBudget: imageBudget,
    costImageInputTokens: { main: 32768 } }, imageMessages, [], async () => { imageRef.beginAttempt(); }, imageRef), { code: 'COST_BUDGET_EXCEEDED' });
  assert.equal(imageRef.count, 0, 'short URL must not evade the image fee reservation');

  // Fixed-cost reranking is also denied before transport if no bound was supplied.
  const candidates = [{ chunk: { id: 'a', path: 'a.js', content: 'alpha' } }];
  let rerankCalls = 0;
  await assert.rejects(rerankCandidates('alpha', candidates, { budget, client: async () => { rerankCalls++; } }), { code: 'COST_PRICE_MISSING' });
  assert.equal(rerankCalls, 0);
  assert.equal(budget.reserved, 0);
  await rerankCandidates('alpha', candidates, { budget, maxCostUsd: 0.1,
    client: async () => { rerankCalls++; return { results: [{ index: 0, relevance_score: 1 }] }; } });
  assert.equal(budget.costSnapshot().usedUsd, 0.595);

  const originalFetch = global.fetch;
  let embeddingCalls = 0;
  let queueUsed = 0;
  const queue = { async acquire() { queueUsed++; return () => { queueUsed--; }; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cost-budget-'));
  try {
    global.fetch = async (_url, options) => {
      embeddingCalls++;
      const body = JSON.parse(String(options.body));
      const inputs = Array.isArray(body.input) ? body.input : [body.prompt];
      return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, ...Array(255).fill(0)] })),
        usage: { prompt_tokens: 1, total_tokens: 1 } }));
    };
    const missingPrice = new RequestBudget(100000, { costLimitUsd: 1 });
    const embedder = createEmbedder({ embedProvider: 'openai', embedModel: 'embedding', embedKey: 'synthetic', budget: missingPrice, queue });
    await assert.rejects(embedder.embed(['alpha']), { code: 'COST_PRICE_MISSING' });
    assert.equal(embeddingCalls, 0);
    assert.equal(queueUsed, 0, 'preflight failure must release the queue slot');
    const ledger = new (require("../../electron/costLedger.cjs").CostLedger)({ prices });
    const usageBudget = new RequestBudget(100000, { costLimitUsd: 10, prices });
    const measured = createEmbedder({ embedProvider: 'openai', embedModel: 'embedding', embedKey: 'synthetic', budget: usageBudget,
      onUsage: (entry) => ledger.record(entry) });
    const successfulFetch = global.fetch;
    global.fetch = async () => { throw new Error('synthetic connection reset'); };
    await assert.rejects(measured.embed(['alpha']), /synthetic connection reset/);
    assert.equal(ledger.summary().requests, 1);
    assert.equal(ledger.summary().errors, 1);
    assert.equal(ledger.summary().costKnown, false);
    global.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: [1] }], usage: {} }));
    await measured.embed(['alpha']);
    assert.equal(ledger.summary().requests, 2);
    assert.equal(ledger.entries[1].billingUnknown, true);
    assert.equal(ledger.entries[1].costUsd, null);
    global.fetch = successfulFetch;
    fs.writeFileSync(path.join(root, 'source.js'), 'export function alpha() { return 42; }');
    const index = getProjectIndex(root, { embedProvider: 'openai', embedModel: 'embedding', embedKey: 'synthetic', embedDim: 256 });
    const run1 = new RequestBudget(100000, { costLimitUsd: 10, prices });
    await index.retrieve('alpha', { mode: 'hybrid', runtime: { budget: run1, prices, queue } });
    assert.ok(embeddingCalls > 0, 'actual cached index path must use the runtime embedder');
    assert.ok(run1.costSnapshot().usedUsd > 0);
    const before = embeddingCalls;
    const blockedRun = new RequestBudget(100000, { costLimitUsd: 0.000001, prices });
    const fallback = await index.retrieve('alpha', { mode: 'hybrid', runtime: { budget: blockedRun, prices, queue } });
    assert.equal(embeddingCalls, before, 'cached index must not reuse the preceding Run budget');
    assert.ok(fallback.stats.vector.error);
    assert.equal(queueUsed, 0);
    const ctx = new AgentToolContext({ modelRuntime: { budget: run1, prices } });
    assert.equal(createExecutionContext(ctx, { name: 'read_file' }).modelRuntime, undefined);
    assert.equal(createExecutionContext(ctx, { name: 'retrieve_context' }).modelRuntime().budget, run1);
  } finally {
    global.fetch = originalFetch;
    clearIndexCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const disabled = new CostBudget();
  disabled.reserveTokens('unpriced', 100, 100)({ total_tokens: 20 });
  assert.equal(disabled.snapshot().enabled, false);
  console.log('COST BUDGET: PASS — parent/child reservations, cache pricing, unknown usage, preflight, embedding and rerank, Run isolation');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
