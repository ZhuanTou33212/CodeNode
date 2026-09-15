/**
 * context-capability-test.cjs —— 工具执行上下文的能力面（审查第 2 项）
 *
 * 目标：工具不再拿到「巨大的 AgentToolContext 全部能力」，而是按自己的契约（requiredCapability）
 * 现场组装的最小能力面；越权的特权方法返回安全默认值并写 `capability-denied` 审计；
 * 旧方法（context.projectRoot()/confirm()/mutateWorkbench() …）作为 deprecated 转发保留，
 * 24 个既有工具不改一行也能继续跑（双轨并存）。
 *
 * 判据落在真实终态：底层上下文有没有被真的调用、模型有没有真的被改、审计里有没有拒绝记录、
 * 以及主循环里 exec.toolCallId 是否与 assistant 声明的 id 一致。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExecutionContext } = require('../electron/tools/executionContext.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const descriptorLib = require('../electron/tools/descriptor.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const agent = require('../electron/agent.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-capability-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

/**
 * 记录调用的假底层上下文
 * @param {any} [overrides]
 * @returns {any}
 */
function makeStubBase(overrides = {}) {
  const calls = [];
  /** @type {any} */
  const base = {
    auditLog: [],
    projectRoot: () => root,
    model: () => null,
    runId: () => 'run-x',
    taskId: () => 'task-x',
    role: () => 'supervisor',
    readOnly: () => false,
    signal: () => null,
    cancelled: () => false,
    confirm: async (level, what) => { calls.push(['confirm', level, what]); return true; },
    askUser: async (q) => { calls.push(['askUser', q]); return 'ans'; },
    audit: (entry) => { base.auditLog.push(String(entry)); },
    mutateWorkbench: async (fn) => { calls.push(['mutateWorkbench']); if (fn) fn({ tag: 'model' }); return true; },
    saveProject: async () => { calls.push(['saveProject']); return path.join(root, 'workflow.cnode'); },
    saveError: () => null,
    ui: async (action) => { calls.push(['ui', action]); return true; },
    notifyFileChange: (rel, kind) => { calls.push(['notifyFileChange', rel, kind]); },
    conversationHistory: () => [],
    ragConfig: () => ({ enabled: false }),
    scalars: () => ({ setMany: () => 0 }),
    storeScalars: (records) => { calls.push(['storeScalars', records.length]); return records.length; },
    queryScalars: () => [{ key: 'k' }],
    checkpoint: (type) => { calls.push(['checkpoint', type]); return {}; },
    checkpointMessages: () => ({}),
    beginSideEffect: async () => ({ skip: false }),
    commitSideEffect: async () => {},
    failSideEffect: async () => {},
    undo: async () => { calls.push(['undo']); return true; },
    redo: async () => { calls.push(['redo']); return true; },
    sandbox: () => policy,
    notifyState: () => {},
    setStateNotifier: () => null,
    fork: (o) => { calls.push(['fork']); return { ...base, ...(o || {}) }; },
    ...overrides,
  };
  base.calls = calls;
  return base;
}

function descriptorFor(name, capability) {
  return descriptorLib.normalizeDescriptor({ name, requiredCapability: capability, explicit: true });
}

