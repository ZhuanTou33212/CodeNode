#!/usr/bin/env node
/**
 * dynamic-context-budget-test.cjs —— 审计 §4 P1-2「给记忆与 RAG 统一 token 预算」的回归判据。
 *
 * 三条要求逐条对应：
 *   1. 各段（画布 / 记忆 / 技能 / RAG）**共用一个总预算**，不再各算各的；
 *   2. 优先级 + 单段 cap 决定谁被裁，且**如实记下**每段「想要多少 / 拿到多少 / 为什么」；
 *   3. **不触发时逐字节不变** —— 常见项目下 `granted === desired`，输出与没有这套预算时完全一致。
 *
 * 判据分三层：
 *   A. 分配器纯函数（优先级 / cap / 保底 / 关闭 / 配置解析）
 *   B. 两个裁剪函数（画布按节点裁且**仍是合法 JSON**；技能按整行裁）
 *   C. 端到端（真实 agent:chat handler）：负向逐字节比对 + 正例事件与文本
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const budget = require('../electron/dynamicContextBudget.cjs');
const agent = require('../electron/agent.cjs');
const runStore = require('../electron/runStore.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-dynctx-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-dynctx-ud-'));

// ============================ A. 分配器 ============================
console.log('== A. 分配器（优先级 / cap / 保底 / 关闭）==');
{
  // A1：都装得下 → 全额，理由 full（负向判据的根基）
  const full = budget.allocateContextBudget({
    totalTokens: 6000,
    sections: [
      { id: 'canvas', desiredTokens: 1000 },
      { id: 'memory', desiredTokens: 800 },
      { id: 'skills', desiredTokens: 200 },
    ],
  });
  check('[A] 都装得下 → granted === desired，逐段理由 full',
    full.granted.canvas === 1000 && full.granted.memory === 800 && full.granted.skills === 200 &&
      full.trace.every((t) => t.reason === 'full') && full.overcommit === 0,
    JSON.stringify(full.trace));

  // A2：总量不够 → 按优先级依次补，低优先级被裁
  const tight = budget.allocateContextBudget({
    totalTokens: 2000,
    sections: [
      { id: 'canvas', desiredTokens: 1800 },
      { id: 'memory', desiredTokens: 1000 },
      { id: 'skills', desiredTokens: 400 },
    ],
  });
  check('[A] 总量不够 → 高优先级先拿满，后面的被裁（记 trimmed/starved）',
    tight.granted.canvas === 1800 && tight.granted.memory === 200 && tight.granted.skills === 0 &&
      tight.trace.find((t) => t.id === 'memory').reason === 'trimmed' &&
      tight.trace.find((t) => t.id === 'skills').reason === 'starved' &&
      tight.used === 2000,
    JSON.stringify({ granted: tight.granted, reasons: tight.trace.map((t) => t.id + ':' + t.reason) }));

  // A3：单段 cap 生效（desired 超过 cap → 只给 cap，理由 capped）
  const capped = budget.allocateContextBudget({
    totalTokens: 100000,
    sections: [{ id: 'canvas', desiredTokens: 9000 }, { id: 'memory', desiredTokens: 500 }],
  });
  check('[A] 单段 cap 生效 → granted === cap，理由 capped（desired 记原值，便于归因）',
    capped.granted.canvas === 4000 && capped.granted.memory === 500 &&
      capped.trace.find((t) => t.id === 'canvas').reason === 'capped' &&
      capped.trace.find((t) => t.id === 'canvas').desired === 9000,
    JSON.stringify(capped.trace));

  // A4：保底优先于总预算，超了如实报 overcommit（不静默把某段饿成 0）
  const floored = budget.allocateContextBudget({
    totalTokens: 500,
    sections: [
      { id: 'canvas', desiredTokens: 400, capTokens: 400, minTokens: 300 },
      { id: 'rag', desiredTokens: 400, capTokens: 400, minTokens: 300 },
    ],
  });
  check('[A] 保底优先于总预算 → 两段各拿 300，overcommit 如实报出（不静默饿死）',
    floored.granted.canvas === 300 && floored.granted.rag === 300 && floored.overcommit === 100,
    JSON.stringify({ granted: floored.granted, overcommit: floored.overcommit }));

  // A5：关闭（total=0）→ 全 0（调用方据此整段跳过预算逻辑）
  const off = budget.allocateContextBudget({ totalTokens: 0, sections: [{ id: 'canvas', desiredTokens: 900 }] });
  check('[A] 关闭（total=0）→ 全额 0（调用方跳过裁剪 → 与没有这套预算一致）',
    off.granted.canvas === 0 && off.used === 0, JSON.stringify(off.granted));

  // A6：出厂配置
  check('[A] 出厂总预算 6000、四段 cap 与既有记忆预算一致（2000）',
    budget.DEFAULT_TOTAL_TOKENS === 6000 &&
      budget.DEFAULT_SECTIONS.length === 4 &&
      budget.DEFAULT_SECTIONS.find((s) => s.id === 'memory').capTokens === 2000,
    JSON.stringify(budget.DEFAULT_SECTIONS));
  const parsed = budget.parseDynamicContextConfig({});
  check('[A] 空配置 → 出厂值；非法值回落出厂值（不炸）',
    parsed.totalTokens === 6000 &&
      parsed.sections.find((s) => s.id === 'canvas').capTokens === 4000 &&
      budget.parseDynamicContextConfig({ 'agent.dynamic_context_tokens': '乱写' }).totalTokens === 6000,
    JSON.stringify(parsed));
  check('[A] 配置可改且夹在范围内（0 = 关闭；负数/超大不越界）',
    budget.parseDynamicContextConfig({ 'agent.dynamic_context_tokens': '0' }).totalTokens === 0 &&
      budget.parseDynamicContextConfig({ 'agent.dynamic_context_tokens': '-5' }).totalTokens === 0 &&
      budget.parseDynamicContextConfig({ 'agent.dynamic_context_canvas_tokens': '999999999' }).sections.find((s) => s.id === 'canvas').capTokens === 200000);
  check('[A] 接线：loadConfig 出口带 dynamicContext（防「实现了但没读配置」）',
    agent.loadConfig(path.join(tmp, 'nope')).dynamicContext.totalTokens === 6000);
}

// ============================ B. 裁剪函数 ============================
console.log('\n== B. 裁剪（画布按节点 / 技能按整行）==');
{
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: 'n' + i, type: 'task', name: '节点' + i, detail: '这是第' + i + '个节点的描述文本，用来把摘要撑大一点。' }));
  const summary = JSON.stringify(nodes);
  const asIs = agent.truncateCanvasSummary(summary, 100000);
  check('[B] 装得下 → 逐字节原样返回（负向判据）', asIs.text === summary && asIs.truncated === false && asIs.dropped === 0);

  const cut = agent.truncateCanvasSummary(summary, 400);
  let reparsed = null;
  try {
    reparsed = JSON.parse(cut.text.slice(0, cut.text.indexOf('\n')));
  } catch {}
  check('[B] 装不下 → 按节点裁，**裁剪后的 JSON 仍然合法**（模型不用猜）',
    cut.truncated === true && Array.isArray(reparsed) && reparsed.length > 0 && reparsed.length < nodes.length,
    'kept=' + (reparsed ? reparsed.length : 'null') + ' dropped=' + cut.dropped);
  check('[B] 裁剪后有**取回提示**且如实报出丢了多少节点',
    cut.dropped === nodes.length - (reparsed ? reparsed.length : 0) &&
      new RegExp('另有 ' + cut.dropped + ' 个节点未列出').test(cut.text) &&
      /get_workbench_model/.test(cut.text),
    cut.text.slice(-90).replace(/\n/g, '⏎'));
  check('[B] 预算 0 或不给 → 原样返回（不是「截成空」）',
    agent.truncateCanvasSummary(summary, 0).text === summary && agent.truncateCanvasSummary(summary, -3).text === summary);

  const broken = '这不是 JSON {' + 'x'.repeat(2000);
  const cutBroken = agent.truncateCanvasSummary(broken, 200);
  check('[B] 坏 JSON → 字符级裁剪 + 明确标注（不假装完整，也不抛错）',
    cutBroken.truncated === true && cutBroken.text.length < broken.length && /已按动态上下文预算/.test(cutBroken.text));

  const skills = ['- alpha：做甲事', '- beta：做乙事', '- gamma：做丙事'].join('\n');
  const skillsAsIs = agent.truncateSkillsIndex(skills, 100000);
  check('[B] 技能索引装得下 → 原样', skillsAsIs.text === skills && skillsAsIs.truncated === false);
  const skillsCut = agent.truncateSkillsIndex(skills, 12);
  check('[B] 技能索引按整行裁 + 如实报丢弃条数 + 留 read_skill 提示（不切半句话）',
    skillsCut.truncated === true && skillsCut.dropped === 1 && !/gamma/.test(skillsCut.text) &&
      /alpha/.test(skillsCut.text) && /read_skill/.test(skillsCut.text),
    JSON.stringify(skillsCut.text));
}

// ============================ C. 端到端 ============================
function makeProject(name, extraProps, memoryEntries) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
  const lines = [
    'api_base=http://scripted.local/v1',
    'api_key=scripted-key',
    'model=scripted-model',
    'tools.allowed=read_file,write_file',
    'rag.enabled=false',
    'agent.compression.enabled=false',
    'agent.request_max_attempts=1',
    ...(extraProps || []),
  ];
  fs.writeFileSync(path.join(root, '.codenode', 'agent.properties'), lines.join('\n') + '\n');
  if (memoryEntries) {
    fs.writeFileSync(
      path.join(root, '.codenode', 'memory.json'),
      JSON.stringify({ version: 1, entries: memoryEntries }),
    );
  }
  return root;
}

function makeHarness() {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    removeListener: (channel) => listeners.delete(channel),
  };
  const electronPath = require.resolve('electron');
  const electronStub = {
    ipcMain,
    app: { getPath: () => userDataDir },
    dialog: {},
    shell: {},
    BrowserWindow: function BrowserWindow() {},
  };
  /** @type {any} */ (require.cache)[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronStub };
  delete require.cache[require.resolve('../electron/ipc/agent.cjs')];
  delete require.cache[require.resolve('../electron/tools/bridge.cjs')];
  require('../electron/ipc/agent.cjs').register({ ipcMain: /** @type {any} */ (ipcMain), userDataDir: () => userDataDir });
  const sender = { id: 1, isDestroyed: () => false, send: () => {} };
  return { handlers, sender };
}

