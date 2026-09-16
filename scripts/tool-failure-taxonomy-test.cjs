#!/usr/bin/env node
/**
 * tool-failure-taxonomy-test.cjs —— S5「结构化 ToolResult + FailureCode」用例（2026-09-16）
 *
 * 判据分两层：
 *   纯契约层（A–F）：码表/归一表/分类/提示配额/结构化结果的确定性断言；
 *   主循环层（G–J）：用脚本化模型跑**真实工具循环**，断言回灌给模型的提示真的按类别走、
 *     同一 toolCallId 有提示上限、未登记的错误码按最保守处理（不看中间变量，看实际请求体）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const failures = require('../electron/tools/failures.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

const ok = (label) => console.log('  ✓ ' + label);
const NUDGE_MARK = '【系统提示】本轮有';

// ============ 纯契约层 ============
// A. 码表与契约一一对应（防漂移）
for (const code of Object.keys(failures.FAILURE_CODES)) {
  assert.ok(failures.FAILURE_SPECS[code], 'FailureCode 缺 spec: ' + code);
}
for (const code of Object.keys(failures.FAILURE_SPECS)) {
  assert.ok(failures.FAILURE_CODES[code], 'FAILURE_SPECS 里有未登记的码: ' + code);
}
assert.strictEqual(failures.FAILURE_SPECS.TIMEOUT.retryable, true);
assert.strictEqual(failures.FAILURE_SPECS.PERMISSION_DENIED.retryable, false);
assert.strictEqual(failures.FAILURE_SPECS.PERMISSION_DENIED.userActionRequired, true);
assert.strictEqual(failures.FAILURE_SPECS.EFFECT_UNKNOWN.retryable, false);
ok('A 码表与契约一一对应（可重试/需用户介入语义明确）');

// B. legacy code 归一（项目里已在用的 data.code，不靠猜文本）
assert.strictEqual(failures.normalizeFailureCode('WORKBENCH_WRITE_DENIED'), 'PERMISSION_DENIED');
assert.strictEqual(failures.normalizeFailureCode('PATH_OUT_OF_ROOT'), 'ARG_SEMANTIC');
assert.strictEqual(failures.normalizeFailureCode('INVALID_TOOL_ARGUMENTS'), 'ARG_SCHEMA');
assert.strictEqual(failures.normalizeFailureCode('BUDGET_EXCEEDED'), 'FATAL_FAILURE');
assert.strictEqual(failures.normalizeFailureCode('SANDBOX_UNAVAILABLE'), 'FATAL_FAILURE');
assert.strictEqual(failures.normalizeFailureCode('SOME_NEW_CODE'), null, '未登记的码不能被猜成已知码');
ok('B legacy code → FailureCode 显式归一（未登记返回 null）');

// C. classifyFailure
const timeoutFailure = failures.classifyFailure({ ok: false, text: 'command timed out', data: { code: 'TIMEOUT' } }, { tool: 'execute_shell', toolCallId: 'c1' });
assert.strictEqual(timeoutFailure.code, 'TIMEOUT');
assert.strictEqual(timeoutFailure.category, 'timeout');
assert.strictEqual(timeoutFailure.retryable, true);
assert.strictEqual(timeoutFailure.known, true);
assert.strictEqual(timeoutFailure.toolCallId, 'c1');
assert.strictEqual(timeoutFailure.attemptId, 'c1#1');
const permFailure = failures.classifyFailure({ ok: false, text: '画布未写入', data: { code: 'WORKBENCH_WRITE_DENIED' } }, { tool: 'scan_project', toolCallId: 'c2' });
assert.strictEqual(permFailure.code, 'PERMISSION_DENIED');
assert.strictEqual(permFailure.retryable, false);
assert.strictEqual(permFailure.userActionRequired, true);
const timedOutFlag = failures.classifyFailure({ ok: false, text: '被强杀', data: { timedOut: true } }, { tool: 'execute_shell' });
assert.strictEqual(timedOutFlag.code, 'TIMEOUT', '结构化信号 timedOut 也要能识别');
const unknown = failures.classifyFailure({ ok: false, text: '奇怪的失败', data: { code: 'SOME_NEW_CODE' } }, { tool: 'x' });
assert.strictEqual(unknown.code, 'FATAL_FAILURE');
assert.strictEqual(unknown.known, false, '未登记的错误码必须标 known:false');
assert.strictEqual(unknown.legacyCode, 'SOME_NEW_CODE');
const noCode = failures.classifyFailure({ ok: false, text: '没有 code 的失败' }, { tool: 'y' });
assert.strictEqual(noCode.known, false);
ok('C classifyFailure（code / 归一 / 结构化信号 / 未登记保守）');

// D. planNudges：同一 toolCallId 的上限
/** @type {Record<string, number>} */
const counts = {};
const dup = [{ tool: 'a', toolCallId: 'dup', code: 'TIMEOUT', category: 'timeout' }];
assert.strictEqual(failures.planNudges(dup, counts, 2).emitted.length, 1);
assert.strictEqual(failures.planNudges(dup, counts, 2).emitted.length, 1);
const third = failures.planNudges(dup, counts, 2);
assert.strictEqual(third.emitted.length, 0, '第 3 次必须被抑制');
assert.strictEqual(third.skipped.length, 1);
assert.ok(String(third.skipped[0].skipReason).includes('上限'));
const other = failures.planNudges([{ tool: 'b', toolCallId: 'other', code: 'TIMEOUT', category: 'timeout' }], counts, 2);
assert.strictEqual(other.emitted.length, 1, '不同调用各自独立计数');
ok('D 提示配额：同一 toolCallId ≤ N 次，不同调用互不影响');

