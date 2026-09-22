#!/usr/bin/env node
/**
 * intent-cost-gate-test.cjs —— 阶段 B / P0-3 的回归判据：**把意图模型从默认热路径移到歧义/高风险边界**
 *
 * 审计的验收线（逐条对应下面各组）：
 *   - 普通代码 run 的 intent 调用平均 **<0.5 次**（确定性路由判得出来就不分类）；
 *   - **已经必定审批的动作不再产生 guardian 请求**（分类改变不了结果就不问）；
 *   - 风险分类变异测试与审批测试不回退（判据本身是纯函数，逐条变异；审批行为另有断言）。
 *
 * 判据分两类：
 *   A/B/C  纯函数层：确定性路由、`shouldClassify` 的 ambiguous 档、`shouldConsultGuardian` 四条准入；
 *   D/E    端到端：走**真实 `agent:chat` handler**（假 ipcMain + 脚本化模型），
 *          断言真实发生的 intent 调用数、`task_route` / `intent_action_review` 事件、
 *          以及最要紧的一条 ——**跳过 guardian 时用户该被问的仍然被问**（只收紧不放宽的安全不变量）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const intent = require('../electron/intent.cjs');
const taskRouter = require('../electron/taskRouter.cjs');
const runStore = require('../electron/runStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-gate-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-gate-ud-'));

/** 与 app 一致的项目夹具（可追加 agent.properties 行；可放 approvals.json 免打扰规则） */
function makeProject(name, extraProps, approvals) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
  const lines = [
    'api_base=http://scripted.local/v1',
    'api_key=scripted-key',
    'model=scripted-model',
    'tools.allowed=read_file,write_file,execute_shell,ui_control',
    'rag.enabled=false',
    'agent.compression.enabled=false',
    'agent.request_max_attempts=1',
    ...(extraProps || []),
  ];
  fs.writeFileSync(path.join(root, '.codenode', 'agent.properties'), lines.join('\n') + '\n');
  if (approvals) fs.writeFileSync(path.join(root, '.codenode', 'approvals.json'), JSON.stringify(approvals));
  return root;
}

/** 真实 ipc handler harness（与 agent-state-test 同款：假 ipcMain + 假 sender） */
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
  const requests = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, data) => {
      if (channel !== 'tools:request') return;
      requests.push(data); // 记录「问了用户什么」——跳过 guardian 的安全判据靠它
      const listener = listeners.get('tools:response');
      if (!listener) return;
      setTimeout(() => {
        try {
          if (data.type === 'confirm') listener({ sender: { id: 1 } }, { id: data.id, result: { ok: true } });
          else if (data.type === 'ask') listener({ sender: { id: 1 } }, { id: data.id, result: { answer: 'ok' } });
          // 界面动作也要应答：不应答的话 ui_control 会一直等（用例会挂住，不是断言失败）
          else if (data.type === 'ui') listener({ sender: { id: 1 } }, { id: data.id, result: { applied: true } });
        } catch {}
      }, 5);
    },
  };
  return { handlers, sender, requests };
}

// ============================ A. 确定性路由 ============================
console.log('== A. 确定性任务路由（判得出来就不花钱）==');
{
  const layers = require('../electron/agent.cjs').resolvePromptLayers;
  const route = (prompt, extra = {}) => {
    const l = layers({ canvasSummary: extra.canvasSummary || '[]', prompt, mode: extra.canvasMode || 'auto' });
    return taskRouter.routeTask({ prompt, canvas: l.canvas === true, canvasSummary: extra.canvasSummary || '[]' });
  };
  /** @type {Array<[string, string, boolean]>} */
  const cases = [
    ['读 a.txt', 'code', false],
    ['把 add 改成加法', 'code', false],
    ['把 electron/agent.cjs 的 buildSystemPrompt 改一下', 'code', false],
    ['统计 data/large.txt 里出现最多的模块编号', 'code', false],
    ['搜一下最新的资料', 'research', false],
    ['用子代理并行拆一下', 'orchestration', false],
    ['画布上建一条链路', 'canvas', false],
    ['你好', 'chat', false],
    ['继续', 'chat', false],
    ['这个怎么弄', 'unknown', true],
  ];
  for (const [prompt, task, ambiguous] of cases) {
    const got = route(prompt);
    check('[A] ' + JSON.stringify(prompt) + ' → ' + task + (ambiguous ? '（歧义→值得问模型）' : ''),
      got.task === task && got.ambiguous === ambiguous, JSON.stringify({ task: got.task, ambiguous: got.ambiguous, reason: got.reason }));
  }
  check('[A] 词表覆盖：任务类型都在枚举里', cases.every((c) => taskRouter.TASKS.includes(c[1])));
  check('[A] 与工具面判定**同源**（canvas/research/orchestration 直接读 resolveToolProfiles 的结论，不会互相打架）',
    route('搜一下最新的资料').profiles.includes('research') && route('画布上建一条链路').profiles.includes('canvas'));
}