(async () => {
  const h = makeHarness();
  const bigCanvas = JSON.stringify(
    Array.from({ length: 400 }, (_, i) => ({ id: 'node-' + i, type: i % 2 ? 'task' : 'object', name: '流程节点' + i, note: '第' + i + '个节点的备注文字，用来把画布摘要撑到超过预算。' })),
  );

  async function runOnce(root, requestId, payload, script) {
    const stub = installScriptedModel(script, { loopLast: false });
    try {
      await h.handlers.get('agent:chat')({ sender: h.sender }, Object.assign({ projectRoot: root, prompt: '把 a.txt 读出来', requestId }, payload || {}));
      const main = stub.seen.find((s) => s.kind === 'main');
      return { prompt: main ? String(main.messages[0].content || '') : '', seen: stub.seen };
    } finally {
      stub.restore();
    }
  }

  console.log('\n== C. 端到端：不触发时逐字节不变 ==');
  // 同一个项目跑两次：一次关闭预算、一次用出厂预算 —— 内容完全一致 → system prompt 必须逐字节相同
  const root = makeProject('same', [], [
    { id: 'm1', key: 'a.txt', content: 'a.txt 是测试用的内容文件。', ts: '2026-01-01T00:00:00.000Z' },
  ]);
  const offRun = await runOnce(root, 'run-budget-off', { canvasSummary: JSON.stringify([{ id: 'n1', type: 'task', name: '节点1' }]), agentProps: null }, [{ content: '完成' }]);
  const onRun = await runOnce(root, 'run-budget-on', { canvasSummary: JSON.stringify([{ id: 'n1', type: 'task', name: '节点1' }]) }, [{ content: '完成' }]);
  // 关闭档用另一个项目目录（配置不同），内容逐字节相同（除项目路径外，而路径不在 system prompt 里）
  const rootOff = makeProject('same-off', ['agent.dynamic_context_tokens=0'], [
    { id: 'm1', key: 'a.txt', content: 'a.txt 是测试用的内容文件。', ts: '2026-01-01T00:00:00.000Z' },
  ]);
  const offRun2 = await runOnce(rootOff, 'run-budget-off2', { canvasSummary: JSON.stringify([{ id: 'n1', type: 'task', name: '节点1' }]) }, [{ content: '完成' }]);
  check('[C] 项目内容相同 → 开启预算与关闭预算的 system prompt **逐字节一致**（负向判据）',
    offRun2.prompt.length > 0 && offRun2.prompt === onRun.prompt,
    'off=' + offRun2.prompt.length + ' on=' + onRun.prompt.length);
  const evOn = runStore.readRun(root, 'run-budget-on').find((e) => e.type === 'context_budget');
  check('[C] 落了 context_budget 事件，每段理由都是 full（这一段没被裁）',
    !!evOn && evOn.trace.every((t) => t.reason === 'full' || t.reason === 'empty') && evOn.used > 0,
    evOn ? JSON.stringify(evOn.trace.map((t) => t.id + ':' + t.reason)) : 'no-event');
  check('[C] 关闭档不落 context_budget 事件（off 就是 off，不留痕不干扰）',
    !runStore.readRun(rootOff, 'run-budget-off2').some((e) => e.type === 'context_budget'));

  console.log('\n== C2. 端到端：画布超大 → 按节点裁且 JSON 仍合法 ==');
  const root2 = makeProject('big-canvas');
  const bigRun = await runOnce(root2, 'run-big-canvas', { canvasSummary: bigCanvas }, [{ content: '完成' }]);
  const evBig = runStore.readRun(root2, 'run-big-canvas').find((e) => e.type === 'context_budget');
  const canvasRow = evBig ? evBig.trace.find((t) => t.id === 'canvas') : null;
  check('[C] 事件里画布段是 capped（desired 记原值，便于归因）',
    !!canvasRow && canvasRow.reason === 'capped' && canvasRow.granted === 4000 && canvasRow.desired > 4000,
    JSON.stringify(canvasRow || {}));
  // 注意：段落标题在画布规则 f) 里也被**引用**过一次，所以必须按**行首**找（同一个坑在 splitPromptSections 里踩过）
  const promptLines = bigRun.prompt.split('\n');
  const headerAt = promptLines.findIndex((l) => l.startsWith('【当前画布节点清单'));
  let keptNodes = null;
  try {
    keptNodes = JSON.parse(promptLines[headerAt + 1] || '');
  } catch {}
  check('[C] prompt 里的画布摘要**被裁小且仍是合法 JSON**，并留了取回提示',
    Array.isArray(keptNodes) && keptNodes.length > 0 && keptNodes.length < 400 && /get_workbench_model/.test(bigRun.prompt),
    'kept=' + (keptNodes ? keptNodes.length : 'null') + ' promptChars=' + bigRun.prompt.length);
  check('[C] 画布被裁后提示词总长明显小于未裁时的摘要长度（真的省下来了）',
    bigRun.prompt.length < bigCanvas.length, bigRun.prompt.length + ' < ' + bigCanvas.length);

  console.log('\n== C3. 端到端：总预算调小 → 记忆被裁，项目级优先 ==');
  const midCanvas = JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({ id: 'node-' + i, type: 'task', name: '节点' + i, note: '备注文字撑一点体积' + i })),
  );
  const root3 = makeProject('tight-total', ['agent.dynamic_context_tokens=900'], [
    { id: 'm1', key: 'a.txt', content: '关于 a.txt 的记忆一。', ts: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', key: 'a', content: '关于 a 的记忆二。', ts: '2026-01-01T00:00:00.000Z' },
    { id: 'm3', key: 'txt', content: '关于 txt 的记忆三。', ts: '2026-01-01T00:00:00.000Z' },
  ]);
  await runOnce(root3, 'run-tight', { canvasSummary: midCanvas }, [{ content: '完成' }]);
  const evTight = runStore.readRun(root3, 'run-tight').find((e) => e.type === 'context_budget');
  check('[C] 总预算 900 + 大画布 → 画布先拿满 900、记忆被饿到 0（优先级真的在起作用）',
    !!evTight &&
      evTight.trace.find((t) => t.id === 'canvas').granted === 900 &&
      evTight.trace.find((t) => t.id === 'memory').granted === 0 &&
      ['trimmed', 'starved', 'capped'].includes(evTight.trace.find((t) => t.id === 'memory').reason),
    evTight ? JSON.stringify(evTight.trace.map((t) => t.id + ':' + t.granted + '/' + t.reason)) : 'no-event');

  console.log('\n== D. 接线 ==');
  {
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    check('[D] ipc 用统一预算分配（纯函数）+ 只在被裁时才重建/裁剪',
      /dynamicContext\.allocateContextBudget\(/.test(ipcSrc) &&
        /if \(trimOf\('canvas'\)\)/.test(ipcSrc) &&
        /if \(trimOf\('skills'\)\)/.test(ipcSrc) &&
        /if \(trimOf\('memory'\) && memCap !== memoryCap\)/.test(ipcSrc));
    check('[D] 注入给模型的是裁剪后的画布摘要（完整摘要仍留给分类/工具侧）',
      /buildSystemPrompt\(soul, canvasSummaryForPrompt,/.test(ipcSrc));
    check('[D] 两类记忆共用一个池子的口径没变（用户级拿剩余额度）',
      /budgetTokens: Math\.max\(0, memCap - rebuiltProj\.tokens\)/.test(ipcSrc));
  }

  console.log('\n' + (failures === 0 ? 'DYNAMIC CONTEXT BUDGET TEST: PASS（统一预算 + 优先级裁剪 + 不触发时逐字节不变）' : 'DYNAMIC CONTEXT BUDGET TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('DYNAMIC CONTEXT BUDGET TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