// E. buildFailureNudge 按类别给出不同指引
const argumentNudge = failures.buildFailureNudge([{ tool: 'read_file', code: 'ARG_SCHEMA', category: 'argument', retryable: true, hint: '按 schema 修正' }]);
const permissionNudge = failures.buildFailureNudge([{ tool: 'write_file', code: 'PERMISSION_DENIED', category: 'permission', retryable: false, hint: '不要原样重试' }]);
assert.ok(argumentNudge.includes('修正参数'), '参数类要给「改参数」的指引');
assert.ok(permissionNudge.includes('不要原样重试') && permissionNudge.includes('权限'), '权限类要劝退重试');
assert.ok(failures.buildFailureNudge([{ tool: 'execute_shell', code: 'TIMEOUT', category: 'timeout', retryable: true, hint: '缩小范围' }]).includes('后台'), '超时类要指向后台任务');
assert.ok(failures.buildFailureNudge([{ tool: 'x', code: 'FATAL_FAILURE', category: 'fatal', known: false, legacyCode: 'SOME_NEW_CODE', hint: '保守' }]).includes('未登记的错误码'), '未知码要标注出来');
assert.strictEqual(failures.buildFailureNudge([]), '', '没有失败就不产生提示');
ok('E 分类化提示（参数/权限/超时/未知码各给对应指引）');

// F. AgentToolResult 结构化 + 向后兼容
const legacyOk = AgentToolResult.ok('fine');
assert.strictEqual(legacyOk.ok, true);
assert.strictEqual(legacyOk.kind, 'success');
assert.strictEqual(legacyOk.failure, null);
const legacyErr = AgentToolResult.error('bad');
assert.strictEqual(legacyErr.ok, false);
assert.strictEqual(legacyErr.kind, 'failure');
assert.strictEqual(legacyErr.text, 'bad', 'ok/text/data 必须保持兼容');
const explicit = AgentToolResult.failure('PERMISSION_DENIED', '没有权限', { tool: 'write_file' });
assert.strictEqual(explicit.ok, false);
assert.strictEqual(explicit.data.code, 'PERMISSION_DENIED');
assert.strictEqual(explicit.data.failureCode, 'PERMISSION_DENIED');
assert.strictEqual(explicit.failure.category, 'permission');
assert.strictEqual(failures.classifyFailure(explicit).code, 'PERMISSION_DENIED', '显式声明的 failure 优先');
const partial = AgentToolResult.partial('3 个文件写了 2 个', { written: 2 }, [{ unit: 'b.txt', failure: failures.describeFailure('PERMISSION_DENIED', '拒绝') }]);
assert.strictEqual(partial.ok, true);
assert.strictEqual(partial.kind, 'partial');
assert.strictEqual(partial.failed.length, 1);
assert.strictEqual(partial.data.partialFailures[0].code, 'PERMISSION_DENIED');
ok('F AgentToolResult 结构化（kind/failure/partial）且 ok/text/data 兼容');

// ============ 主循环层（真实工具循环 + 脚本化模型） ============
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-failtax-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function makeRegistry() {
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
  registry.register('fail_permission', '测试替身：权限失败', { type: 'object', properties: {} }, async () =>
    AgentToolResult.failure('PERMISSION_DENIED', '只读上下文不允许执行会修改工作区的工具：write_file', { tool: 'fail_permission' }));
  registry.register('fail_unknown', '测试替身：未登记的失败码', { type: 'object', properties: {} }, async () =>
    AgentToolResult.error('某个没登记过的失败', { code: 'SOME_NEW_CODE' }));
  registry.register('fail_argument', '测试替身：参数类失败', { type: 'object', properties: {} }, async () =>
    AgentToolResult.failure('ARG_SCHEMA', '工具参数校验失败：$.path 必填', { tool: 'fail_argument' }));
  return registry;
}

