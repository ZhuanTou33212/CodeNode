#!/usr/bin/env node
/**
 * scheduler-parallel-test.cjs —— S6「ToolScheduler：只读并行 + withTimeout + 取消贯穿」用例（2026-09-16）
 *
 * 判据落在**挂钟与真实工具循环**上（不看中间变量）：
 *   A/B/C 纯函数层：并发归一、withTimeout（超时/正常/onTimeout/不限时）、取消贯穿链；
 *   D/E  计划层：只读轮才并行、写操作整轮独占、并发上限、调用额度、malformed 跳过、事件带三个 id；
 *   F/G  主循环层：脚本化模型 + 真实 registry —— 串行基线耗时、并行加速、写独占（并发峰值）、
 *        顺序不变（tool 消息与 assistant 声明配对）、取消贯穿（父 abort → 子 signal abort 且立即返回）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const schedulerLib = require('../electron/tools/scheduler.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

const ok = (label) => console.log('  ✓ ' + label);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============ 纯函数层 ============
// A. 并发归一
assert.strictEqual(schedulerLib.clampConcurrency(3), 3);
assert.strictEqual(schedulerLib.clampConcurrency(99), schedulerLib.MAX_CONCURRENCY);
assert.strictEqual(schedulerLib.clampConcurrency(0), 1);
assert.strictEqual(schedulerLib.clampConcurrency('abc'), schedulerLib.DEFAULT_CONCURRENCY);
ok('A 并发数归一（1–' + schedulerLib.MAX_CONCURRENCY + '，非法值回落默认）');

(async () => {
  // B. withTimeout
  let timedOut = 0;
  const slow = await schedulerLib.withTimeout(() => sleep(120).then(() => AgentToolResult.ok('done')), 30, {
    tool: 'slow_read',
    toolCallId: 'c1',
    onTimeout: () => {
      timedOut += 1;
    },
  });
  assert.strictEqual(slow.ok, false, '超时必须返回失败结果');
  assert.strictEqual(slow.failure.code, 'TIMEOUT', '超时接 S5 的码表（TIMEOUT）');
  assert.strictEqual(timedOut, 1, 'onTimeout 必须被调用（用于 abort 底层执行）');
  const fast = await schedulerLib.withTimeout(() => Promise.resolve(AgentToolResult.ok('done')), 200, { tool: 'fast' });
  assert.strictEqual(fast.ok, true);
  const unlimited = await schedulerLib.withTimeout(() => sleep(20).then(() => AgentToolResult.ok('done')), 0, { tool: 'x' });
  assert.strictEqual(unlimited.ok, true, '0 表示不加限制');
  const boom = await schedulerLib.withTimeout(() => Promise.reject(new Error('炸了')), 200, { tool: 'x', toolCallId: 'c9' });
  assert.strictEqual(boom.ok, false);
  assert.strictEqual(boom.failure.code, 'SYSTEM_ERROR', '抛异常归到 SYSTEM_ERROR');
  ok('B withTimeout（超时= TIMEOUT / 正常放行 / 0 不限时 / 异常归类）');

  // C. 取消贯穿（父 abort → 子 controller abort）
  const parent = new AbortController();
  const child = new AbortController();
  const linked = schedulerLib.linkAbort(parent.signal, child);
  assert.strictEqual(linked.aborted, false);
  parent.abort();
  assert.strictEqual(linked.aborted, true, '父 abort 必须传导到子 signal');
  const parent2 = new AbortController();
  const child2 = new AbortController();
  const late = schedulerLib.linkAbort(parent2.signal, child2);
  parent2.abort();
  assert.strictEqual(late.aborted, true, '订阅前已 abort 的父 signal 也要能传导');
  ok('C 取消贯穿（父 signal → 子 controller）');

  // D. 计划层：只读轮并行、写操作整轮独占、并发上限、额度、malformed
  const descriptors = {
    read_a: { readOnly: true, mutatesWorkspace: false, timeoutMs: 0 },
    read_b: { readOnly: true, mutatesWorkspace: false, timeoutMs: 0 },
    read_c: { readOnly: true, mutatesWorkspace: false, timeoutMs: 0 },
    write_x: { readOnly: false, mutatesWorkspace: true, timeoutMs: 0 },
    confirm_x: { readOnly: true, mutatesWorkspace: false, requiresConfirmation: 'WRITE', timeoutMs: 0 },
  };
  const runStub = () => async () => AgentToolResult.ok('done');
  const baseDeps = (over) => Object.assign({ descriptorOf: (name) => descriptors[name] || null, execute: runStub() }, over || {});
  const items = (names) => names.map((name, i) => ({ callId: 'call_' + (i + 1), name }));

  const off = new schedulerLib.ToolScheduler({ enabled: false }).prime(items(['read_a', 'read_b']), baseDeps());
  assert.strictEqual(off.promises.size, 0, '默认关闭时必须零预启动（行为等价）');
  assert.strictEqual(off.enabled, false);

  const ro = new schedulerLib.ToolScheduler({ enabled: true, concurrency: 3 }).prime(items(['read_a', 'read_b']), baseDeps());
  assert.strictEqual(ro.promises.size, 2, '只读轮：两个只读都应预启动');
  assert.ok(ro.planned.every((p) => p.started === true));

  const mixed = new schedulerLib.ToolScheduler({ enabled: true, concurrency: 3 }).prime(items(['read_a', 'write_x', 'read_b']), baseDeps());
  assert.strictEqual(mixed.promises.size, 0, '本轮存在写操作 → 整轮串行（写操作独占）');
  assert.ok(mixed.planned.every((p) => String(p.reason).includes('整轮串行')));

  const needConfirm = new schedulerLib.ToolScheduler({ enabled: true }).prime(items(['confirm_x']), baseDeps());
  assert.strictEqual(needConfirm.promises.size, 0, '需要确认的调用同样整轮串行');

  const capped = new schedulerLib.ToolScheduler({ enabled: true, concurrency: 2 }).prime(items(['read_a', 'read_b', 'read_c']), baseDeps());
  assert.strictEqual(capped.promises.size, 2, '并发上限 2 → 只预启动 2 个');
  assert.strictEqual(capped.planned.filter((p) => !p.started).length, 1);
  assert.ok(String(capped.planned.find((p) => !p.started).reason).includes('并发上限'));

  const budgeted = new schedulerLib.ToolScheduler({ enabled: true, concurrency: 3 }).prime(items(['read_a', 'read_b']), baseDeps({ budget: 1 }));
  assert.strictEqual(budgeted.promises.size, 1, '调用额度用完时不再预启动');

  const malformed = new schedulerLib.ToolScheduler({ enabled: true, concurrency: 3 }).prime(items(['read_a', 'read_b']), baseDeps({ isMalformed: (item) => item.name === 'read_b' }));
  assert.strictEqual(malformed.promises.size, 1, '参数不完整的调用不预启动（其余照常并行）');
  assert.ok(String(malformed.planned.find((p) => !p.started).reason).includes('参数不完整'));
  ok('D 计划层（只读轮并行 / 写操作整轮独占 / 并发上限 / 额度 / malformed）');

  // E. 事件带 turnId / toolCallId / attemptId
  /** @type {any} */
  let traced = null;
  new schedulerLib.ToolScheduler({ enabled: true, concurrency: 3 }).prime(
    items(['read_a', 'write_x']).slice(0, 1),
    baseDeps({ turnId: 7, trace: (event) => { traced = event; } }),
  );
  assert.ok(traced, '预启动后必须落一条调度事件');
  assert.strictEqual(traced.kind, 'scheduler_parallel');
  assert.strictEqual(traced.turnId, 7);
  assert.strictEqual(traced.started[0].toolCallId, 'call_1');
  assert.strictEqual(traced.started[0].attemptId, 'call_1#1');
  ok('E 事件带 turnId / toolCallId / attemptId');

  // ============ 主循环层 ============
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-sched-'));
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);
  const SLOW_MS = 150;
  let inFlight = 0;
  let peak = 0;
  let completed = 0;
  let lastSignal = null;

  function makeRegistry() {
    inFlight = 0;
    peak = 0;
    completed = 0;
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
    const slowBody = (label) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(SLOW_MS);
      inFlight -= 1;
      completed += 1;
      return AgentToolResult.ok(label + ' done');
    };
    registry.registerDescriptor({ name: 'slow_read_a', description: '只读慢工具 A', inputSchema: { type: 'object', properties: { tag: { type: 'string' } } }, readOnly: true }, slowBody('a'));
    registry.registerDescriptor({ name: 'slow_read_b', description: '只读慢工具 B', inputSchema: { type: 'object', properties: { tag: { type: 'string' } } }, readOnly: true }, slowBody('b'));
    registry.registerDescriptor({ name: 'slow_write', description: '写慢工具', inputSchema: { type: 'object', properties: {} }, readOnly: false, mutatesWorkspace: true }, slowBody('w'));
    // 捕获传递到底层的 signal（用于断言取消贯穿真的到达执行体）
    const originalExecute = registry.execute.bind(registry);
    registry.execute = (name, args, context, info) => {
      if (info && info.signal) lastSignal = info.signal;
      return originalExecute(name, args, context, info);
    };
    return registry;
  }

  function cfg(parallel) {
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
      tools: { toolsParallel: parallel === true, toolsParallelConcurrency: 3 },
    };
  }

  async function runTurn(script, options) {
    const o = options || {};
    const controller = o.controller || new AbortController();
    inFlight = 0;
    peak = 0;
    completed = 0;
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
    const startedAt = Date.now();
    try {
      const result = await agent.runAgentChat({
        cfg: cfg(o.parallel),
        messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '请完成测试任务' }],
        tools: { registry: makeRegistry(), context },
        signal: controller.signal,
        onDelta: () => {},
      });
      return { result, seen: stub.seen, calls: stub.calls, elapsedMs: Date.now() - startedAt, peak: peak, completed: completed, lastSignal: lastSignal };
    } finally {
      stub.restore();
    }
  }

  // F. 串行基线 vs 并行加速（挂钟断言）
  const twoReads = [
    { toolCalls: [{ name: 'slow_read_a', args: { tag: '1' }, id: 'call_a' }, { name: 'slow_read_b', args: { tag: '2' }, id: 'call_b' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ];
  const serial = await runTurn(twoReads, { parallel: false });
  assert.ok(serial.peak === 1, '串行基线：并发峰值必须是 1（实际 ' + serial.peak + '）');
  assert.ok(serial.elapsedMs >= SLOW_MS * 2 - 20, '串行基线耗时应 ≥ 2×工具耗时（实际 ' + serial.elapsedMs + 'ms）');

  const parallel = await runTurn(twoReads, { parallel: true });
  assert.strictEqual(parallel.peak, 2, '并行：两个只读应同时在飞（峰值 2，实际 ' + parallel.peak + '）');
  assert.ok(parallel.elapsedMs < SLOW_MS * 2 - 40, '并行耗时必须明显小于串行（实际 ' + parallel.elapsedMs + 'ms）');
  assert.ok(parallel.elapsedMs >= SLOW_MS - 20, '并行也不会快过单个工具耗时');
  ok('F 只读并行真的并行（峰值 2；' + serial.elapsedMs + 'ms → ' + parallel.elapsedMs + 'ms）');

  // G. 顺序不变：tool 消息与 assistant 声明的 id 逐一对齐，且结果顺序 = 声明顺序
  const secondReq = parallel.seen[1];
  const assistantMsg = secondReq.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  const toolMsgs = secondReq.messages.filter((m) => m.role === 'tool');
  assert.deepStrictEqual(toolMsgs.map((m) => m.tool_call_id), assistantMsg.tool_calls.map((t) => t.id), 'tool 消息顺序必须与声明顺序一致');
  assert.ok(String(toolMsgs[0].content).includes('a done') && String(toolMsgs[1].content).includes('b done'), '结果必须按原顺序归位（不能串号）');
  ok('G 顺序不变（并行下 tool 消息仍与声明顺序逐一对齐）');

  // H. 写操作独占：同轮里有写 → 整轮串行（并行开关打开也不并发）
  const readWrite = [
    { toolCalls: [{ name: 'slow_read_a', args: {}, id: 'call_a' }, { name: 'slow_write', args: {}, id: 'call_w' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ];
  const writeTurn = await runTurn(readWrite, { parallel: true });
  assert.strictEqual(writeTurn.peak, 1, '含写操作时必须整轮串行（并发峰值 1，实际 ' + writeTurn.peak + '）');
  assert.ok(writeTurn.elapsedMs >= SLOW_MS * 2 - 20, '含写操作时耗时应 ≥ 2×工具耗时（实际 ' + writeTurn.elapsedMs + 'ms）');
  ok('H 写操作独占（本轮有写 → 整轮串行，开关打开也不并发）');

  // I. 取消贯穿：父 abort → 预启动的执行立刻收到 abort，主循环立即返回
  const controller = new AbortController();
  const slowScript = [
    { toolCalls: [{ name: 'slow_read_a', args: {}, id: 'call_a' }, { name: 'slow_read_b', args: {}, id: 'call_b' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ];
  const cancelRun = runTurn(slowScript, { parallel: true, controller });
  await sleep(30);
  controller.abort();
  const cancelled = await cancelRun;
  assert.strictEqual(cancelled.result.aborted, true, 'abort 后主循环必须如实返回 aborted');
  assert.strictEqual(cancelled.lastSignal && cancelled.lastSignal.aborted, true, '取消必须贯穿到传给工具执行的 signal');
  assert.ok(cancelled.elapsedMs < SLOW_MS + 60, '取消应立即返回（实际 ' + cancelled.elapsedMs + 'ms）');
  ok('I 取消贯穿（父 abort → 子 signal abort → 立即返回，' + cancelled.elapsedMs + 'ms）');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('scheduler parallel ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
