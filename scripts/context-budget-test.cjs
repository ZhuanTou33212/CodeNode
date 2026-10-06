/**
 * context-budget-test.cjs —— 上下文预算（任务单第 1 项）的回归用例
 *
 * 缺陷（2026-09-17 实测）：工具结果只受「单条截断」与「压缩配额（按请求数计）」约束，
 * **没有整体上下文预算**。40 次 27KB 的 read_file 之后，第 11 次模型请求输入 434,743 字符
 * （≈145k tokens），压缩配额用尽后原文直接进上下文 —— 只能等模型 API 报超限，或者把成本烧穿。
 *
 * 修复：electron/contextBudget.cjs + agent.runAgentChat 在**每次请求前**裁剪（只裁旧的、
 * 超大的 tool 消息正文，换成可追溯占位符；system 与最近 N 条永不裁；结构/配对不动）。
 *
 * 判据（两段锁：该裁的必须裁、不该动的必须原样）：
 *   A. 纯函数：预算内不改 / 只裁旧 tool 正文 / 保留最近 N 条 / 幂等 / 结构不变 / 极端不假装成功
 *   B. 真实循环（脚本化模型 + 真实注册表）：末轮请求输入 ≤ 预算、裁剪事件如实上报、
 *      tool_calls↔tool_call_id 配对仍然合法、关掉开关时行为与旧版一致（证明是修复在起作用）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const contextBudget = require('../electron/contextBudget.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-ctxbudget-'));

/** 构造一条 tool 消息前的 assistant（配对合法） */
function pair(toolCallId, name, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: toolCallId, name, content },
  ];
}

// ======================= A. 纯函数 =======================
{
  const small = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  const a1 = contextBudget.planTrim(small, { maxChars: 100000 });
  check('A1 预算内不做任何改动', a1.plan.length === 0 && a1.after === a1.before && a1.overBudget === false, JSON.stringify({ before: a1.before, after: a1.after }));

  const big = [{ role: 'system', content: 'S'.repeat(10) }];
  for (let i = 0; i < 6; i++) big.push(...pair('call_' + i, 'read_file', 'R'.repeat(10000)));
  big.push({ role: 'user', content: '最后的问题' });
  const a2 = contextBudget.planTrim(big, { maxChars: 40000, keepRecent: 4, minResultChars: 2000 });
  const trimmedRoles = a2.plan.map((item) => big[item.index].role);
  check('A2 只裁 tool 消息的正文（不裁 system / user / assistant）',
    a2.plan.length > 0 && trimmedRoles.every((role) => role === 'tool'), JSON.stringify(trimmedRoles));
  check('A2b 裁到预算内就停手（不是全裁光）', a2.after <= 40000 && a2.overBudget === false, JSON.stringify({ after: a2.after, trimmed: a2.plan.length }));
  check('A2c 从最旧的开始裁（system=0、assistant=1、第一条 tool=2）', a2.plan[0].index === 2, 'first-index=' + a2.plan[0].index);

  const keptIndices = big.map((_, index) => index).filter((index) => index >= big.length - 4);
  const a3 = contextBudget.planTrim(big, { maxChars: 45000, keepRecent: 4, minResultChars: 2000 });
  check('A3 第一档：只裁「最近 N 条之外」的旧结果，保护窗口原样不动',
    a3.plan.length > 0 && a3.plan.every((item) => !keptIndices.includes(item.index)) && a3.tier === 1 && a3.overBudget === false,
    JSON.stringify({ tier: a3.tier, plan: a3.plan.map((item) => item.index), after: a3.after }));

  // 第二档：单个回合就灌满（预算连「最近 N 条」都放不下）→ 除 system 与最后 hardKeep 条之外都裁
  const a3b = contextBudget.planTrim(big, { maxChars: 1000, keepRecent: 4, minResultChars: 2000, hardKeepRecent: 2 });
  check('A3b 第二档：极小预算下仍保护 system 与最后 2 条，其余（含原保护窗口）可裁',
    a3b.tier === 2 && !a3b.plan.some((item) => item.index === 0 || item.index >= big.length - 2) && a3b.plan.length >= 4,
    JSON.stringify({ tier: a3b.tier, plan: a3b.plan.map((item) => item.index), after: a3b.after }));
  check('A3c 两档都压不住时如实报 overBudget=true（不谎报「已在预算内」）',
    a3b.overBudget === true, JSON.stringify({ after: a3b.after, overBudget: a3b.overBudget }));
  // 回归：第二档不得把第一档已裁过的下标再裁一次（会把节省重复计入 → after 变成负数）
  const applied = JSON.parse(JSON.stringify(big));
  const applied2 = contextBudget.applyTrim(applied, { maxChars: 1000, keepRecent: 4, minResultChars: 2000, hardKeepRecent: 2 });
  check('A3d 裁剪后的实际字符总量与计划一致、不为负（第二档不重复计账）',
    applied2.after === contextBudget.estimateChars(applied) && applied2.after >= 0,
    JSON.stringify({ planned: applied2.after, actual: contextBudget.estimateChars(applied) }));
  check('A3e 同一消息在计划里只出现一次',
    new Set(a3b.plan.map((item) => item.index)).size === a3b.plan.length, JSON.stringify(a3b.plan.map((item) => item.index)));

  const placeholder = contextBudget.placeholderFor('read_file', 12345);
  check('A4 占位符可追溯：带工具名 + 原文长度 + 怎么拿回来',
    placeholder.startsWith(contextBudget.TRIM_MARKER) && placeholder.includes('read_file') && placeholder.includes('12345') && placeholder.includes('相同参数'),
    placeholder.slice(0, 60));

  const idempotent = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 6; i++) idempotent.push(...pair('call_' + i, 'read_file', 'R'.repeat(10000)));
  const first = contextBudget.applyTrim(idempotent, { maxChars: 40000, keepRecent: 2, minResultChars: 2000 });
  const snapshot = JSON.stringify(idempotent);
  const second = contextBudget.applyTrim(idempotent, { maxChars: 40000, keepRecent: 2, minResultChars: 2000 });
  check('A5 幂等：已裁过的占位符不会被再裁一次',
    first.trimmed > 0 && second.trimmed === 0 && JSON.stringify(idempotent) === snapshot,
    JSON.stringify({ first: first.trimmed, second: second.trimmed }));

  const tiny = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 6; i++) tiny.push(...pair('call_' + i, 'read_file', 'R'.repeat(500)));
  const a6 = contextBudget.planTrim(tiny, { maxChars: 100, keepRecent: 0, minResultChars: 2000 });
  check('A6 小结果不裁；裁不动时如实报 overBudget=true（不假装成功）',
    a6.plan.length === 0 && a6.overBudget === true, JSON.stringify({ plan: a6.plan.length, overBudget: a6.overBudget }));

  // 结构不变：条数 / 角色序列 / tool_call_id / tool_calls 全等
  const structural = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 6; i++) structural.push(...pair('id_' + i, 'read_file', 'R'.repeat(10000)));
  const before = structural.map((message) => ({ role: message.role, id: message.tool_call_id || null, calls: message.tool_calls ? message.tool_calls.length : 0 }));
  contextBudget.applyTrim(structural, { maxChars: 40000, keepRecent: 2, minResultChars: 2000 });
  const after = structural.map((message) => ({ role: message.role, id: message.tool_call_id || null, calls: message.tool_calls ? message.tool_calls.length : 0 }));
  check('A7 裁剪不改结构：条数 / 角色顺序 / tool_call_id / tool_calls 逐项一致',
    JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before: before.length, after: after.length }));
}

