/**
 * agent-plan-test.cjs —— 任务清单（`update_plan`，对照 Codex 的 update_plan / Claude Code 的 TodoWrite）
 *
 * 本轮补的短板（见 `docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 #2）：
 * harness 此前只有**机器注入**的进度条，模型自己没地方写下「分几步、现在在哪一步」——
 * 长任务只剩「闷头调到撞上限」或「漂到别的目标上」两种结局。
 *
 * 判据分四层（全部落在可核对的终态上）：
 *   A 纯函数：归一化/渲染/统计（含 5 条参数错误分支）
 *   B 契约：descriptor（不改工作区、不进缓存、不打扰用户）
 *   C 工具执行：落盘 + run 事件 + 逐条校验 + 只读上下文可用 + 子代理角色拿不到
 *   D 端到端（真实工具循环 + 脚本化模型）：计划立刻回灌、只留一条、不堆叠、负向零痕迹
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const planLib = require('../electron/plan.cjs');
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-plan-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'v1\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function contextWith(runId, extra) {
  return new AgentToolContext(
    Object.assign(
      {
        projectRoot: root,
        runId: runId || '',
        confirm: async () => true,
        audit: () => {},
        askUser: async () => '',
        ragConfig: { enabled: false },
        sandbox: policy,
        signal: new AbortController().signal,
      },
      extra || {}
    )
  );
}

function registry(opts) {
  return toolkit.buildDefaultRegistryWithConfig(
    Object.assign({ projectRoot: root, ragEnabled: false }, opts || {})
  );
}

(async () => {
  // ==================== A. 纯函数 ====================
  console.log('\n== A. 纯函数（归一化 / 渲染 / 统计）==');
  {
    const ok = planLib.normalizePlan([
      { step: '读 a.txt', status: 'completed' },
      { step: '改 a.txt', status: 'in_progress' },
      { step: '跑测试', status: 'pending' },
    ]);
    check('[A] 合法计划归一化通过', ok.ok === true && ok.items.length === 3, JSON.stringify(ok));
    check('[A] 统计口径一致', JSON.stringify(planLib.summarizePlan(ok)) === JSON.stringify({ total: 3, completed: 1, inProgress: 1, pending: 1 }), JSON.stringify(planLib.summarizePlan(ok)));
    const text = planLib.renderPlan(ok);
    check('[A] 渲染带三种状态标记与计数', /\[x\] 读 a\.txt/.test(text) && /\[→\] 改 a\.txt/.test(text) && /\[ \] 跑测试/.test(text) && /共 3 项/.test(text), text.replace(/\n/g, ' | '));

    /** @type {Array<[string, any, string]>} */
    const cases = [
      ['非数组', { items: 'x' }, 'ARG_SCHEMA'],
      ['空数组', { items: [] }, 'ARG_SCHEMA'],
      ['超过上限', { items: Array.from({ length: planLib.MAX_PLAN_ITEMS + 1 }, (_, i) => ({ step: 's' + i, status: 'pending' })) }, 'ARG_SCHEMA'],
      ['缺 status', { items: [{ step: 'a' }] }, 'ARG_SCHEMA'],
      ['非法 status', { items: [{ step: 'a', status: 'done' }] }, 'ARG_SCHEMA'],
      ['step 为空', { items: [{ step: '   ', status: 'pending' }] }, 'ARG_SCHEMA'],
      ['step 超长', { items: [{ step: 'x'.repeat(planLib.MAX_STEP_CHARS + 1), status: 'pending' }] }, 'ARG_SCHEMA'],
      ['两个 in_progress', { items: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }, 'ARG_SEMANTIC'],
    ];
    for (const [label, input, code] of cases) {
      const res = planLib.normalizePlan(input.items);
      check('[A] 拒绝：' + label + '（' + code + '）', res.ok === false && res.code === code, JSON.stringify({ ok: res.ok, code: res.code, error: res.error }));
    }
    check('[A] 空计划渲染如实说明（不编造）', planLib.renderPlan(null) === '（当前计划为空）');
    check('[A] 计划文件落在 .codenode/runs/ 且 runId 做安全化', /codenode[\\/]runs[\\/]run\.a_b\.plan\.json$/.test(planLib.planFile(root, 'run.a/b')), planLib.planFile(root, 'run.a/b'));
    check('[A] 读不到返回 null（不抛）', planLib.readPlan(root, 'no-such-run') === null);
  }

  // ==================== B. 契约 ====================
  console.log('\n== B. 工具契约（descriptor）==');
  {
    const reg = registry();
    const d = reg.descriptorOf('update_plan');
    check('[B] 工具已注册', !!d, JSON.stringify(d && d.name));
    check('[B] 不是只读工具（不进只读缓存白名单）', d.readOnly === false && d.cachePolicy.mode === 'none', JSON.stringify({ readOnly: d.readOnly, cache: d.cachePolicy }));
    check('[B] 不改工作区（画布/文件都不动）', d.mutatesWorkspace === false, String(d.mutatesWorkspace));
    check('[B] 不弹用户确认（Agent 内部状态）', d.requiresConfirmation === false, String(d.requiresConfirmation));
    check('[B] schema 闭合（未知字段当场拒绝）', d.inputSchema.additionalProperties === false && d.inputSchema.properties.items.items.additionalProperties === false);
    check('[B] schema 与常量同源（maxItems/maxLength/enum）', d.inputSchema.properties.items.maxItems === planLib.MAX_PLAN_ITEMS && d.inputSchema.properties.items.items.properties.step.maxLength === planLib.MAX_STEP_CHARS && JSON.stringify(d.inputSchema.properties.items.items.properties.status.enum) === JSON.stringify(planLib.PLAN_STATUSES.slice()), JSON.stringify(d.inputSchema.properties.items.items.properties.status));
    check('[B] 未声明 requiresConfirmation 的工具不会被强制审批（确认策略默认沿用描述符）', d.confirmationEnforced === false);
  }

  // ==================== C. 工具执行 ====================
  console.log('\n== C. 工具执行（落盘 / 事件 / 校验 / 角色）==');
  {
    const runId = 'run-plan-c1';
    const reg = registry({ toolsAllowed: ['update_plan'] });
    const res = await reg.execute(
      'update_plan',
      { items: [{ step: '读 a.txt', status: 'completed' }, { step: '改 a.txt', status: 'in_progress' }] },
      contextWith(runId)
    );
    check('[C] 执行成功且回显渲染后的清单', res.ok === true && /计划已更新/.test(String(res.text)) && /\[→\] 改 a\.txt/.test(String(res.text)), String(res.text || '').slice(0, 100));
    check('[C] 结果带结构化统计（供界面/审计用）', res.data.total === 2 && res.data.completed === 1 && res.data.inProgress === 1 && res.data.persisted === true, JSON.stringify(res.data));
    const file = planLib.planFile(root, runId);
    check('[C] 落盘到 .codenode/runs/<runId>.plan.json', fs.existsSync(file) === true, file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('[C] 落盘内容与入参一致（含 runId/updatedAt）', saved.runId === runId && saved.items.length === 2 && saved.items[0].status === 'completed' && typeof saved.updatedAt === 'string', JSON.stringify(saved).slice(0, 140));
    const inLoop = agent.readRunPlan(root, { costRunId: runId });
    check('[C] 主循环的读取口径能读到同一份（readRunPlan）', inLoop && inLoop.items.length === 2, JSON.stringify(inLoop));
    const jsonl = path.join(root, '.codenode', 'runs', runId + '.jsonl');
    const lines = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8').trim().split(/\r?\n/) : [];
    const planEvents = lines.filter((l) => /"type":"plan_updated"/.test(l));
    check('[C] run 事件里落了一条 plan_updated（含条数与文件）', planEvents.length === 1 && /"total":2/.test(planEvents[0]), planEvents[0] ? planEvents[0].slice(0, 160) : 'none');
    const eventsFile = path.join(root, '.codenode', 'events.jsonl');
    const busLines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    check('[C] 统一事件流（events.jsonl）也能看到它（S8 桥接）', /plan_updated/.test(busLines), busLines.split(/\r?\n/).filter((l) => /plan_updated/.test(l))[0] || 'none');
  }
  {
    // 同参重复调用必须**真的执行两次**（状态变更不是幂等读）
    const runId = 'run-plan-c2';
    const reg = registry({ toolsAllowed: ['update_plan'] });
    const args = { items: [{ step: 'a', status: 'pending' }] };
    const first = await reg.execute('update_plan', args, contextWith(runId));
    const second = await reg.execute('update_plan', args, contextWith(runId));
    check('[C] 同参重复调用两次都真的执行（不是缓存命中）', first.ok === true && second.ok === true && second.data.repeated !== true && second.data.persisted === true, JSON.stringify({ first: first.data && first.data.persisted, second: second.data && second.data.persisted, repeated: second.data && second.data.repeated }));
  }
  {
    // 校验失败：连一个文件都不该写
    const runId = 'run-plan-c3';
    const reg = registry({ toolsAllowed: ['update_plan'] });
    const bad = await reg.execute('update_plan', { items: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }, contextWith(runId));
    check('[C] 两个 in_progress → 工具报错（ARG_SEMANTIC）且不落盘', bad.ok === false && bad.data.code === 'ARG_SEMANTIC' && fs.existsSync(planLib.planFile(root, runId)) === false, JSON.stringify({ ok: bad.ok, code: bad.data && bad.data.code }));
    const unknown = await reg.execute('update_plan', { items: [{ step: 'a', status: 'pending', owner: 'me' }] }, contextWith(runId));
    check('[C] 步骤里的未知字段被闭合 schema 拒绝', unknown.ok === false, JSON.stringify({ ok: unknown.ok, code: unknown.data && unknown.data.code }));
  }
  {
    // 没有 run 上下文：如实说明未落盘，而不是谎报
    const reg = registry({ toolsAllowed: ['update_plan'] });
    const res = await reg.execute('update_plan', { items: [{ step: 'a', status: 'pending' }] }, contextWith(''));
    check('[C] 无 runId → 成功但如实标注未落盘', res.ok === true && res.data.persisted === false && /未落盘/.test(String(res.text)), String(res.text || '').slice(-40));
  }
  {
    // 只读上下文可用（它不改工作区）；子代理角色默认拿不到（计划是主代理的职责）
    const reg = registry({ toolsAllowed: ['update_plan'] });
    const readOnlyCtx = contextWith('run-plan-c4', { readOnly: true });
    check('[C] context.readOnly() 为真（前置）', readOnlyCtx.readOnly() === true);
    const res = await reg.execute('update_plan', { items: [{ step: 'a', status: 'pending' }] }, readOnlyCtx);
    check('[C] 只读上下文里不被拦（不改工作区，属 Agent 内部状态）', res.ok === true, JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));

    const sub = toolkit.filterByRole(registry(), 'explorer');
    const names = sub.listTools().map((t) => t.name);
    check('[C] explorer 子代理拿不到 update_plan（计划是主代理职责）', names.includes('update_plan') === false && names.length > 0, 'tools=' + names.join(','));
  }

  // ==================== D. 端到端（真实循环 + 脚本化模型）====================
  console.log('\n== D. 端到端：计划立刻回灌、只留一条、不堆叠 ==');
  let lastSeen = [];
  /** 本轮的流式增量（计划卡判据用：主进程要发 kind:'plan' 才能让界面看到计划） */
  let lastDeltas = [];
  async function runTurn(script, cfgOverrides = /** @type {any} */ ({})) {
    /** @type {any} */
    const { limits: limitsOverride, ...rest } = cfgOverrides || {};
    const controller = new AbortController();
    const runId = (rest && rest.costRunId) || 'run-plan-e2e';
    const context = contextWith(runId);
    const stub = installScriptedModel(script, { loopLast: false });
    lastDeltas = [];
    try {
      const result = await agent.runAgentChat({
        cfg: Object.assign(
          {
            apiBase: 'http://scripted.local/v1',
            apiKey: 'scripted-test',
            model: 'scripted-model',
            maxTokens: 1024,
            reasoningEffort: '',
            costRunId: runId,
            reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
            compression: { enabled: false },
            rag: { enabled: false },
            tools: {},
          },
          rest,
          { limits: Object.assign({ maxTotalTokens: 1000000, maxConcurrentRuns: 1 }, limitsOverride || {}) }
        ),
        messages: [
          { role: 'system', content: '测试用 system' },
          { role: 'user', content: '请完成测试任务' },
        ],
        tools: { registry: registry({ toolsAllowed: ['update_plan', 'read_file'] }), context },
        onDelta: (d) => {
          if (d && d.kind) lastDeltas.push(d);
        },
        signal: controller.signal,
        timeoutMs: 20000,
      });
      lastSeen = stub.seen || [];
      return result;
    } finally {
      stub.restore();
    }
  }

  function notesIn(request) {
    const list = (request && request.messages) || [];
    return list.filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(agent.PROGRESS_NOTE_PREFIX));
  }

  await runTurn(
    [
      { toolCalls: [{ id: 'u1', name: 'update_plan', args: { items: [{ step: '读 a.txt', status: 'in_progress' }, { step: '改 a.txt', status: 'pending' }] } }] },
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'work/a.txt' } }] },
      { toolCalls: [{ id: 'u2', name: 'update_plan', args: { items: [{ step: '读 a.txt', status: 'completed' }, { step: '改 a.txt', status: 'in_progress' }] } }] },
      { content: '完成' },
    ],
    { limits: { progressEvery: 3 } }
  );
  check('[D] 第一轮（iter=0）不注入（还没有东西可注入）', notesIn(lastSeen[0]).length === 0, 'requests=' + lastSeen.length);
  check('[D] 计划工具的结果进了下一轮上下文（模型看得到自己的清单）', (lastSeen[1].messages || []).some((m) => m && m.role === 'tool' && /计划已更新/.test(String(m.content))), 'msgs=' + (lastSeen[1].messages || []).length);
  check(
    '[D] 计划刚变过就立刻回灌（1 < progressEvery=3，不能等满 3 轮）',
    notesIn(lastSeen[1]).length === 1 && /计划（共 2 项/.test(String(notesIn(lastSeen[1])[0].content)) && /\[→\] 读 a\.txt/.test(String(notesIn(lastSeen[1])[0].content)),
    JSON.stringify(notesIn(lastSeen[1]).map((m) => String(m.content).slice(0, 80)))
  );
  const third = notesIn(lastSeen[2]);
  check('[D] 第二次更新后仍只有一条（原地替换，不堆叠）', third.length === 1, 'notes=' + third.length);
  /**
   * 注意断言取的是**最后一次请求**：iter=2 那条注入发生在模型调用 second update_plan **之前**，
   * 所以「最新计划」只在下一轮的注入里才可见（第一次写用例时正是栽在这个时序上）。
   */
  const lastReq = notesIn(lastSeen[lastSeen.length - 1]);
  check('[D] 最新计划在下一轮生效（[x] 读 a.txt / [→] 改 a.txt）', /\[x\] 读 a\.txt/.test(String(lastReq[0] && lastReq[0].content)) && /\[→\] 改 a\.txt/.test(String(lastReq[0] && lastReq[0].content)), String(lastReq[0] && lastReq[0].content).slice(-90));
  check('[D] 历史里的进度清单始终只有一条（不因计划变动而变两条）', (lastSeen[lastSeen.length - 1].messages || []).filter((m) => m && typeof m.content === 'string' && m.content.startsWith(agent.PROGRESS_NOTE_PREFIX)).length === 1);
  check('[D] 进度统计与计划在同一条消息里（共用就地替换的那条）', /进度检查/.test(String(lastReq[0] && lastReq[0].content)));
  {
    const saved = JSON.parse(fs.readFileSync(planLib.planFile(root, 'run-plan-e2e'), 'utf8'));
    check('[D] 终态落盘是第二次更新的版本', saved.items[0].status === 'completed' && saved.items[1].status === 'in_progress', JSON.stringify(saved.items));
  }
  {
    const jsonl = path.join(root, '.codenode', 'runs', 'run-plan-e2e.jsonl');
    const n = fs
      .readFileSync(jsonl, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /"type":"plan_updated"/.test(l)).length;
    check('[D] 两次 update_plan 各留一条 run 事件（可回放）', n === 2, 'events=' + n);
  }
  // 负向：没有计划时，进度提示里不许凭空出现「计划」
  {
    await runTurn(
      [
        { toolCalls: [{ id: 'z1', name: 'read_file', args: { path: 'work/a.txt' } }] },
        { content: '完成' },
      ],
      { costRunId: 'run-plan-noplan', limits: { progressEvery: 1 } }
    );
    const notes = notesIn(lastSeen[1]);
    check('[D] 没写过计划时进度提示里没有「计划」段（零痕迹）', notes.length === 1 && !/计划（共/.test(String(notes[0].content)), String(notes[0] && notes[0].content).slice(0, 90));
    check('[D] 也不该凭空造出 plan 文件', fs.existsSync(planLib.planFile(root, 'run-plan-noplan')) === false);
  }

  // ==================== E. 计划卡（界面可见性）====================
  console.log('\n== E. 计划卡增量（界面据此渲染）==');
  {
    await runTurn(
      [
        { toolCalls: [{ id: 'k1', name: 'update_plan', args: { items: [{ step: '第一步', status: 'in_progress' }, { step: '第二步', status: 'pending' }] } }] },
        { content: '好' },
      ],
      { costRunId: 'run-plan-ui', limits: { progressEvery: 3 } }
    );
    const plans = lastDeltas.filter((d) => d.kind === 'plan');
    check('[E] 计划一变就发 kind=plan 增量（不必等满 progressEvery 轮）', plans.length === 1, 'plans=' + plans.length + ' deltas=' + lastDeltas.map((d) => d.kind).join(','));
    check('[E] 增量里带结构化清单（界面不用去解析文本）', plans[0] && plans[0].items.length === 2 && plans[0].items[0].step === '第一步' && plans[0].items[0].status === 'in_progress', JSON.stringify(plans[0] && plans[0].items));
    check('[E] 增量里带 updatedAt 与 runId（界面能判断是不是同一份）', !!(plans[0] && plans[0].updatedAt) && plans[0].runId === 'run-plan-ui', JSON.stringify({ updatedAt: plans[0] && plans[0].updatedAt, runId: plans[0] && plans[0].runId }));
    check('[E] 同一次运行里不会重复发同一份计划', new Set(plans.map((d) => d.updatedAt)).size === plans.length);
  }
  {
    // 关键解耦：progressEvery=0（完全不注入进度提示）时，计划卡也必须照发
    await runTurn(
      [
        { toolCalls: [{ id: 'k2', name: 'update_plan', args: { items: [{ step: '只有一步', status: 'in_progress' }] } }] },
        { content: '好' },
      ],
      { costRunId: 'run-plan-ui-zero', limits: { progressEvery: 0 } }
    );
    const plans = lastDeltas.filter((d) => d.kind === 'plan');
    check('[E] progressEvery=0 时进度提示一条都没有（前置事实）', notesIn(lastSeen[1] || { messages: [] }).length === 0);
    check('[E] 但计划卡照样发（与进度注入解耦）', plans.length === 1 && plans[0].items.length === 1, 'plans=' + plans.length);
  }
  {
    // 负向：没有计划就没有 plan 增量
    await runTurn(
      [
        { toolCalls: [{ id: 'k3', name: 'read_file', args: { path: 'work/a.txt' } }] },
        { content: '好' },
      ],
      { costRunId: 'run-plan-ui-none', limits: { progressEvery: 1 } }
    );
    check('[E] 没写过计划 → 一条 plan 增量都没有（零痕迹）', lastDeltas.filter((d) => d.kind === 'plan').length === 0, JSON.stringify(lastDeltas.map((d) => d.kind)));
  }

  // ==================== F. 接线 ====================
  console.log('\n== E. 接线 ==');
  {
    const names = registry().listTools().map((t) => t.name);
    check('[E] update_plan 在默认注册表里（BUILTINS 已接线）', names.includes('update_plan'), 'count=' + names.length);
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.cjs'), 'utf8');
    check('[E] 主循环用同一个读取口径（readRunPlan 接在进度提示里）', /plan:\s*planForNote/.test(src) && /readRunPlan\(/.test(src));
    check('[E] 出厂 progress_every 仍为 3（计划寄生在这条注入上）', agent.loadConfig(root).limits.progressEvery === 3, String(agent.loadConfig(root).limits.progressEvery));
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'AGENT PLAN TEST: PASS' : 'AGENT PLAN TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('AGENT PLAN TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