// ============================ B. shouldClassify 的 ambiguous 档 ============================
console.log('\n== B. 分类门（默认 ambiguous）==');
{
  check('[B] 判得出来 → 不分类（普通代码 run 0 次调用）',
    intent.shouldClassify({ mode: 'ambiguous' }, '[]', { ambiguous: false }) === false);
  check('[B] 判不出来 → 分类', intent.shouldClassify({ mode: 'ambiguous' }, '[]', { ambiguous: true }) === true);
  check('[B] 变异/判别力：同一输入 ambiguous 翻转 → 结论必须翻转',
    intent.shouldClassify({ mode: 'ambiguous' }, '[]', { ambiguous: false }) !==
      intent.shouldClassify({ mode: 'ambiguous' }, '[]', { ambiguous: true }));
  check('[B] 兼容档不被改坏：never 永不 / always 每轮 / auto 仅空画布',
    intent.shouldClassify({ mode: 'never' }, '[]', { ambiguous: true }) === false &&
      intent.shouldClassify({ mode: 'always' }, '[{"id":"n1"}]', { ambiguous: false }) === true &&
      intent.shouldClassify({ mode: 'auto' }, '[]', { ambiguous: false }) === true &&
      intent.shouldClassify({ mode: 'auto' }, '[{"id":"n1"}]', { ambiguous: false }) === false);
  check('[B] 出厂默认档就是 ambiguous', intent.parseIntentConfig({}).mode === 'ambiguous');
}

// ============================ C. shouldConsultGuardian ============================
console.log('\n== C. 动作级准入（只问「分类能改变结果」的动作）==');
{
  /** @type {any} */
  const base = { mode: 'authorization-gap', effect: 'unknown', capability: 'shell.execute', wouldConfirm: false, rulesVerdict: 'allow' };
  check('[C] 外部副作用 + 静态层会放行 → 问（这是分类唯一能改变的结果）',
    intent.shouldConsultGuardian(base).consult === true && intent.shouldConsultGuardian(base).reason === 'authorization-gap');
  check('[C] 本地写（workspace.write）→ 不问（descriptor + 审批层负责，别再花一次）',
    intent.shouldConsultGuardian({ ...base, capability: 'workspace.write', effect: 'write' }).reason === 'local-effect');
  check('[C] 静态层本来就会问用户 → 不问（分类改不了结果）',
    intent.shouldConsultGuardian({ ...base, wouldConfirm: true }).reason === 'already-confirm');
  check('[C] 只读 → 不问', intent.shouldConsultGuardian({ ...base, readOnly: true }).reason === 'read-only');
  check('[C] 规则已拒绝 → 不问', intent.shouldConsultGuardian({ ...base, rulesVerdict: 'deny' }).reason === 'rules-deny');
  check('[C] 能力说不清（扩展/MCP 工具）→ 按副作用类别保守当外部：unknown 才问，write 不问',
    intent.shouldConsultGuardian({ ...base, capability: null, effect: 'unknown' }).consult === true &&
      intent.shouldConsultGuardian({ ...base, capability: null, effect: 'write' }).consult === false);
  check('[C] 关键反例（第一版写错的地方）：工具**不声明**必须审批 + 没有免打扰规则 → 仍然要问',
    intent.shouldConsultGuardian({ ...base, wouldConfirm: false, rulesVerdict: 'ask' }).reason === 'authorization-gap');
  check('[C] 兼容档：off 不问 / every 都问 / risky 只问写与外部',
    intent.shouldConsultGuardian({ ...base, mode: 'off' }).reason === 'mode-off' &&
      intent.shouldConsultGuardian({ ...base, mode: 'every', readOnly: true }).consult === true &&
      intent.shouldConsultGuardian({ ...base, mode: 'risky', capability: 'workspace.write', effect: 'write', mutatesWorkspace: true }).consult === true &&
      intent.shouldConsultGuardian({ ...base, mode: 'risky', capability: 'workspace.read', effect: 'read' }).consult === false);
  check('[C] 出厂默认档就是 authorization-gap', intent.parseIntentConfig({}).actionReview === 'authorization-gap');
}

