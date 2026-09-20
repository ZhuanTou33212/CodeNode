/**
 * agent-steering-test.cjs —— 运行中插话（§4.2 的第二件事）
 *
 * 缺口：长任务（十几轮工具调用）跑偏时，此前**唯一的出口是整停** —— 一停就丢掉已完成的
 * 全部上下文与进度。现在用户可以在运行中插一句话，主循环在下一轮把它作为 user 消息送进请求体。
 *
 * 判据（全部落在**请求体字节**与**返回值**上，不采信自述）：
 *   A. 队列语义：drain 一次性取走；空内容拒绝；close 后 push 明确拒绝（不静默丢弃）；超长截断。
 *   B. 真跑一轮脚本化循环 + 运行中插话：插话**恰好出现一次**在那个 user 消息里、结果里
 *      `steeringInjected === 1`、delta 里有 `steer_injected`；**负向**：不插话时两个 run 的
 *      请求体逐字节相同、不出现任何 steer 痕迹（0 开销、0 行为变化）。
 *   C. 接线：主循环真的收到 steering（静态断言 ipc 传参）、preload 暴露、IPC 白名单登记。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const agent = require(path.join(ROOT, 'electron', 'agent.cjs'));
const toolkit = require(path.join(ROOT, 'electron', 'tools', 'toolkit.cjs'));
const { AgentToolContext } = require(path.join(ROOT, 'electron', 'tools', 'context.cjs'));
const sandbox = require(path.join(ROOT, 'electron', 'sandbox.cjs'));
const { createSteerQueue, MAX_STEER_CHARS } = require(path.join(ROOT, 'electron', 'steerQueue.cjs'));
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const STEER_TEXT = '别改 utils，只改 api 层';

// ============================ A. 队列语义 ============================
console.log('== A. 插话队列语义（独立模块，不起 Electron） ==');
{
  const queue = createSteerQueue();
  check('[A] 空队列 drain → []', Array.isArray(queue.drain()) && queue.drain().length === 0);
  check('[A] push 正常受理并计数', queue.push('第一句').accepted === true && queue.size === 1);
  queue.push('第二句');
  const drained = queue.drain();
  check('[A] drain 一次性取走全部且保持顺序', drained.length === 2 && drained[0] === '第一句' && drained[1] === '第二句', JSON.stringify(drained));
  check('[A] 再 drain 为空（同一句不会重复进请求体）', queue.drain().length === 0);
  check('[A] 空白内容拒绝（reason=empty）', queue.push('   ').accepted === false && queue.push('   ').reason === 'empty');
  check('[A] 超长插话被截断到上限', queue.push('x'.repeat(MAX_STEER_CHARS + 500)).accepted === true && queue.drain()[0].length === MAX_STEER_CHARS);
  queue.close();
  const afterClose = queue.push('再来一句');
  check('[A] close 后 push 明确拒绝（reason=run-ended，不静默丢弃）', afterClose.accepted === false && afterClose.reason === 'run-ended');
}

// ============================ B. 主循环插入 ============================
const script = [
  { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
  { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
  { content: '完成' },
];

/** 跑一轮脚本化循环；steerAfterFirstTool 为真时在第 1 次工具结果后插话 */
async function runScripted(withSteer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), withSteer ? 'codenode-steer-y-' : 'codenode-steer-n-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);
  const queue = createSteerQueue();
  const stub = installScriptedModel(script, { loopLast: false });
  const deltas = [];
  const result = await agent.runAgentChat({
    cfg: {
      apiBase: 'http://scripted.local/v1',
      apiKey: '',
      model: 'scripted-steer',
      maxTokens: 1024,
      reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
      limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
      compression: { enabled: false },
      rag: { enabled: false },
      tools: {},
    },
    messages: [
      { role: 'system', content: '测试用 system' },
      { role: 'user', content: '读一下 a.txt' },
    ],
    tools: {
      registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] }),
      context: new AgentToolContext({
        projectRoot: root,
        confirm: async () => true,
        audit: () => {},
        ragConfig: { enabled: false },
        sandbox: policy,
        signal: new AbortController().signal,
      }),
    },
    signal: new AbortController().signal,
    timeoutMs: 20000,
    steering: queue,
    onDelta: (delta) => {
      deltas.push(delta);
      // 第一次工具结果落地后插话：模拟「用户看到模型开始跑偏时按下插话」
      if (withSteer && delta && delta.kind === 'tool_result' && !queue.closed && queue.size === 0 && !queue.__used) {
        queue.__used = true;
        queue.push(STEER_TEXT);
      }
    },
  });
  stub.restore();
  queue.close();
  const bodies = stub.seen.map((item) => item.messages);
  return { root, result, deltas, bodies, queue };
}