(async () => {
  // ======================= A. 能力面组装（纯函数） =======================
  {
    const base = makeStubBase();
    const ctx = createExecutionContext(base, descriptorFor('read_file', 'workspace.read'), { turnId: 3, toolCallId: 'call_7' });
    check('A1 exec 带回 runId/turnId/toolCallId/attemptId/工具名/角色',
      ctx.exec.runId === 'run-x' && ctx.exec.turnId === '3' && ctx.exec.toolCallId === 'call_7' &&
      ctx.exec.attemptId === 'call_7#1' && ctx.exec.tool === 'read_file' && ctx.exec.role === 'supervisor',
      JSON.stringify(ctx.exec.describe()));
    check('A2 能力蕴含：workspace.write 蕴含 workspace.read，project.save 蕴含 write',
      JSON.stringify(descriptorLib.CAPABILITIES.includes('workspace.read')) &&
      JSON.stringify(createExecutionContext(base, descriptorFor('save_project', 'project.save')).exec.capabilities) ===
        JSON.stringify(['project.save', 'workspace.read', 'workspace.write']),
      JSON.stringify(createExecutionContext(base, descriptorFor('save_project', 'project.save')).exec.capabilities));
    check('A3 七个面都在（exec/project/approval/audit/ui/checkpoint/cancel/trace）',
      ['exec', 'project', 'approval', 'audit', 'ui', 'checkpoint', 'cancel', 'trace'].every((k) => !!ctx[k]));

    // 读面工具：读相关可用
    check('A4 读面工具能用标量索引（派生数据）与查询',
      ctx.project.scalars() !== null && Array.isArray(ctx.project.queryScalars({})) && ctx.project.storeScalars([{ key: 'a' }]) === 1);
    // 读面工具：写/界面/沙箱/派生面被拒，且每次拒绝都留审计
    const deniedMutations = [
      ['mutateWorkbench 被拒', ctx.mutateWorkbench(() => {}) === false],
      ['notifyFileChange 被拒', ctx.notifyFileChange('a.txt', 'modify') === null],
      ['undo 被拒', ctx.undo() === false],
      ['sandbox 被拒', ctx.sandbox() === null],
      ['ui 被拒', (await ctx.ui('focus')) === false],
      ['askUser 被拒', ctx.askUser('q') === ''],
      ['fork 被拒', ctx.fork() === null],
      ['新面 project.save 被拒（严格）', await ctx.project.save() === null],
    ];
    check('A5 读面工具的越权特权方法全部返回安全默认值', deniedMutations.every(([, ok]) => ok), JSON.stringify(deniedMutations));
    const deniedAudits = base.auditLog.filter((e) => e.includes('capability-denied'));
    check('A6 每次拒绝都写了 capability-denied 审计（可观测，不是静默）',
      deniedAudits.length >= 7 && deniedAudits.every((e) => e.includes('"tool":"read_file"')), 'deniedAudits=' + deniedAudits.length);
    check('A7 拒绝没有真的调用底层（mutateWorkbench/saveProject/ui 计数为 0）',
      !base.calls.some((c) => ['mutateWorkbench', 'saveProject', 'ui', 'fork'].includes(c[0])), JSON.stringify(base.calls));

    // 写面工具：写可用，界面/沙箱/派生仍被拒；新面 save 仍严格
    const wbase = makeStubBase();
    const wctx = createExecutionContext(wbase, descriptorFor('write_file', 'workspace.write'));
    let mutated = null;
    const okMutate = await wctx.mutateWorkbench((m) => { mutated = m.tag; });
    check('A8 写面工具可以真的改模型（mutateWorkbench 透传到底层）', okMutate === true && mutated === 'model');
    wctx.notifyFileChange('a.txt', 'modify');
    check('A9 写面工具可以通知文件变更与撤销/重做', wbase.calls.some((c) => c[0] === 'notifyFileChange') && (await wctx.redo()) === true);
    check('A10 写面工具仍拿不到界面/沙箱/subagent 面',
      (await wctx.ui('focus')) === false && wctx.sandbox() === null && wctx.fork() === null,
      JSON.stringify({ ui: await wctx.ui('focus'), sandbox: wctx.sandbox(), fork: wctx.fork() }));
    check('A11 写面工具用「新面 save」仍被拒（工程保存严格归 project.save）', (await wctx.project.save()) === null);

    // shell / ui / delegate 面各自的解锁
    const sctx = createExecutionContext(makeStubBase(), descriptorFor('execute_shell', 'shell.execute'));
    check('A12 shell.execute 解锁 sandbox（并蕴含写面）', sctx.sandbox() !== null && sctx.exec.capabilities.includes('workspace.write'));
    const uctx = createExecutionContext(makeStubBase(), descriptorFor('ui_control', 'ui.interact'));
    check('A13 ui.interact 解锁 ui.action 与 askUser', (await uctx.ui.action('focus')) === true && (await uctx.askUser('q')) === 'ans');
    const dctx = createExecutionContext(makeStubBase(), descriptorFor('delegate_task', 'subagent.delegate'));
    check('A14 subagent.delegate 解锁 fork', dctx.fork({ role: 'explorer' }) !== null);

    // 取消面
    const abortBase = makeStubBase({ cancelled: () => true });
    const actx = createExecutionContext(abortBase, descriptorFor('read_file', 'workspace.read'));
    let threw = null;
    try { actx.cancel.throwIfCancelled(); } catch (e) { threw = e && e.code; }
    check('A15 cancel.throwIfCancelled 在已取消时抛 CANCELLED（工具可据此提前退出）', threw === 'CANCELLED' && actx.cancel.isCancelled() === true);

    // 套娃解包
    const nested = createExecutionContext(ctx, descriptorFor('write_file', 'workspace.write'), { toolCallId: 'call_9' });
    check('A16 对已包装的上下文再包装会解包到底层（子代理/内部调用不会套娃丢能力）',
      nested.__context === base && nested.exec.runId === 'run-x' && nested.exec.toolCallId === 'call_9');
  }

  // ======================= B. 注册表集成 =======================
  {
    const registry = new AgentToolRegistry();
    const base = makeStubBase();
    /** @type {any} */
    let seen = null;
    registry.registerDescriptor(
      { name: 'probe_read', description: '读面探针', inputSchema: { type: 'object', properties: {} }, requiredCapability: 'workspace.read' },
      async (ctx) => { seen = ctx; return AgentToolResult.ok('read-ok'); }
    );
    const res = await registry.execute('probe_read', {}, base, { turnId: 2, toolCallId: 'call_abc' });
    check('B1 注册表把组装好的能力面交给工具（exec 标识来自 callInfo）',
      res.ok === true && !!seen && seen.exec.turnId === '2' && seen.exec.toolCallId === 'call_abc' && seen.exec.tool === 'probe_read',
      JSON.stringify(seen && seen.exec.describe()));
    check('B2 工具拿到的是能力面而不是裸上下文（__context 指回底层）', seen.__context === base);
    check('B3 读面探针的写方法被闸住且底层未被调用',
      (await seen.mutateWorkbench(() => {})) === false && !base.calls.some((c) => c[0] === 'mutateWorkbench'));

    // 可调用对象：audit / checkpoint / ui 三个重名面既能旧调用也能走新面
    const hbase = makeStubBase();
    const hctx = createExecutionContext(hbase, descriptorFor('read_file', 'workspace.read'));
    hctx.audit('旧式审计');
    hctx.audit.log({ kind: 'new-audit' });
    hctx.checkpoint('tool_intent', { a: 1 });
    hctx.checkpoint.toolIntent({ b: 2 });
    hctx.checkpoint.messages([], 'round');
    check('A17 重名面做成可调用对象：旧调用与 .方法 都能用',
      hbase.auditLog.includes('旧式审计') && hbase.auditLog.some((e) => e.includes('new-audit')) &&
      hbase.calls.filter((c) => c[0] === 'checkpoint').length === 2,
      JSON.stringify({ audits: hbase.auditLog.length, checkpoints: hbase.calls.filter((c) => c[0] === 'checkpoint').length }));

    // 真实工具回归：read_file（读面）与 workbench_edit（写面）在能力面下都能正常工作
    const realModel = new GraphModel();
    const realContext = new AgentToolContext({
      projectRoot: root,
      model: realModel,
      sandbox: policy,
      confirm: async () => true,
      audit: () => {},
      mutateWorkbench: async (fn) => { fn(realModel); return true; },
    });
    const realRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
    const readRes = await realRegistry.execute('read_file', { path: 'a.txt' }, realContext, { turnId: 0, toolCallId: 'call_r' });
    check('B4 真实读工具（read_file）在能力面下照常工作', readRes.ok === true && /CONTENT-A/.test(String(readRes.text)), String(readRes.text).slice(0, 40));
    const before = JSON.stringify(realModel.doc);
    const writeRes = await realRegistry.execute('workbench_edit', { operations: [{ action: 'create', name: 'cap-probe', type: 'task' }] }, realContext, { turnId: 0, toolCallId: 'call_w' });
    check('B5 真实写工具（workbench_edit）在能力面下仍能改画布（旧方法转发有效）',
      writeRes.ok === true && JSON.stringify(realModel.doc) !== before, JSON.stringify({ ok: writeRes.ok, changed: JSON.stringify(realModel.doc) !== before, text: String(writeRes.text).slice(0, 60) }));
  }

  // ======================= C. 主循环端到端：标识贯通 =======================
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['ctx_probe'],
    });
    const captured = [];
    registry.registerDescriptor(
      { name: 'ctx_probe', description: '捕获执行标识', inputSchema: { type: 'object', properties: {} }, requiredCapability: 'workspace.read' },
      async (ctx) => { captured.push(ctx.exec.describe()); return AgentToolResult.ok('probe'); }
    );
    const controller = new AbortController();
    const context = new AgentToolContext({
      projectRoot: root, model: null, sandbox: policy, confirm: async () => true, audit: () => {},
      signal: controller.signal,
    });
    const stub = installScriptedModel([
      { toolCalls: [{ name: 'ctx_probe', args: {}, omitId: true }] },
      { content: '完成。' },
    ], { loopLast: false });
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: {
          apiBase: 'http://scripted.local/v1', apiKey: 'scripted', model: 'scripted-model', maxTokens: 512,
          reasoningEffort: '', reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
          limits: { maxTotalTokens: 100000, maxConcurrentRuns: 1 }, compression: { enabled: false },
          rag: { enabled: false }, tools: {},
        },
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'probe' }],
        tools: { registry, context },
        signal: controller.signal,
        onDelta: () => {},
      });
    } finally {
      stub.restore();
    }
    const declaredId = stub.seen[1].messages.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0].id;
    check('C1 主循环把 turnId/toolCallId 传进工具，且 toolCallId 与 assistant 声明的 id 一致',
      captured.length === 1 && captured[0].toolCallId === declaredId && captured[0].turnId === '0',
      JSON.stringify({ captured, declaredId }));
    check('C2 attemptId 与 runId 也一并可用', captured[0].attemptId === declaredId + '#1' && typeof captured[0].runId === 'string');
    check('C3 工具照常执行成功（能力面不影响正常链路）', result && Array.isArray(result.toolCalls) && result.toolCalls.every((t) => t.ok === true));
  }

  console.log(failures === 0 ? 'CONTEXT CAPABILITY TEST: PASS' : 'CONTEXT CAPABILITY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('CONTEXT CAPABILITY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
