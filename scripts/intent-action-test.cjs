/**
 * intent-action-test.cjs —— 动作级意图复核（A2）+ 插话后重判（A1）的判据
 *
 * 为什么必须单独一层：轮级判定只看得见「用户说了什么」与「assistant 自述过什么」。
 * 真机取证把盲区点出来了 —— assistant **没说出来的**越权动作根本不在输入里。
 * 所以副作用动作要在**执行前**再判一次（证据包里多一个 `<planned_action>`），
 * 而「用户在同一轮里又说了话」（`<user_followup>`）是唯一能把授权提升回来的**可信证据**。
 *
 * 判据分三块：
 *   A. 证据包：action / steers 真的进了分类输入，且各自带可信度标注、各自有界；
 *   B. 分类器：动作级与轮级**独立计数**（预算互不吃掉）、`off` 开关不消耗预算；
 *   C. registry 门 1.5：收紧 → 本不需要确认的写工具也要走审批；不收紧 / 未接线 / 只读 /
 *      复核抛错 → 逐字节维持原行为（只收紧，绝不放宽）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const intent = require('../electron/intent.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const bodyOf = (input) => intent.buildClassifierMessages(input)[1].content;

(async () => {
  // ======================= A. 证据包（action / steers） =======================
  console.log('== A. 动作级复核的证据包 ==');
  {
    const withBoth = bodyOf({
      prompt: '把 README 的标题改一下',
      history: [],
      canvasSummary: '[]',
      steers: ['就按这个改，我确认了'],
      action: { tool: 'edit_file', detail: '{"path":"README.md"}' },
    });
    check(
      '[A] 带 <planned_action>，且标注为不可信证据（assistant 不能自我授权）',
      /<planned_action[^>]*不可信/.test(withBoth) && withBoth.includes('edit_file'),
      withBoth.slice(withBoth.indexOf('<planned_action'), withBoth.indexOf('<planned_action') + 120),
    );
    check(
      '[A] 带 <user_followup>，且标注为可信证据（可提升/收窄授权）',
      /<user_followup[^>]*可信/.test(withBoth) && withBoth.includes('就按这个改，我确认了'),
    );
    check('[A] 没有插话时不出现空的 <user_followup>（不留空壳）', !bodyOf({ prompt: 'x' }).includes('<user_followup'));
    check('[A] 没有动作时不出现 <planned_action>', !bodyOf({ prompt: 'x' }).includes('<planned_action'));
    check(
      '[A] 动作描述被截断（不会把整个文件内容塞进分类请求）',
      bodyOf({ prompt: 'x', action: { tool: 'edit_file', detail: 'y'.repeat(3000) } }).length < 4000,
    );
    const manySteers = bodyOf({ prompt: 'x', steers: Array.from({ length: 9 }, (_, i) => 'steer' + i) });
    check(
      '[A] 插话条数有上限（上下文有界）',
      (manySteers.match(/- steer\d/g) || []).length === intent.STEER_MESSAGES,
      String((manySteers.match(/- steer\d/g) || []).length),
    );
    check(
      '[A] 指令里写明「动作级复核」的判定口径（不是凭印象）',
      intent.CLASSIFIER_INSTRUCTIONS.includes('动作级复核') && intent.CLASSIFIER_INSTRUCTIONS.includes('<planned_action>'),
    );
  }

  // ======================= B. 分类器：独立计数与开关 =======================
  console.log('\n== B. 动作级 vs 轮级（预算/开关）==');
  {
    const defCfg = intent.parseIntentConfig({});
    check(
      '[B] 出厂默认：动作复核 risky + 独立上限 ' + intent.DEFAULT_ACTION_MAX_CALLS_PER_RUN,
      defCfg.actionReview === 'risky' && defCfg.actionMaxCallsPerRun === intent.DEFAULT_ACTION_MAX_CALLS_PER_RUN,
      JSON.stringify(defCfg),
    );
    check(
      '[B] 配置口径：off | risky | every，非法值回落 risky',
      intent.parseIntentConfig({ 'agent.intent_action_review': 'every' }).actionReview === 'every' &&
        intent.parseIntentConfig({ 'agent.intent_action_review': 'off' }).actionReview === 'off' &&
        intent.parseIntentConfig({ 'agent.intent_action_review': '乱写' }).actionReview === 'risky',
    );

    const cfg = intent.parseIntentConfig({
      'agent.intent_recognition': 'always',
      'agent.intent_max_calls_per_run': '2',
      'agent.intent_action_max_calls_per_run': '1',
    });
    const json = JSON.stringify({ intent: 'code', risk: 'low', authorization: 'high', confidence: 0.9 });
    const c = intent.createIntentClassifier({ cfg, callModel: async () => json });

    const turn1 = await c.classify({ prompt: '轮级一', history: [], canvasSummary: '[]' });
    const action1 = await c.classify({ prompt: 'x', action: { tool: 'edit_file' } }, { scope: 'action' });
    check(
      '[B] 动作级与轮级分开计数（互不顶替）',
      turn1.source === 'model' && action1.source === 'model' && c.stats().calls === 1 && c.stats().actionCalls === 1,
      JSON.stringify(c.stats()),
    );
    const action2 = await c.classify({ prompt: 'x', action: { tool: 'execute_shell', detail: 'rm -rf /tmp/x' } }, { scope: 'action' });
    check(
      '[B] 动作级上限用尽 → 判「没有信号」（不是「不收紧」，更不是放行）',
      action2.source === 'unavailable' && c.stats().actionCalls === 1,
      JSON.stringify({ source: action2.source, stats: c.stats() }),
    );
    const turn2 = await c.classify({ prompt: '轮级二', history: [], canvasSummary: '[]' });
    check('[B] 动作级消耗不影响轮级预算', turn2.source === 'model', JSON.stringify(c.stats()));

    check(
      '[B] 重判只在**有信号**时才允许替换判定（unavailable 保持原判定 → 重判失败绝不放宽）',
      intent.canReplacePolicy({ source: 'model' }) === true &&
        intent.canReplacePolicy({ source: 'partial' }) === true &&
        intent.canReplacePolicy({ source: 'invalid' }) === true &&
        intent.canReplacePolicy({ source: 'unavailable' }) === false &&
        intent.canReplacePolicy(null) === false &&
        intent.canReplacePolicy({}) === false,
    );

    let offCalls = 0;
    const offClassifier = intent.createIntentClassifier({
      cfg: intent.parseIntentConfig({ 'agent.intent_action_review': 'off' }),
      callModel: async () => {
        offCalls += 1;
        return json;
      },
    });
    const offVerdict = await offClassifier.classify({ prompt: 'x', action: { tool: 'edit_file' } }, { scope: 'action' });
    check(
      '[B] actionReview=off → 一次调用都不发、不消耗预算（与没接线等价）',
      offCalls === 0 && offVerdict.source === 'unavailable' && offClassifier.stats().actionCalls === 0,
      JSON.stringify({ offCalls, source: offVerdict.source, stats: offClassifier.stats() }),
    );
    check(
      '[B] 关闭态下策略不收紧（逐字节回到旧行为）',
      intent.createIntentPolicy(offVerdict).tighten === false && offVerdict.risk === 'unknown',
    );
  }

  // ======================= C. registry 门 1.5 =======================
  console.log('\n== C. registry 门 1.5（只收紧）==');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-action-'));
  const makeRegistry = (executed) => {
    const registry = new AgentToolRegistry({});
    registry.registerDescriptor(
      {
        name: 'fake_write',
        description: '假写工具（测试用）',
        inputSchema: { type: 'object', properties: {} },
        mutatesWorkspace: true,
        // 能力面按其授予：不声明写能力时它连复核都没有（与真实 legacy 写工具一致 —— 它们合成出 shell.execute）
        requiredCapability: 'workspace.write',
      },
      async () => {
        executed.count += 1;
        return AgentToolResult.ok('已执行');
      },
    );
    registry.registerDescriptor(
      {
        name: 'fake_read',
        description: '假只读工具（测试用）',
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
        mutatesWorkspace: false,
      },
      async () => {
        executed.count += 1;
        return AgentToolResult.ok('已读');
      },
    );
    return registry;
  };

  {
    const executed = { count: 0 };
    let reviewed = 0;
    let sawTool = null;
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({
      projectRoot: root,
      intentReview: async (action) => {
        reviewed += 1;
        sawTool = action && action.tool;
        return { tighten: true };
      },
    });
    const res = await registry.execute('fake_write', {}, ctx);
    check(
      '[C] 收紧 → 本不需要确认的写工具也要走审批（无审批通道 → APPROVAL_REQUIRED）',
      res.ok === false && res.data && res.data.code === 'APPROVAL_REQUIRED',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code }),
    );
    check('[C] 收紧时工具**没有被执行**（审批在副作用之前）', executed.count === 0, String(executed.count));
    check('[C] 复核被调用一次且带上工具名（判定有据可依）', reviewed === 1 && sawTool === 'fake_write', JSON.stringify({ reviewed, sawTool }));
  }

  {
    const executed = { count: 0 };
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({ projectRoot: root, intentReview: async () => ({ tighten: false }) });
    const res = await registry.execute('fake_write', {}, ctx);
    check('[C] 不收紧 → 照常执行（与没有这个功能一致）', res.ok === true && executed.count === 1, JSON.stringify({ ok: res.ok, executed: executed.count }));
  }

  {
    const executed = { count: 0 };
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({ projectRoot: root });
    const res = await registry.execute('fake_write', {}, ctx);
    check('[C] 未接线（没有 intentReview）→ 照常执行、不做复核', res.ok === true && executed.count === 1);
  }

  {
    const executed = { count: 0 };
    let reviewed = 0;
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({
      projectRoot: root,
      intentReview: async () => {
        reviewed += 1;
        return { tighten: true };
      },
    });
    const res = await registry.execute('fake_read', {}, ctx);
    check(
      '[C] 只读工具不触发复核（收紧也不改变只读路径）',
      res.ok === true && reviewed === 0 && executed.count === 1,
      JSON.stringify({ reviewed, executed: executed.count }),
    );
  }

  {
    const executed = { count: 0 };
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({
      projectRoot: root,
      intentReview: async () => {
        throw new Error('分类器炸了');
      },
    });
    const res = await registry.execute('fake_write', {}, ctx);
    check('[C] 复核抛错 → 吞掉且不收紧（不能成为执行的故障点）', res.ok === true && executed.count === 1, JSON.stringify({ ok: res.ok, executed: executed.count }));
  }

  {
    const executed = { count: 0 };
    const registry = makeRegistry(executed);
    const ctx = new AgentToolContext({ projectRoot: root, intentReview: async () => null });
    const res = await registry.execute('fake_write', {}, ctx);
    check('[C] 复核返回 null → 维持原判定', res.ok === true && executed.count === 1);
  }

  // ======================= D. 接线（防「实现了但没接线」） =======================
  console.log('\n== D. 接线静态断言 ==');
  {
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    const regSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'registry.cjs'), 'utf8');
    check('[D] ipc 把 intentReview 注入 run 级上下文', /^\s*intentReview,\s*$/m.test(ipcSrc));
    check('[D] ipc 的复核实现走动作级 scope', ipcSrc.includes("scope: 'action'"));
    check('[D] 复核只用 tighten===true 判定（不读其它字段做放行）', regSrc.includes('intentTighten = !!(review && review.tighten === true)'));
    check('[D] 门 3 把收紧当成「需要审批」（只增不减）', regSrc.includes('intentTighten === true ||'));
    check(
      '[D] 插话既进 steers 又触发轮级重判（否则用户授权不生效）',
      ipcSrc.includes('queueEntry.steers.push') && ipcSrc.includes("refreshIntentPolicy('steer')"),
    );
    check(
      '[D] 重判用纯函数 canReplacePolicy 把关（没有信号绝不替换 → 不放宽）',
      ipcSrc.includes('intentLib.canReplacePolicy(verdict)'),
    );
    check('[D] 重判后就地替换 run 上下文的 policy（riskGate 每次读它 → 立即生效）', ipcSrc.includes('runContext.intentPolicyValue = next'));
    check('[D] 动作级复核落 run 事件（可回放/审计）', ipcSrc.includes("'intent_action_review'"));
  }

  console.log('\n' + (failures === 0 ? 'INTENT ACTION TEST: PASS' : 'INTENT ACTION TEST: FAIL (' + failures + ')'));
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('INTENT ACTION TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