// ======================= B. 真实循环 =======================
const total = 40;
const perTurn = 4;

for (let i = 0; i < total; i++) {
  fs.writeFileSync(path.join(root, `f${i}.txt`), Array.from({ length: 600 }, (_, j) => `line ${j} file${i} ` + 'y'.repeat(30)).join('\n'), 'utf8');
}
const fileChars = fs.statSync(path.join(root, 'f0.txt')).size;

/** 用真实注册表 + 真实工具循环跑一次脚本化对话 */
async function runLoop(options) {
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  const script = [];
  for (let t = 0; t < total / perTurn; t++) {
    script.push({
      toolCalls: Array.from({ length: perTurn }, (_, i) => ({ name: 'read_file', args: { path: `f${t * perTurn + i}.txt`, maxLines: 600 } })),
    });
  }
  script.push({ content: '完成' });
  const cfg = {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'scripted',
    model: 'scripted',
    maxTokens: 512,
    costRunId: 'ctx-budget-test',
    tools: {},
    limits: {},
    // 关键：压缩关掉 —— 让「上下文有界」这件事只能由预算裁剪来保证（不靠 S11 批量压缩）
    compression: { enabled: false },
    context: options.context,
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
  };
  const stub = installScriptedModel(script, { loopLast: false });
  const deltas = [];
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  // 必须在**请求发出的那一刻**记账：messages 是同一个数组引用，事后读 stub.seen 会被后续裁剪改写
  const sizes = [];
  const inner = global.fetch;
  global.fetch = async (url, init) => {
    let body = {};
    try { body = JSON.parse(String((init && init.body) || '{}')); } catch {}
    if (body.stream === true) sizes.push(contextBudget.estimateChars(body.messages || []));
    return inner(url, init);
  };
  let out;
  try {
    out = await agent.runAgentChat({ cfg, messages, tools: { registry, context }, onDelta: (delta) => deltas.push(delta) });
  } finally {
    global.fetch = inner;
    stub.restore();
  }
  return { out, deltas, messages, sizes };
}

function pairingValid(messages) {
  const declared = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) declared.add(call.id);
    if (message.role === 'tool' && !declared.has(message.tool_call_id)) return false;
  }
  return true;
}

