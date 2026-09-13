'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chatCompletion, chatCompletionStream } = require('../electron/agent.cjs');
const modelStore = require('../electron/modelStore.cjs');
const runStore = require('../electron/runStore.cjs');
const { extensionEnv } = require('../electron/tools/extensions.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

function response(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function main() {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return response(503, 'temporary outage');
    return response(200, { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } });
  };
  const result = await chatCompletion(
    {
      apiBase: 'https://example.test', apiKey: 'test', model: 'test', maxTokens: 8,
      reliability: { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 },
    },
    [{ role: 'user', content: 'hello' }],
    { timeoutMs: 1000 }
  );
  assert.strictEqual(result.content, 'ok');
  assert.strictEqual(calls, 2, '503 应触发一次有限重试');

  calls = 0;
  global.fetch = async () => {
    calls++;
    return response(401, 'invalid key');
  };
  await assert.rejects(
    () => chatCompletion(
      { apiBase: 'https://example.test', apiKey: 'bad', model: 'test', maxTokens: 8, reliability: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2 } },
      [{ role: 'user', content: 'hello' }],
      { timeoutMs: 1000 }
    ),
    /HTTP 401/
  );
  assert.strictEqual(calls, 1, '401 等配置错误不得重试');

  calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return response(429, 'rate limited');
    return new Response('data: {"choices":[{"delta":{"content":"stream-ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const streamed = await chatCompletionStream(
    { apiBase: 'https://example.test', apiKey: 'test', model: 'test', maxTokens: 8, reliability: { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 } },
    [{ role: 'user', content: 'hello' }],
    () => {},
    { timeoutMs: 1000 }
  );
  assert.strictEqual(streamed.content, 'stream-ok');
  assert.strictEqual(calls, 2, '流式 429 也应触发有限重试');

  const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-model-store-'));
  try {
    modelStore.writeModels(modelRoot, [{ id: 'test', apiKey: 'super-secret', label: 'Test' }], 'test');
    const persisted = fs.readFileSync(path.join(modelRoot, 'models.json'), 'utf8');
    assert.ok(!persisted.includes('super-secret'), '模型配置文件不得保存明文 API Key');
    const internal = modelStore.readModels(modelRoot);
    assert.strictEqual(internal.models[0].apiKey, 'super-secret');
    assert.strictEqual(modelStore.toPublicModel(internal.models[0]).apiKey, '');
    assert.strictEqual(modelStore.toPublicModel(internal.models[0]).apiKeySet, true);
  } finally {
    fs.rmSync(modelRoot, { recursive: true, force: true });
  }

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-run-store-'));
  try {
    runStore.startRun(runRoot, 'run-complete', { model: 'test' });
    runStore.appendEvent(runRoot, 'run-complete', 'tool_result', { name: 'read_file', ok: true });
    runStore.finishRun(runRoot, 'run-complete', 'completed', { toolCount: 1 });
    assert.strictEqual(runStore.summarizeRun(runStore.readRun(runRoot, 'run-complete')).status, 'completed');
    runStore.startRun(runRoot, 'run-interrupted', { model: 'test' });
    assert.strictEqual(runStore.listRuns(runRoot).some((item) => item.runId === 'run-interrupted' && item.status === 'interrupted'), true);
    runStore.recoverInterrupted(runRoot);
    assert.ok(runStore.readRun(runRoot, 'run-interrupted').some((item) => item.type === 'run_recovered'));
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }

  const oldSecret = process.env.CODE_NODE_SECRET_TEST;
  process.env.CODE_NODE_SECRET_TEST = 'should-not-pass';
  try {
    const env = extensionEnv({ CODENODE_TEST: '1' }, []);
    assert.strictEqual(env.CODENODE_TEST, '1');
    assert.strictEqual(env.CODE_NODE_SECRET_TEST, undefined, '扩展环境不得继承未知密钥变量');
  } finally {
    if (oldSecret == null) delete process.env.CODE_NODE_SECRET_TEST;
    else process.env.CODE_NODE_SECRET_TEST = oldSecret;
  }

  const registry = new AgentToolRegistry();
  let executed = false;
  registry.register('required_tool', 'test', {
    type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
  }, async () => { executed = true; return { ok: true, text: 'done', data: {} }; });
  const invalid = await registry.execute('required_tool', {}, {});
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(executed, false, '参数错误不得进入工具执行器');
  const valid = await registry.execute('required_tool', { value: 'x' }, {});
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(executed, true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-agent-security-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_TOKEN=must-not-leak\n', 'utf8');
    const context = new AgentToolContext({ projectRoot: root });
    const tools = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });
    const read = await tools.execute('read_file', { path: '.env' }, context);
    assert.strictEqual(read.ok, false, 'read_file 不得读取 .env');
    const search = await tools.execute('search_files', { pattern: 'PRIVATE_TOKEN' }, context);
    assert.strictEqual(search.ok, true);
    assert.strictEqual(search.data.count, 0, 'search_files 不得返回敏感文件内容');
    const privateUrl = await tools.execute('fetch_url', { url: 'http://127.0.0.1:9/' }, context);
    assert.strictEqual(privateUrl.ok, false, 'fetch_url 不得访问回环地址');
    const localhostUrl = await tools.execute('fetch_url', { url: 'http://localhost:9/' }, context);
    assert.strictEqual(localhostUrl.ok, false, 'fetch_url 不得访问 localhost');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    global.fetch = originalFetch;
  }
  console.log('AGENT RELIABILITY/SECURITY TEST: PASS');
}

main().catch((error) => {
  console.error('AGENT RELIABILITY/SECURITY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