// ============================ D/E. 端到端（真实 handler）============================
(async () => {
  console.log('\n== D. 端到端：普通代码 run 0 次分类调用 ==');
  const h = makeHarness();

  /** 跑一轮：返回 {intentCalls, events, requests} */
  async function run(root, prompt, script, requestId, opts = {}) {
    const stub = installScriptedModel(script, { loopLast: false, ...(opts.stub || {}) });
    try {
      const out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt, requestId });
      return { out, intentCalls: stub.intentCalls, seen: stub.seen };
    } finally {
      stub.restore();
    }
  }

  // D1：普通代码提问（带文件路径 = 强信号）→ 一次分类都不发
  const root1 = makeProject('code-run');
  const r1 = await run(root1, '把 a.txt 里的内容读出来', [{ content: '完成' }], 'run-code-gate');
  check('[D] **普通代码 run 的 intent 调用 = 0**（验收线 <0.5 次/run）', r1.intentCalls === 0, 'intentCalls=' + r1.intentCalls);
  const ev1 = runStore.readRun(root1, 'run-code-gate');
  const route1 = ev1.find((e) => e.type === 'task_route');
  check('[D] 落了 task_route 事件（可回放：这一轮是什么活、为什么没分类）',
    !!route1 && route1.task === 'code' && route1.ambiguous === false && route1.reason === 'code-words',
    route1 ? JSON.stringify({ task: route1.task, ambiguous: route1.ambiguous, reason: route1.reason }) : 'no-event');
  check('[D] 没有 intent 事件（没分类就没有判定）', ev1.filter((e) => e.type === 'intent').length === 0);

  // D2：含糊提问（无任何确定性信号）→ 分类一次
  const root2 = makeProject('vague-run');
  const r2 = await run(root2, '这个怎么弄', [{ content: '完成' }], 'run-vague');
  check('[D] 含糊提问 → 真的分类一次（模型的价值就在这里）', r2.intentCalls === 1, 'intentCalls=' + r2.intentCalls);
  const route2 = runStore.readRun(root2, 'run-vague').find((e) => e.type === 'task_route');
  check('[D] 事件里写明「判不出来」', !!route2 && route2.task === 'unknown' && route2.ambiguous === true, JSON.stringify(route2 || {}));

  // E1a：外部副作用 + 静态层本来不审批（execute_shell 默认不声明必须审批）→ **要问模型**：
  //      这时分类收紧是**唯一**能让它被问一次的东西（跳过 = 真的少一层收紧）
  const root3 = makeProject('shell-gap');
  const r3 = await run(root3, '跑一下 echo hi', [{ toolCalls: [{ name: 'execute_shell', args: { command: 'echo hi' } }] }, { content: '完成' }], 'run-shell-gap');
  const review3 = runStore.readRun(root3, 'run-shell-gap').filter((e) => e.type === 'intent_action_review');
  check('[E] 外部动作 + 静态层不审批（授权缺口）→ guardian 被咨询（consulted=true）',
    review3.length === 1 && review3[0].consulted === true && review3[0].gateReason === 'authorization-gap',
    JSON.stringify(review3.map((e) => ({ c: e.consulted, r: e.gateReason, t: e.tool }))));

  // E1b：审计条件 3 的正例 —— 该动作**本来需要审批**但**命中了免打扰规则**（本来会放行），
  //      分类收紧能把它拉回来问一次 → 值得问
  const root3b = makeProject('ui-allow', [], { rules: [{ tool: 'ui_control' }] });
  const r3b = await run(root3b, '把界面切到全部节点视图', [{ toolCalls: [{ name: 'ui_control', args: { action: 'view_all' } }] }, { content: '完成' }], 'run-ui-allow');
  const review3b = runStore.readRun(root3b, 'run-ui-allow').filter((e) => e.type === 'intent_action_review');
  check('[E] 需审批 + 免打扰规则命中（会放行）→ 仍然咨询（收紧能改变结果）',
    review3b.length === 1 && review3b[0].consulted === true && review3b[0].gateReason === 'authorization-gap',
    JSON.stringify(review3b.map((e) => ({ c: e.consulted, r: e.gateReason, wc: e.wouldConfirm }))));

  // E2：本地写 → **不问模型**（这是相对旧档 risky 的主要节省）
  const root4 = makeProject('local-write', [], { rules: [{ tool: 'write_file' }] });
  const r4 = await run(root4, '写一个 b.txt，内容是 hi', [{ toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'hi' } }] }, { content: '完成' }], 'run-local-write');
  const review4 = runStore.readRun(root4, 'run-local-write').filter((e) => e.type === 'intent_action_review');
  check('[E] 本地写 → 不咨询（consulted=false / local-effect），但工具照常执行',
    review4.length === 1 && review4[0].consulted === false && review4[0].reason === 'local-effect' &&
      fs.existsSync(path.join(root4, 'b.txt')),
    JSON.stringify(review4.map((e) => ({ c: e.consulted, r: e.reason }))));

  /**
   * E3：审计条件 4 的正例 —— 动作**本来就会问用户**（`ui_control` 自带强制确认，且没有免打扰规则）
   * → 分类改不了结果 → **不再花 guardian 调用**；而且用户该被问的仍然被问（安全不变量）。
   */
  const root5 = makeProject('must-ask');
  const before5 = h.requests.length;
  await run(root5, '把界面切到全部节点视图', [{ toolCalls: [{ name: 'ui_control', args: { action: 'view_all' } }] }, { content: '完成' }], 'run-must-ask');
  const review5 = runStore.readRun(root5, 'run-must-ask').filter((e) => e.type === 'intent_action_review');
  const asked5 = h.requests.slice(before5).filter((q) => q.type === 'confirm').length;
  check('[E] 静态层已经必问（工具自带强制确认、无免打扰规则）→ **不再花 guardian 调用**',
    review5.length === 1 && review5[0].consulted === false && review5[0].reason === 'already-confirm',
    JSON.stringify(review5.map((e) => ({ c: e.consulted, r: e.reason, wc: e.wouldConfirm }))));
  check('[E] **安全不变量**：跳过 guardian 不影响静态层 —— 用户该被问的仍然被问（没有静默放行）',
    asked5 >= 1, 'confirm 请求数=' + asked5);

  // F：负向 —— 全关掉时与「没有这个功能」一致：0 次 intent、审批行为照旧
  console.log('\n== F. 负向：全关掉 ==');
  const root6 = makeProject('all-off', ['agent.intent_recognition=never', 'agent.intent_action_review=off'], { rules: [{ tool: 'execute_shell' }] });
  const r6 = await run(root6, '跑一下 echo hi', [{ toolCalls: [{ name: 'execute_shell', args: { command: 'echo hi' } }] }, { content: '完成' }], 'run-all-off');
  check('[F] intent 调用 = 0', r6.intentCalls === 0, 'intentCalls=' + r6.intentCalls);
  const review6 = runStore.readRun(root6, 'run-all-off').filter((e) => e.type === 'intent_action_review');
  check('[F] 动作复核不咨询（mode-off），且没有 tighten 事件',
    review6.every((e) => e.consulted === false && e.reason === 'mode-off'), JSON.stringify(review6.map((e) => e.reason)));

  // G：接线（防「实现了但没接线」）
  console.log('\n== G. 接线 ==');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
  const regSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'registry.cjs'), 'utf8');
  check('[G] ipc 用确定性路由决定要不要分类', /taskRouter\.routeTask\(/.test(ipcSrc) && /ambiguous: taskRoute\.ambiguous/.test(ipcSrc));
  check('[G] ipc 用纯函数决定要不要咨询 guardian', /intentLib\.shouldConsultGuardian\(/.test(ipcSrc));
  check('[G] registry 把「静态层会怎么走」如实交给复核方',
    /effect: sideEffectsLib\.classify\(name\)/.test(regSrc) && /wouldConfirm: staticRequires && ruleAllows !== true/.test(regSrc));
  check('[G] 审批服务提供纯查询 preview（不弹窗、不签发）', /preview\(req = \{\}\)/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'approval.cjs'), 'utf8')));

  console.log('\n' + (failures === 0 ? 'INTENT COST GATE TEST: PASS（确定性路由 + 分类门 + 动作准入 + 安全不变量）' : 'INTENT COST GATE TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('INTENT COST GATE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