(async () => {
  const limited = await runLoop({ context: { enabled: true, maxInputChars: 60000, keepRecentMessages: 4, minResultChars: 2000 } });
  const maxSize = Math.max(...limited.sizes);
  check('B1 真实循环：每次请求输入都被压在预算内（≤ 60000 字符）', maxSize <= 60000, 'maxInput=' + maxSize + '（未裁剪时实测 40 万+）');
  check('B2 裁剪发生在请求之前，且如实上报（result.contextTrims > 0 + context_trim delta）',
    limited.out.contextTrims > 0 && limited.deltas.some((delta) => delta.kind === 'context_trim'),
    JSON.stringify({ trims: limited.out.contextTrims, trimmedChars: limited.out.contextTrimmedChars, deltas: limited.deltas.filter((d) => d.kind === 'context_trim').length }));
  check('B3 裁剪后协议仍然合法：每个 tool 消息都能配到声明的 tool_call_id',
    pairingValid(limited.messages), '消息数=' + limited.messages.length);
  check('B3b 单条被裁的工具结果留了占位符（模型知道可以重取）',
    limited.messages.some((message) => message.role === 'tool' && contextBudget.isTrimmed(message.content)),
    '占位符条数=' + limited.messages.filter((m) => m.role === 'tool' && contextBudget.isTrimmed(m.content)).length);
  // 回归 #22：占位符必须写清「原本是哪次调用的结果」。
  // 真实循环产出的 tool 消息此前**不带 name**，于是占位符只能渲染成「此处原本是 **工具** 的结果」——
  // 而「请用相同参数重新调用该工具」这句里最有用的恰恰就是工具名。
  // 注意这里断言的是**生产同形**的消息（来自真实循环），不是本文件手搓的 fixture：
  // 旧的 A4 用例只测了 placeholderFor 纯函数，而 fixture 自带 name，所以生产缺 name 也一直是绿的。
  const trimmedToolNames = limited.messages
    .filter((message) => message.role === 'tool' && contextBudget.isTrimmed(message.content))
    .map((message) => message.name)
    .filter(Boolean);
  check(
    'B3c 生产同形的 tool 消息带 name（占位符才能写出真实工具名）',
    trimmedToolNames.length > 0,
    '被裁工具的消息 name=[' + trimmedToolNames.join(',') + ']'
  );
  check(
    'B3d 占位符正文里出现的是真实工具名，而不是笼统的「工具」',
    limited.messages
      .filter((message) => message.role === 'tool' && contextBudget.isTrimmed(message.content))
      .every((message) => !message.name || String(message.content).includes(String(message.name))),
    JSON.stringify(
      limited.messages
        .filter((m) => m.role === 'tool' && contextBudget.isTrimmed(m.content))
        .map((m) => String(m.content).slice(contextBudget.TRIM_MARKER.length).slice(0, 24))
    )
  );

  const tiny = await runLoop({ context: { enabled: true, maxInputChars: 2000, keepRecentMessages: 4, minResultChars: 2000 } });
  check('B1b 预算小到压不进（连硬保护的最后一条都放不下）时如实报 overBudget=true，不谎报已达预算',
    tiny.deltas.some((delta) => delta.kind === 'context_trim' && delta.overBudget === true),
    JSON.stringify(tiny.deltas.filter((d) => d.kind === 'context_trim').map((d) => d.overBudget).slice(0, 3)));

  // 关掉开关 → 行为回到旧版（上下文随结果线性增长，超过预算）——证明「有界」是这次修复带来的
  const unlimited = await runLoop({ context: { enabled: false, maxInputChars: 60000, keepRecentMessages: 4, minResultChars: 2000 } });
  const unmax = Math.max(...unlimited.sizes);
  check('B4 关掉 agent.context.trim 时行为与旧版一致（输入仍会超预算 —— 反向锁，防过度修复）',
    unmax > 60000 && unlimited.out.contextTrims === 0, 'maxInput=' + unmax + ' trims=' + unlimited.out.contextTrims);

  check('B5 契约默认值：默认开启、默认预算 250k 字符、最近 12 条不裁、硬保护 1 条',
    (() => {
      const cfg = agent.parseContextConfig({});
      return cfg.enabled === true && cfg.maxInputChars === 250000 && cfg.keepRecentMessages === 12 && cfg.hardKeepRecentMessages === 1;
    })(), JSON.stringify(agent.parseContextConfig({})));

  console.log('单文件 ' + fileChars + ' 字符 × ' + total + ' 次；裁剪后最大输入 ' + maxSize + ' 字符（未裁剪 ' + unmax + '）');
  console.log('裁剪档位：' + JSON.stringify(limited.deltas.filter((d) => d.kind === 'context_trim').map((d) => ({ tier: d.tier, trimmed: d.trimmed, before: d.before, after: d.after }))));
  fs.rmSync(root, { recursive: true, force: true });
  console.log('CONTEXT BUDGET TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('CONTEXT BUDGET TEST: ERROR', error);
  process.exit(1);
});
