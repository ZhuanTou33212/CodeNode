'use strict';

const assert = require('assert/strict');
const http = require('http');
const routing = require('../electron/modelRouting.cjs');
const agent = require('../electron/agent.cjs');
const { RequestBudget, estimateInputTokens, createSubagentBudget } = require('../electron/requestBudget.cjs');
const { CostLedger } = require('../electron/costLedger.cjs');

const messages = [{ role: 'user', content: 'hello' }];
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
function success(res, content = 'ok') {
  json(res, 200, { choices: [{ message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
}
function stream(res, content = 'clean') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
}

async function main() {
  let handler;
  let requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, authorization: req.headers.authorization });
    handler(body, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const apiBase = 'http://127.0.0.1:' + /** @type {import('net').AddressInfo} */ (server.address()).port;
  const modelRouting = routing.parseConfig({
    'agent.model_fallbacks': 'backup', 'agent.model_candidate.backup.model': 'backup-model',
    'agent.model_candidate.small.model': 'small-model', 'agent.model_route.compression': 'small',
    'agent.model_route.subagent': 'small',
  });
  const config = (extra = {}) => ({ apiBase, model: 'primary-model', apiKey: 'unit-test-key',
    maxTokens: 16, reasoningEffort: null, modelRouting,
    reliability: { maxAttempts: 3, streamMaxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1 }, ...extra });
  const reset = fn => { requests = []; handler = fn; };
  try {
    reset((body, res) => body.model === 'primary-model' ? json(res, 503, { error: 'busy' }) : success(res));
    const budget = new RequestBudget(100000, { retryLimit: 2 });
    const events = [];
    const result = await agent.chatCompletion(config({ requestBudget: budget }), messages,
      { onModelEvent: event => events.push(event), timeoutMs: 2000 });
    assert.equal(result.actualModel, 'backup-model');
    assert.equal(result.httpAttempts, 2);
    assert.deepEqual(requests.map(r => r.body.model), ['primary-model', 'backup-model']);
    assert.equal(budget.retriesUsed, 1);
    assert.equal(budget.used, estimateInputTokens(messages, []) + 16 + 3);
    assert.equal(budget.reserved, 0);
    assert.equal(events.find(e => e.kind === 'model_fallback').reason, 'http-503');
    assert.ok(!JSON.stringify(events).includes('unit-test-key'));

    for (const status of [400, 401, 403, 404, 422]) {
      reset((body, res) => json(res, status, { error: 'request rejected' }));
      await assert.rejects(agent.chatCompletion(config(), messages), /** @param {any} error */ error => error.status === status);
      assert.equal(requests.length, 1, 'configuration and authorization errors must not switch models');
      reset((body, res) => json(res, status, { error: 'request rejected' }));
      await assert.rejects(agent.chatCompletionStream(config(), messages, () => {}));
      assert.equal(requests.length, 1, 'stream error wrapping must not lose non-retryable HTTP status');
    }

    reset((body, res) => success(res));
    const routed = await agent.chatCompletion(config(), messages, { taskType: 'compression' });
    assert.equal(requests[0].body.model, 'small-model');
    assert.equal(routed.actualModel, 'small-model');
    reset((body, res) => success(res));
    await agent.chatCompletion(config({ costKind: 'subagent' }), messages);
    assert.equal(requests[0].body.model, 'small-model');
    reset((body, res) => success(res));
    await agent.chatCompletion(config({ modelTaskType: 'compression', costKind: 'main' }), messages);
    assert.equal(requests[0].body.model, 'small-model', 'trusted task type overrides the actor category');
    reset((body, res) => success(res));
    await agent.compressToolContent(config({ compression: { cache: false, budgetChars: 20 } }), 'read_file', 'Long source content '.repeat(100));
    assert.equal(requests[0].body.model, 'small-model', 'production compression helper must select the configured task route');

    reset((body, res) => {
      if (body.model !== 'primary-model') return stream(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'discard-me', tool_calls: [
        { index: 0, id: 'unsafe-half-call', type: 'function', function: { name: 'write_file', arguments: '{"path":' } },
      ] } }] }) + '\n\n');
      setTimeout(() => res.destroy(), 20);
    });
    const deltas = [];
    const ledger = new CostLedger({ prices: { 'primary-model': { in: 1, out: 1 }, 'backup-model': { in: 1, out: 1 } } });
    const run = await agent.runAgentChat({ cfg: config({ costLedger: ledger }), messages: [...messages], onDelta: e => deltas.push(e) });
    assert.equal(run.content, 'clean', 'failed stream content must be erased before backup content');
    assert.equal(run.toolCalls.length, 0, 'incomplete tools from failed candidate must never execute');
    assert.ok(deltas.some(e => e.kind === 'content_reset'));
    assert.ok(deltas.some(e => e.kind === 'model_fallback'));
    assert.deepEqual(requests.map(r => r.body.model), ['primary-model', 'backup-model']);
    assert.ok(ledger.entries.some(e => e.kind === 'main' && e.model === 'backup-model'), 'successful usage must be attributed to actual model');

    reset((body, res) => json(res, 429, { error: 'rate limited' }));
    const root = new RequestBudget(100000, { retryLimit: 0 });
    await assert.rejects(agent.chatCompletion(config({ requestBudget: createSubagentBudget(root, 50000) }), messages),
      { code: 'RETRY_BUDGET_EXCEEDED' });
    assert.equal(requests.length, 1, 'fallback must share the parent retry allowance');
    assert.equal(root.reserved, 0);
    reset((body, res) => json(res, 503, { error: 'busy' }));
    const tokenBound = estimateInputTokens(messages, []) + 16;
    await assert.rejects(agent.chatCompletion(config({ requestBudget: new RequestBudget(tokenBound) }), messages),
      { code: 'BUDGET_EXCEEDED' });
    assert.equal(requests.length, 1, 'fallback must reserve tokens before HTTP');

    reset((body, res) => body.model === 'primary-model' ? json(res, 503, { error: 'busy' }) : success(res));
    const prices = { 'primary-model': { in: 1, out: 1 }, 'backup-model': { in: 100, out: 100 } };
    const moneyBound = new RequestBudget(100000, { costLimitUsd: 0.001, prices });
    await assert.rejects(agent.chatCompletion(config({ requestBudget: moneyBound, costPrices: prices }), messages),
      { code: 'COST_BUDGET_EXCEEDED' });
    assert.equal(requests.length, 1, 'backup must use its actual price before any HTTP request');
    assert.equal(moneyBound.costSnapshot().reservedUsd, 0);
    const missingPrice = new RequestBudget(100000, { costLimitUsd: 1, prices: { 'primary-model': prices['primary-model'] } });
    reset((body, res) => body.model === 'primary-model' ? json(res, 503, { error: 'busy' }) : stream(res));
    await assert.rejects(agent.chatCompletionStream(config({ requestBudget: missingPrice }), messages, () => {}),
      { code: 'COST_PRICE_MISSING' });
    assert.equal(requests.length, 1, 'missing backup price must not be swallowed by stream retries');

    const routeOnly = routing.parseConfig({ 'agent.model_candidate.small.model': 'small-model', 'agent.model_route.main': 'small' });
    reset((body, res) => success(res));
    const routedPriceMissing = new RequestBudget(100000, { costLimitUsd: 1, prices });
    await assert.rejects(agent.chatCompletion(config({ requestBudget: routedPriceMissing, modelRouting: routeOnly }), messages),
      { code: 'COST_PRICE_MISSING' });
    assert.equal(requests.length, 0, 'task route must use the selected model price even on first attempt');

    for (const { stopReason, limits } of [
      { stopReason: 'cost_limit', limits: { costLimitUsd: 0.000001, prices } },
      { stopReason: 'retry_limit', limits: { retryLimit: 0 } },
      { stopReason: 'token_limit', limits: {} },
    ]) {
      reset((body, res) => json(res, 503, { error: 'busy' }));
      const runBudget = new RequestBudget(stopReason === 'token_limit' ? 1 : 100000, limits);
      const outcome = await agent.runAgentChat({ cfg: config({ requestBudget: runBudget }), messages: [...messages] });
      assert.equal(outcome.stopReason, stopReason);
      assert.equal(outcome.state, 'LIMIT_REACHED');
    }

    reset((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'cancel-now' } }] }) + '\n\n');
    });
    const controller = new AbortController();
    await assert.rejects(agent.chatCompletionStream(config(), messages, event => {
      if (event.kind === 'content') controller.abort();
    }, { signal: controller.signal, timeoutMs: 2000 }));
    assert.equal(requests.length, 1, 'user cancellation must not send the configured backup request');

    reset((body, res) => json(res, 503, { error: 'busy' }));
    await assert.rejects(agent.chatCompletion(config(), messages));
    assert.equal(requests.length, 3, 'adding candidates must not multiply the HTTP ceiling');
    reset((body, res) => json(res, 503, { error: 'busy' }));
    await assert.rejects(agent.chatCompletion(config({ modelRouting: undefined }), messages));
    assert.deepEqual(requests.map(r => r.body.model), ['primary-model', 'primary-model', 'primary-model']);

    for (const code of ['COST_BUDGET_EXCEEDED', 'COST_PRICE_MISSING', 'COST_CONFIG_INVALID', 'TURN_TIMEOUT']) {
      assert.equal(routing.failureReason(Object.assign(new Error('stop'), { code })), null);
    }
    assert.throws(() => routing.parseConfig({ 'agent.model_fallbacks': 'missing' }), /未定义/);
    assert.throws(() => routing.candidateConfig(config(), { model: 'other', apiBase: 'https://another.invalid' }), /api_key_env/);
    process.env.CODENODE_ROUTING_TEST_KEY = 'backup-test-key';
    try {
      const cross = routing.candidateConfig(config(), { model: 'other', apiBase: 'https://another.invalid', apiKeyEnv: 'CODENODE_ROUTING_TEST_KEY' });
      assert.equal(cross.apiKey, 'backup-test-key');
      assert.notEqual(cross.apiKey, config().apiKey);
      /** @type {any} */
      let secondaryRequest = null;
      const secondary = http.createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        secondaryRequest = { body: JSON.parse(text), url: req.url, key: req.headers['x-api-key'], bearer: req.headers.authorization };
        json(res, 200, { content: [{ type: 'text', text: 'from-anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } });
      });
      await new Promise(resolve => secondary.listen(0, '127.0.0.1', () => resolve(undefined)));
      try {
        const providerRouting = routing.parseConfig({
          'agent.model_candidate.anthropic.model': 'claude-test',
          'agent.model_candidate.anthropic.api_base': 'http://127.0.0.1:' + /** @type {import('net').AddressInfo} */ (secondary.address()).port,
          'agent.model_candidate.anthropic.api_protocol': 'anthropic',
          'agent.model_candidate.anthropic.api_key_env': 'CODENODE_ROUTING_TEST_KEY',
          'agent.model_fallbacks': 'anthropic',
        });
        reset((body, res) => json(res, 503, { error: 'busy' }));
        const fallback = await agent.chatCompletion(config({ modelRouting: providerRouting }), messages);
        assert.equal(fallback.content, 'from-anthropic');
        assert.equal(fallback.actualModel, 'claude-test');
        assert.equal(secondaryRequest.body.model, 'claude-test');
        assert.equal(secondaryRequest.url, '/v1/messages');
        assert.equal(secondaryRequest.key, 'backup-test-key');
        assert.equal(secondaryRequest.bearer, undefined, 'primary bearer credentials must not follow cross-provider failover');
      } finally {
        secondary.closeAllConnections();
        await new Promise(resolve => secondary.close(resolve));
      }
    } finally { delete process.env.CODENODE_ROUTING_TEST_KEY; }
    console.log('MODEL ROUTING: PASS (real HTTP failover, task routes, stream reset, actual-model ledger, shared budgets, explicit credentials)');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
