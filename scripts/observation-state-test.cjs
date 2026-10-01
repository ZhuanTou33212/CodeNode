/** Observation reducer and real tool-loop protocol regression. */
'use strict';

const assert = require('node:assert/strict');
const agent = require('../electron/agent.cjs');
const observation = require('../electron/observationState.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

function record(callId, content, ok = true) {
  return { name: 'read_file', callId, args: '{"path":"a.txt"}', ok, result: content,
    ...(ok ? {} : { failure: { code: 'READ_FAILED' } }) };
}

async function runTurn(enabled) {
  const cfg = {
    apiBase: 'http://scripted.local/v1', apiKey: '', model: 'scripted-model', maxTokens: 512,
    reliability: { maxAttempts: 1, streamMaxAttempts: 0 },
    limits: { maxTotalTokens: 1000000 }, compression: { enabled: false }, rag: { enabled: false },
    tools: {}, observation: { enabled, budgetChars: 400 },
  };
  const registry = {
    toOpenAiTools: () => [{ type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } }],
    execute: async (_name, args) => AgentToolResult.ok('读取 ' + args.path),
  };
  const stub = installScriptedModel([
    { toolCalls: [{ name: 'probe', args: { path: 'a.txt' }, id: 'call_observation' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ], { loopLast: false });
  try {
    const result = await agent.runAgentChat({ cfg, messages: [{ role: 'user', content: '读取文件' }],
      tools: { registry, context: null }, onDelta: () => {} });
    return { result, seen: stub.seen };
  } finally {
    stub.restore();
  }
}

async function main() {
  const board = observation.createBlackboard();
  const first = observation.adaptToolResult(record('call_1', '旧内容'), '旧内容');
  const second = observation.adaptToolResult(record('call_2', '新内容'), '新内容');
  observation.reduceToolResults(board, [first, second]);
  assert.equal(board.domains.files.size, 1, '同资源的成功结果按调用顺序取最新版');
  assert.equal(board.domains.files.get(first.key).content, '新内容');
  const failed = observation.adaptToolResult(record('call_3', '读取失败', false), '读取失败');
  observation.reduceToolResults(board, [failed]);
  assert.equal(board.domains.files.get(first.key).content, '新内容', '失败不能覆盖已确认的文件状态');
  assert.equal(board.domains.diagnostics.size, 1);
  const view = observation.synthesizeObservation(board, { budgetChars: 400 });
  assert.match(view, /READ_FAILED/);
  assert.ok(view.length <= 400);

  const enabled = await runTurn(true);
  assert.equal(enabled.result.state, 'COMPLETED');
  assert.equal(enabled.seen.length, 2, '观察汇总不发额外模型请求');
  const secondRequest = enabled.seen[1].messages;
  const declared = secondRequest.find((msg) => msg.role === 'assistant' && msg.tool_calls);
  const tools = secondRequest.filter((msg) => msg.role === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_call_id, declared.tool_calls[0].id);
  assert.match(tools[0].content, /【工具观察汇总】/);
  assert.equal(secondRequest.filter((msg) => msg.role === 'user').length, 1, '观察视口不另造 user 消息');

  const disabled = await runTurn(false);
  assert.equal(disabled.result.state, 'COMPLETED');
  assert.doesNotMatch(disabled.seen[1].messages.find((msg) => msg.role === 'tool').content, /【工具观察汇总】/);
  console.log('OBSERVATION STATE TEST: PASS');
}

main().catch((error) => {
  console.error('OBSERVATION STATE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