function cfg() {
  return {
    apiBase: 'http://scripted.local/v1',
    apiKey: '',
    model: 'scripted-model',
    maxTokens: 2048,
    reasoningEffort: '',
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
    limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
    compression: { enabled: false },
    rag: { enabled: false },
    tools: {},
  };
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
    const result = await agent.runAgentChat({
      cfg: cfg(),
      messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '请完成测试任务' }],
      tools: { registry: makeRegistry(), context },
      signal: controller.signal,
      onDelta: () => {},
    });
    return { result, seen: stub.seen, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

const nudgeCount = (turn) => turn.seen.reduce((sum, req) => sum + req.messages.filter((m) => m.role === 'user' && String(m.content).includes(NUDGE_MARK)).length, 0);
void nudgeCount; // 保留给后续排查用（历史提示会累积，断言一律走「每轮新增」口径）

(async () => {
  // G. 权限类失败 → 提示必须劝退原样重试
  const permTurn = await runTurn([
    { toolCalls: [{ name: 'fail_permission', args: {}, id: 'call_perm' }], finishReason: 'tool_calls' },
    { content: '好，我换只读方式。', finishReason: 'stop' },
  ]);
  const permNudge = permTurn.seen.slice(1).flatMap((req) => req.messages).filter((m) => m.role === 'user' && String(m.content).includes(NUDGE_MARK));
  assert.strictEqual(permNudge.length, 1, '必须回灌一条分类化提示');
  assert.ok(String(permNudge[0].content).includes('权限'), '权限类要有「权限」标签');
  assert.ok(String(permNudge[0].content).includes('不要原样重试'), '权限类要明确劝退重试');
  assert.ok(!String(permNudge[0].content).includes('修正参数后重试'), '权限类不能给出「改参数重试」这种无效指引');
  ok('G 主循环：权限失败 → 分类化提示（劝退重试、要人介入）');

  // H. 参数类失败 → 提示指向「修正参数」
  const argTurn = await runTurn([
    { toolCalls: [{ name: 'fail_argument', args: {}, id: 'call_arg' }], finishReason: 'tool_calls' },
    { content: '好，我改参数。', finishReason: 'stop' },
  ]);
  const argNudge = argTurn.seen.slice(1).flatMap((req) => req.messages).filter((m) => m.role === 'user' && String(m.content).includes(NUDGE_MARK));
  assert.strictEqual(argNudge.length, 1);
  assert.ok(String(argNudge[0].content).includes('修正参数'), '参数类要指向修正参数');
  assert.ok(String(argNudge[0].content).includes('可重试'), '参数类应标记为可重试');
  ok('H 主循环：参数类失败 → 提示指向「修正参数」（且标可重试）');

  // I. 未登记的错误码 → 保守处理并如实标注
  const unknownTurn = await runTurn([
    { toolCalls: [{ name: 'fail_unknown', args: {}, id: 'call_unknown' }], finishReason: 'tool_calls' },
    { content: '我去核对。', finishReason: 'stop' },
  ]);
  const unknownNudge = unknownTurn.seen.slice(1).flatMap((req) => req.messages).filter((m) => m.role === 'user' && String(m.content).includes(NUDGE_MARK));
  assert.strictEqual(unknownNudge.length, 1);
  assert.ok(String(unknownNudge[0].content).includes('未登记的错误码'), '未登记的码要标注而不是假装认识');
  assert.ok(String(unknownNudge[0].content).includes('不可原样重试'), '保守处理：不可原样重试');
  ok('I 主循环：未登记错误码 → 保守处理并如实标注');

  // J. 同一 toolCallId 的提示上限（第 3 次不再灌提示）
  const dupTurn = await runTurn([
    { toolCalls: [{ name: 'fail_permission', args: {}, id: 'call_dup' }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'fail_permission', args: {}, id: 'call_dup' }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'fail_permission', args: {}, id: 'call_dup' }], finishReason: 'tool_calls' },
    { content: '停下来说明情况。', finishReason: 'stop' },
  ]);
  // 注意：messages 是**累积**的（上轮注入的提示会留在后续请求里），所以按「每轮新增」统计注入次数，
  // 而不是把历史提示重复计数 —— 后者会把「抑制生效」误判成「提示太多」。
  let seenNudges = 0;
  let injectedNudges = 0;
  for (const req of dupTurn.seen) {
    const now = req.messages.filter((m) => m.role === 'user' && String(m.content).includes(NUDGE_MARK)).length;
    injectedNudges += Math.max(0, now - seenNudges);
    seenNudges = now;
  }
  assert.strictEqual(injectedNudges, failures.NUDGE_MAX_PER_CALL, '同一调用最多注入 ' + failures.NUDGE_MAX_PER_CALL + ' 次提示');
  assert.strictEqual(seenNudges, failures.NUDGE_MAX_PER_CALL, '第 3 次失败不再新增提示（历史提示仍留在上下文里）');
  assert.ok(dupTurn.calls >= 4, '循环仍然继续（抑制的是提示，不是任务）');
  ok('J 主循环：同一 toolCallId 的提示上限生效（抑制提示但任务继续）');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('tool failure taxonomy ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
