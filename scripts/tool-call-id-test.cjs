/**
 * tool-call-id-test.cjs —— tool_call_id 与 assistant 声明的 id 必须一致（真实工具循环）
 *
 * 回归 bug（P0）：主循环里三处各自生成 tool call id ——
 *   assistant 消息：`id: tc.id || ('call_' + iter + '_' + Math.random()...)`
 *   tool 响应消息：`tool_call_id: tc.id || ''`
 *   检查点/账本：`callId = tc.id || 'call_' + iter + '_' + totalToolCalls`
 * 供应商不返回 `tc.id`（部分 OpenAI 兼容实现只在首个分片给 id，或干脆不给）时，
 * 模型侧声明的 id 是随机的，而 role:"tool" 消息的 tool_call_id 是空串 —— 两者对不上，
 * 下一轮请求会被服务端以「tool 消息引用了不存在的 tool_call」拒绝（400），对话直接崩。
 *
 * 判据落在**真实终态**：脚本化模型驱动真实 runAgentChat（真实注册表 + 真实工具执行），
 * 然后检查第二次请求体里 messages 的结构一致性 —— 不看任何中间变量。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-callid-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
fs.writeFileSync(path.join(root, 'b.txt'), 'CONTENT-B\n');

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function makeRegistry() {
  return toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['read_file', 'list_directory'],
  });
}

async function runTurn(script) {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const stub = installScriptedModel(script, { loopLast: false });
  try {
    return await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'scripted',
        model: 'scripted-model',
        maxTokens: 2048,
        reasoningEffort: '',
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: { registry: makeRegistry(), context },
      signal: controller.signal,
      onDelta: () => {},
    });
  } finally {
    stub.restore();
  }
}

/** 从「第二次请求的 messages」里取出 assistant 声明的 id 与后续 tool 消息的 tool_call_id */
function inspectPairing(messages) {
  const declared = [];
  const responded = [];
  let pending = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      pending = message.tool_calls.map((call) => call.id);
      for (const id of pending) declared.push(id);
    } else if (message.role === 'tool') {
      responded.push({ id: message.tool_call_id, pending: pending.slice() });
    }
  }
  return { declared, responded };
}

function assertPairing(label, seen, result) {
  const request = seen[1];
  check(label + '：模型被追问了第二轮（说明第一轮工具消息被接受）', !!request, 'seen=' + seen.length);
  if (!request) return;
  const { declared, responded } = inspectPairing(request.messages);
  check(label + '：第一轮有 ' + responded.length + ' 条 tool 响应与 ' + declared.length + ' 个声明 id',
    declared.length === 2 && responded.length === 2, JSON.stringify({ declared, responded: responded.map((r) => r.id) }));
  check(label + '：assistant 声明的 id 全部非空', declared.every((id) => typeof id === 'string' && id.trim().length > 0), JSON.stringify(declared));
  check(label + '：tool 消息的 tool_call_id 全部非空', responded.every((r) => typeof r.id === 'string' && r.id.trim().length > 0), JSON.stringify(responded.map((r) => r.id)));
  check(label + '：tool_call_id 与所属 assistant 消息声明的 id 一一对应',
    responded.every((r) => r.pending.includes(r.id)), JSON.stringify(responded));
  check(label + '：同一响应内 id 不重复', new Set(declared).size === declared.length, JSON.stringify(declared));
  check(label + '：两个并发 tool call 各自独立（未互相覆盖）',
    declared.length === 2 && declared[0] !== declared[1], JSON.stringify(declared));
  check(label + '：工具真的执行成功（is_error 未污染语义）', !!result && !result.error && Array.isArray(result.toolCalls) && result.toolCalls.every((t) => t.ok), JSON.stringify(result && result.toolCalls && result.toolCalls.map((t) => ({ n: t.name, ok: t.ok }))));
}

