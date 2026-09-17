/**
 * limit-wrapup-test.cjs —— 达到上限后的任务收尾（任务单第 2 项）的回归用例
 *
 * 缺陷：跑到 `agent.max_tool_iterations` / `agent.max_tool_calls` 时只回一句
 * 「已达到模型迭代上限，任务未完成。」—— 已完成什么、失败什么、涉及哪些文件、能不能续跑
 * 全都没有；界面还把这个 Run 当普通 error 丢掉（chatStore 只在 ok=true 时交付 reply，
 * 续跑列表又只列 status==='interrupted'）。
 *
 * 修复：agent.buildLimitWrapUp 生成结构化收尾 → 拼进 content（阶段性结果照样交付）、
 * 走 limit_reached delta + limit_wrapup trace；ipc 带 limitReached/wrapUp 给渲染层；
 * 界面把 LIMIT_REACHED 的 Run 也列进「可续跑」。
 *
 * 判据：结构化字段真实（工具名/成功数/失败码/涉及文件都来自真实调用记录）、
 * 模型已输出的部分不丢、两种上限（迭代 / 工具调用）都走同一条收尾路径。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-wrapup-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n'.repeat(20), 'utf8');
fs.writeFileSync(path.join(root, 'b.txt'), 'beta\n'.repeat(20), 'utf8');

async function runLoop(script, limits) {
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file', 'write_file'] });
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  const cfg = {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'scripted',
    model: 'scripted',
    maxTokens: 256,
    costRunId: 'wrapup-test',
    tools: {},
    limits,
    compression: { enabled: false },
    context: { enabled: false },
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
  };
  const stub = installScriptedModel(script, { loopLast: true });
  const deltas = [];
  let out;
  try {
    out = await agent.runAgentChat({
      cfg,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      tools: { registry, context },
      onDelta: (delta) => deltas.push(delta),
    });
  } finally {
    stub.restore();
  }
  return { out, deltas };
}

(async () => {
  // ======================= A. 纯函数 =======================
  {
    const view = agent.buildLimitWrapUp({
      stopReason: 'iteration_limit',
      loopIterations: 12,
      modelTurns: 12,
      toolCalls: [
        { name: 'read_file', ok: true, data: { path: 'src/a.js' } },
        { name: 'read_file', ok: true, data: { path: 'src/a.js' } },
        { name: 'write_file', ok: true, data: { path: 'src/b.js' } },
        { name: 'execute_shell', ok: false, result: '命令超时', data: { code: 'TIMEOUT' } },
      ],
    });
    check('A1 收尾文本含「已达上限」+ 实际执行过的工具与次数',
      view.text.includes('已达模型迭代上限') && view.text.includes('read_file×2') && view.text.includes('write_file×1'), view.text.split('\n')[1]);
    check('A2 失败的调用带工具名与失败码', view.text.includes('execute_shell（TIMEOUT）'), view.text.split('\n')[2]);
    check('A3 涉及文件从真实工具返回里取（去重）', JSON.stringify(view.data.touchedFiles) === JSON.stringify(['src/a.js', 'src/b.js']), JSON.stringify(view.data.touchedFiles));
    check('A4 结构字段齐全（executed/failed/resumable）',
      view.data.executed.length === 3 && view.data.failed.length === 1 && view.data.resumable === true && view.data.stopReason === 'iteration_limit',
      JSON.stringify({ executed: view.data.executed, failed: view.data.failed.length }));
    check('A5 明确写出「怎么续跑」而不是让用户自己猜', view.text.includes('续跑'), view.text.slice(-40));
    const empty = agent.buildLimitWrapUp({ stopReason: 'tool_limit', toolCalls: [] });
    check('A6 一次工具都没执行时如实说明（不编造进展）',
      empty.text.includes('已达工具调用上限') && empty.text.includes('没有成功完成的工具调用'), empty.text.split('\n')[1]);
  }

  // ======================= B. 真实循环：迭代上限 =======================
  {
    const { out, deltas } = await runLoop([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    ], { maxToolIterations: 3, maxTotalToolCalls: 100 });
    check('B1 迭代上限：stopReason=iteration_limit 且 state=LIMIT_REACHED',
      out.stopReason === 'iteration_limit' && out.state === 'LIMIT_REACHED', JSON.stringify({ stopReason: out.stopReason, state: out.state }));
    check('B2 content 交付出结构化收尾（不再是空内容 + 一句报错）',
      String(out.content || '').includes('【已达模型迭代上限，任务未完成】') && String(out.content).includes('已实际执行：'), String(out.content || '').slice(0, 80));
    check('B3 wrapUp.executed 与真实调用次数一致（read_file×3）',
      out.wrapUp && out.wrapUp.executed.length === 1 && out.wrapUp.executed[0].name === 'read_file' && out.wrapUp.executed[0].ok === 3,
      JSON.stringify(out.wrapUp && out.wrapUp.executed));
    check('B4 上报 limit_reached delta（界面据此提示「未完成 + 可续跑」）',
      deltas.some((delta) => delta.kind === 'limit_reached' && delta.wrapUp && delta.stopReason === 'iteration_limit'),
      JSON.stringify(deltas.filter((d) => d.kind === 'limit_reached').map((d) => d.stopReason)));
    check('B5 仍然是 error 语义（既有调用方不受影响）', typeof out.error === 'string' && out.error.includes('上限'), out.error);
    check('B6 兼容契约：error delta 仍然照发（评测 delta-kind:error 与旧消费方都锁着它）',
      deltas.some((delta) => delta.kind === 'error' && delta.stopReason === 'iteration_limit'),
      JSON.stringify(deltas.filter((d) => d.kind === 'error').map((d) => d.stopReason)));
  }

  // ======================= C. 真实循环：工具调用上限 =======================
  {
    const { out, deltas } = await runLoop([
      { content: '先读两个文件：', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    ], { maxToolIterations: 12, maxTotalToolCalls: 2 });
    check('C1 工具调用上限：stopReason=tool_limit 且文本如实说明',
      out.stopReason === 'tool_limit' && String(out.content).includes('【已达工具调用上限，任务未完成】'), JSON.stringify({ stopReason: out.stopReason }));
    check('C2 模型已输出的部分被保留在收尾之前（不吞掉半截回答）',
      String(out.content).startsWith('先读两个文件：') && String(out.content).includes('已达工具调用上限'), String(out.content).slice(0, 40));
    check('C3 limit_reached delta 带 stopReason=tool_limit', deltas.some((d) => d.kind === 'limit_reached' && d.stopReason === 'tool_limit'), 'deltas=' + deltas.filter((d) => d.kind === 'limit_reached').length);
  }

  // ======================= D. 失败信息进收尾 =======================
  {
    const { out } = await runLoop([
      { toolCalls: [{ name: 'read_file', args: { path: 'missing.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'missing2.txt' } }] },
    ], { maxToolIterations: 2, maxTotalToolCalls: 100 });
    check('D1 失败的工具调用出现在收尾的「失败的调用」里（带失败码）',
      !!out.wrapUp && out.wrapUp.failed.length === 2 && /失败/.test(String(out.content)) && out.wrapUp.failed.every((item) => item.tool === 'read_file' && item.code),
      JSON.stringify(out.wrapUp && out.wrapUp.failed));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('LIMIT WRAPUP TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('LIMIT WRAPUP TEST: ERROR', error);
  process.exit(1);
});