(async () => {
  console.log('\n== B. 真跑一轮：插话必须恰好进一次请求体 ==');
  const noSteer = await runScripted(false);
  const withSteer = await runScripted(true);

  const steerMsgs = [];
  const perBody = [];
  for (const body of withSteer.bodies) {
    let count = 0;
    for (const message of body || []) {
      if (message && message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('【用户插话】')) {
        steerMsgs.push(message.content);
        count += 1;
      }
    }
    perBody.push(count);
  }
  check('[B] 插话作为 user 消息进了请求体', steerMsgs.length >= 1, JSON.stringify(steerMsgs.slice(0, 2)));
  check('[B] 插话内容原样带入（前缀 + 原文）', steerMsgs[0] === '【用户插话】' + STEER_TEXT, JSON.stringify(steerMsgs[0]));
  // 正确的不变式：**只被注入一次**（此后它作为历史消息留在后续请求里，0→1→1 才对；
  // 每个请求体里最多一条，且它不是每轮被重新 append 一遍）。第一版写成「全局只出现一次」是错的。
  check('[B] 插话只被注入一次：每个请求体里最多一条、且注入后不再增加', Math.max(...perBody) === 1 && perBody[perBody.length - 1] === 1, 'perBody=' + JSON.stringify(perBody));
  check('[B] 返回值如实报告 steeringInjected=1', withSteer.result.steeringInjected === 1, String(withSteer.result.steeringInjected));
  check('[B] delta 里有 steer_injected（界面可提示「已插话」）', withSteer.deltas.some((d) => d && d.kind === 'steer_injected' && d.text === STEER_TEXT));
  check('[B] 插话那一轮之后请求体里能看到它（不是插在最后一轮之后）', (() => {
    const idx = withSteer.bodies.findIndex((body) => (body || []).some((m) => typeof m.content === 'string' && m.content.startsWith('【用户插话】')));
    return idx > 0 && idx < withSteer.bodies.length - 1;
  })(), 'bodies=' + withSteer.bodies.length);

  console.log('\n== B(负向). 不插话时必须零痕迹 ==');
  check('[B] 不插话时 steeringInjected === 0', noSteer.result.steeringInjected === 0, String(noSteer.result.steeringInjected));
  check('[B] 不插话时没有任何 steer_injected delta', !noSteer.deltas.some((d) => d && d.kind === 'steer_injected'));
  check('[B] 不插话时请求体里没有任何插话消息', !noSteer.bodies.some((body) => (body || []).some((m) => typeof m.content === 'string' && m.content.includes('【用户插话】'))));
  // 逐字节对照：两个 run 的第 1 次请求体必须完全相同（插话不得改变「还没插话时」的任何字节）
  const firstSame = JSON.stringify(noSteer.bodies[0]) === JSON.stringify(withSteer.bodies[0]);
  check('[B] 插话前的那次请求体与基线逐字节相同（注入点不影响已有轮次）', firstSame, firstSame ? '' : 'len ' + JSON.stringify(noSteer.bodies[0]).length + ' vs ' + JSON.stringify(withSteer.bodies[0]).length);
  check('[B] 插话后的请求体恰好比基线多那一条 user 消息', withSteer.bodies[withSteer.bodies.length - 1].length === noSteer.bodies[noSteer.bodies.length - 1].length + 1, withSteer.bodies[withSteer.bodies.length - 1].length + ' vs ' + noSteer.bodies[noSteer.bodies.length - 1].length);

  console.log('\n== C. 接线（实现了必须真的接上） ==');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'agent.cjs'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
  const whitelist = fs.readFileSync(path.join(ROOT, 'scripts', 'ipc-registry-test.cjs'), 'utf8');
  const chatStore = fs.readFileSync(path.join(ROOT, 'src', 'store', 'chatStore.ts'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'components', 'side', 'AgentPanel.tsx'), 'utf8');
  check('[C] ipc 把 steering 传给了主循环', /steering:\s*steerQueue/.test(ipcSrc));
  check('[C] ipc 用独立模块建队列（不依赖 Electron 才能测）', /require\('\.\.\/steerQueue\.cjs'\)/.test(ipcSrc));
  check('[C] run 收尾会关闭并移除队列（否则插话会进死队列）', /steerQueue\.close\(\)/.test(ipcSrc) && /steeringQueues\.delete\(runId\)/.test(ipcSrc));
  check('[C] preload 暴露 steerAgent', /steerAgent:\s*\(requestId, text\)/.test(preloadSrc));
  check('[C] IPC 白名单登记 agent:steer', whitelist.includes("'agent:steer'"));
  check('[C] 前端 store 有 steer 动作（accept/拒绝都如实返回）', /steer:\s*async/.test(chatStore));
  check('[C] 界面上有插话入口（运行中才出现）', panel.includes('pp-steer-input') && panel.includes('pp-steer-send'));

  for (const dir of [noSteer.root, withSteer.root]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  console.log('\n' + (failures === 0 ? 'AGENT STEERING TEST: PASS（队列语义 / 插入一次 / 零痕迹 / 接线）' : 'AGENT STEERING TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('AGENT STEERING TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