(async () => {
  // 场景 1：供应商完全不返回 id（SSE 分片里没有 id 字段）
  let stub = installScriptedModel([
    {
      content: '',
      toolCalls: [
        { name: 'read_file', args: { path: 'a.txt' }, omitId: true },
        { name: 'read_file', args: { path: 'b.txt' }, omitId: true },
      ],
    },
    { content: '两个文件都读完了。' },
  ], { loopLast: false });
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root, confirm: async () => true, audit: () => {}, askUser: async () => '',
    ragConfig: { enabled: false }, sandbox: policy, signal: controller.signal,
  });
  let result;
  try {
    result = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1', apiKey: 'scripted', model: 'scripted-model', maxTokens: 2048,
        reasoningEffort: '', reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false }, rag: { enabled: false }, tools: {},
      },
      messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '读两个文件' }],
      tools: { registry: makeRegistry(), context },
      signal: controller.signal,
      onDelta: () => {},
    });
    assertPairing('[无 id]', stub.seen, result);
  } finally {
    stub.restore();
  }

  // 场景 2：供应商给了空串 id（等价于缺失，同样不能写出 tool_call_id:''）
  const stub2 = installScriptedModel([
    { content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: '' }, { name: 'read_file', args: { path: 'b.txt' }, id: '' }] },
    { content: '读完了。' },
  ], { loopLast: false });
  const controller2 = new AbortController();
  const context2 = new AgentToolContext({
    projectRoot: root, confirm: async () => true, audit: () => {}, askUser: async () => '',
    ragConfig: { enabled: false }, sandbox: policy, signal: controller2.signal,
  });
  let result2;
  try {
    result2 = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1', apiKey: 'scripted', model: 'scripted-model', maxTokens: 2048,
        reasoningEffort: '', reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false }, rag: { enabled: false }, tools: {},
      },
      messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '读两个文件' }],
      tools: { registry: makeRegistry(), context: context2 },
      signal: controller2.signal,
      onDelta: () => {},
    });
    assertPairing('[空 id]', stub2.seen, result2);
  } finally {
    stub2.restore();
  }

  // 场景 3：供应商给了正常 id → 必须原样透传（不能被我们改写成自生成 id）
  const stub3 = installScriptedModel([
    { content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'provider-call-abc' }] },
    { content: '读完了。' },
  ], { loopLast: false });
  const controller3 = new AbortController();
  const context3 = new AgentToolContext({
    projectRoot: root, confirm: async () => true, audit: () => {}, askUser: async () => '',
    ragConfig: { enabled: false }, sandbox: policy, signal: controller3.signal,
  });
  try {
    await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1', apiKey: 'scripted', model: 'scripted-model', maxTokens: 2048,
        reasoningEffort: '', reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false }, rag: { enabled: false }, tools: {},
      },
      messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '读文件' }],
      tools: { registry: makeRegistry(), context: context3 },
      signal: controller3.signal,
      onDelta: () => {},
    });
    const second = stub3.seen[1];
    const { declared, responded } = inspectPairing(second ? second.messages : []);
    check('[供应商 id]：原样透传，未被改写', declared.length === 1 && declared[0] === 'provider-call-abc' && responded[0].id === 'provider-call-abc',
      JSON.stringify({ declared, responded: responded.map((r) => r.id) }));
  } finally {
    stub3.restore();
  }

  // 场景 4：assignCallIds 自身是纯函数：稳定、按 index、忽略空白 id
  const assigned = agent.assignCallIds([{ id: '' }, {}, { id: 'x-1' }, { id: ' x-2 ' }], 3);
  check('assignCallIds：空/缺失 id 按下标补齐，给定 id 去空白保留',
    assigned[0].callId === 'call_3_1' && assigned[1].callId === 'call_3_2' && assigned[2].callId === 'x-1' && assigned[3].callId === 'x-2',
    JSON.stringify(assigned.map((a) => a.callId)));

  console.log(failures === 0 ? 'TOOL CALL ID TEST: PASS' : 'TOOL CALL ID TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('TOOL CALL ID TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
