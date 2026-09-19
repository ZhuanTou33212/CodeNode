'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const roles = require('../electron/tools/roles.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { CostLedger } = require('../electron/costLedger.cjs');
const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

/**
 * 判据失败要打印**字面量 FAIL** 并以非零退出 —— 变异测试（out/mutation-check.cjs）
 * 就是靠「输出里出现 FAIL 且 exit≠0」判定「用例真的红了」。用裸 assert 的话失败输出
 * 只有 AssertionError，判据会被当成「红得不在预期位置」。
 */
let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (error) {
    failures += 1;
    console.log('FAIL  ' + label + ' :: ' + (error && error.message ? error.message : error));
  }
}

const buildContext = (model, signal) =>
  new AgentToolContext({
    projectRoot: process.cwd(),
    model,
    confirm: async () => true,
    mutateWorkbench: async (fn) => {
      fn(model);
      return true;
    },
    audit: () => {},
    signal,
  });

const baseCfg = { tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] }, rag: { enabled: true } };

(async () => {
  const builder = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'builder' });
  assert.strictEqual(builder.contains('write_file'), true);
  assert.strictEqual(builder.contains('execute_shell'), false);
  const readOnly = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' });
  assert.strictEqual(readOnly.contains('write_file'), false);
  // 白名单来自角色契约（单一来源，S9）
  assert.deepStrictEqual(builder.listTools().map((t) => t.name).sort(), roles.roleTools('builder').slice().sort());

  const model = new GraphModel({
    root: {
      nodes: [{ id: 'stage-1', type: 'stage', position: { x: 0, y: 0 }, data: { label: '探查', status: 'pending' } }],
      edges: [],
    },
  });
  const controller = new AbortController();
  const context = buildContext(model, controller.signal);
  const supervisor = toolkit.buildDefaultRegistry();
  /** @type {any} */
  let childSignal = null;
  const manager = new SubagentManager({
    agent: {
      runAgentChat: async ({ tools }) => {
        assert.strictEqual(tools.context.role(), 'explorer');
        childSignal = tools.context.signal();
        // S9：子代理拿到的是「组合信号」（父信号 + 任务总时长定时器），不再是父信号本身
        assert.notStrictEqual(childSignal, controller.signal);
        assert.strictEqual(childSignal.aborted, false);
        assert.strictEqual(String(tools.context.taskId()).startsWith('task-'), true);
        assert.strictEqual(tools.registry.contains('write_file'), false);
        return { content: '探查完成', toolCalls: [], usage: null };
      },
    },
    toolkit,
    cfg: baseCfg,
    registry: supervisor,
    runId: 'run-test',
  });
  manager.register(supervisor);
  const result = await supervisor.execute(
    'delegate_task',
    { role: 'explorer', objective: '读取项目结构', stageNodeId: 'stage-1' },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(model.byId('stage-1').data.status, 'done');
  assert.ok(String(model.byId('stage-1').data.result_summary).includes('探查完成'));
  assert.ok(childSignal && childSignal.aborted === false);

  // 父信号 abort 必须传播到子代理（组合信号）
  const parentCtl = new AbortController();
  const propReg = toolkit.buildDefaultRegistry();
  const propManager = new SubagentManager({
    agent: {
      runAgentChat: async ({ tools }) => {
        parentCtl.abort();
        const propagated = /** @type {any} */ (tools.context.signal());
        assert.strictEqual(propagated.aborted, true, '父信号 abort 必须传播到子代理');
        return { content: '已中止', toolCalls: [], usage: null };
      },
    },
    toolkit,
    cfg: baseCfg,
    registry: propReg,
    runId: 'run-propagate',
  });
  propManager.register(propReg);
  await propReg.execute('delegate_task', { role: 'explorer', objective: '观察信号传播' }, buildContext(model, parentCtl.signal));

  // 主 Agent 已取消时不启动子代理
  const cancelled = new AbortController();
  cancelled.abort();
  const cancelReg = toolkit.buildDefaultRegistry();
  const cancelManager = new SubagentManager({
    agent: {
      runAgentChat: async () => {
        throw new Error('主 Agent 已取消时不应调用模型');
      },
    },
    toolkit,
    cfg: baseCfg,
    registry: cancelReg,
    runId: 'run-cancel',
  });
  cancelManager.register(cancelReg);
  const blocked = await cancelReg.execute('delegate_task', { role: 'explorer', objective: '不该执行' }, buildContext(model, cancelled.signal));
  assert.strictEqual(blocked.ok, false);
  assert.ok(String(blocked.text).includes('已取消'));

  // ---- 单任务取消（任务单第 6 项）：只 abort 这一个子任务，不牵连主 Agent 与其它子任务 ----
  {
    const cancelReg = toolkit.buildDefaultRegistry();
    /** @type {any} */
    let hangingTaskId = null;
    let childCalls = 0;
    const waitAbort = (signal) => new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', resolve, { once: true });
    });
    const manager2 = new SubagentManager({
      agent: {
        runAgentChat: async ({ tools }) => {
          childCalls += 1;
          const myTaskId = String(tools.context.taskId());
          if (childCalls === 1) {
            hangingTaskId = myTaskId; // 第一个子任务：挂起等待被取消
            await waitAbort(tools.context.signal());
            return { content: '', toolCalls: [], usage: null, aborted: true };
          }
          await new Promise((resolve) => setTimeout(resolve, 40)); // 第二个：正常跑完
          return { content: '快速完成', toolCalls: [], usage: null };
        },
      },
      toolkit,
      cfg: baseCfg,
      registry: cancelReg,
      runId: 'run-cancel-one',
    });
    manager2.register(cancelReg);
    const parentAbort = new AbortController();
    const batch = cancelReg.execute(
      'delegate_tasks',
      { tasks: [{ role: 'explorer', objective: '挂起的任务' }, { role: 'explorer', objective: '快速的任务' }] },
      buildContext(model, parentAbort.signal),
    );
    for (let i = 0; i < 200 && !hangingTaskId; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(hangingTaskId, '应当能拿到正在运行的子任务 taskId');
    const cancelResult = await cancelReg.execute('cancel_subagent_task', { taskId: hangingTaskId, reason: '测试取消' }, buildContext(model, parentAbort.signal));
    assert.strictEqual(cancelResult.ok, true, '取消应当成功：' + cancelResult.text);
    // 取消不生效时挂起的子任务永不返回 —— 判据必须**有界**：超时即断言失败（否则用例会静默挂死）
    const settled = await Promise.race([batch.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
    assert.strictEqual(settled, 'done', '取消未生效：子任务 5s 内没有返回');
    const tasks = [...manager2.tasks.values()];
    const cancelledTask = tasks.find((task) => task.taskId === hangingTaskId);
    const otherTask = tasks.find((task) => task.taskId !== hangingTaskId);
    assert.strictEqual(cancelledTask.status, 'cancelled', '被取消的任务状态应为 cancelled，实际=' + cancelledTask.status);
    assert.ok(String(cancelledTask.error).includes('主动取消'), '原因要如实：' + cancelledTask.error);
    assert.strictEqual(otherTask.status, 'done', '其它子任务不受影响，实际=' + otherTask.status);
    assert.strictEqual(parentAbort.signal.aborted, false, '主 Agent 的信号不应被取消动作带崩');
    const done = await cancelReg.execute('cancel_subagent_task', { taskId: hangingTaskId }, buildContext(model, parentAbort.signal));
    assert.strictEqual(done.ok, false, '已结束的任务不能再取消');
    assert.ok(String(done.text).includes('已结束'), done.text);
  }

  // ---- #18：模型自选 taskId 不得覆盖已有任务；配额用独立的「曾进入 running」计数器 ----
  {
    const reg = toolkit.buildDefaultRegistry();
    const manager3 = new SubagentManager({
      agent: {
        runAgentChat: async ({ messages }) => {
          const objective = String(((messages || []).find((m) => m.role === 'user') || {}).content || '');
          return { content: '结论：' + objective, toolCalls: [], usage: null };
        },
      },
      toolkit,
      cfg: Object.assign({}, baseCfg, { subagent: { maxTasksPerRun: 2 } }),
      registry: reg,
      runId: 'run-taskid-unique',
    });
    manager3.register(reg);
    const taskIdContext = buildContext(model, new AbortController().signal);

    const firstDup = await reg.execute(
      'delegate_task',
      { taskId: 'shared-id', role: 'explorer', objective: '第一个任务' },
      taskIdContext,
    );
    check('#18 首个自选 taskId 正常启动', () => {
      assert.strictEqual(firstDup.ok, true, String(firstDup.text));
      assert.strictEqual(firstDup.data.taskId, 'shared-id');
    });

    const reused = await reg.execute(
      'delegate_task',
      { taskId: 'shared-id', role: 'explorer', objective: '第二个任务（复用同一个 id）' },
      taskIdContext,
    );
    const lookedUp = await reg.execute('get_subagent_task', { taskId: 'shared-id' }, taskIdContext);
    check('#18 复用已有 taskId 被显式拒绝（不静默覆盖）', () => {
      assert.strictEqual(reused.ok, false, '复用 taskId 必须是失败调用，而不是覆盖已有任务：' + String(reused.text));
      assert.ok(/已被占用/.test(String(reused.text)), String(reused.text));
    });
    check('#18 已有任务没有被顶掉（get_subagent_task 仍返回第一个任务）', () => {
      const stored = manager3.tasks.get('shared-id');
      assert.ok(stored, '原任务必须还在');
      assert.strictEqual(stored.objective, '第一个任务');
      assert.strictEqual(lookedUp.ok, true, String(lookedUp.text));
      assert.strictEqual(lookedUp.data.objective, '第一个任务');
      assert.strictEqual(lookedUp.data.status, 'done');
    });

    const secondStart = await reg.execute('delegate_task', { role: 'explorer', objective: '自动 id 的第二个任务' }, taskIdContext);
    check('#18 配额计数：第 2 个（自动 id）仍可启动', () => {
      assert.strictEqual(secondStart.ok, true, String(secondStart.text));
    });
    const overQuota = await reg.execute('delegate_task', { role: 'explorer', objective: '超过配额的任务' }, taskIdContext);
    check('#18 maxTasksPerRun=2 时第 3 个被拒绝（配额真的生效）', () => {
      assert.strictEqual(overQuota.ok, false, String(overQuota.text));
      assert.ok(/最多执行 2 个子代理任务/.test(String(overQuota.text)), String(overQuota.text));
    });
    check('#18 被拒绝/非法的调用不占配额（只有真正进入 running 的才计数）', () => {
      assert.strictEqual(manager3.startedTaskCount, 2, 'startedTaskCount=' + manager3.startedTaskCount);
    });
    // 旧实现用 this.tasks.size 当配额：任务视图一旦被清理/复用，配额就整体复原。
    // 独立计数器必须与 tasks Map 的增删无关 —— 这是「配额无上界」根因的直接判据。
    manager3.tasks.clear();
    const afterClear = await reg.execute('delegate_task', { role: 'explorer', objective: '清空视图后仍应被配额拦住' }, taskIdContext);
    check('#18 配额不随 tasks 视图被清理而倒退（用独立计数器，不用 tasks.size）', () => {
      assert.strictEqual(afterClear.ok, false, '配额不能因为 tasks 被清理而复原：' + String(afterClear.text));
      assert.ok(/最多执行 2 个子代理任务/.test(String(afterClear.text)), String(afterClear.text));
    });
  }

  // ---- #6：子代理成本只记一次（逐轮 kind=subagent），不是「逐轮 + 汇总」的 2 倍 ----
  {
    const costRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-subagent-cost-'));
    const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: costRoot, userDataDir: os.tmpdir() });
    sandbox.setDefaultPolicy(policy);
    fs.writeFileSync(path.join(costRoot, 'a.txt'), 'HELLO\n');
    const ledger = new CostLedger({ runId: 'run-cost-once', prices: {} });
    const perTurnUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const subagentTurns = 2;
    const costCfg = Object.assign({
      apiBase: 'http://scripted.local/v1', apiKey: '', model: 'scripted', maxTokens: 2048, reasoningEffort: '',
      reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
      limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
      compression: { enabled: false },
      rag: { enabled: false },
      costLedger: ledger,
      costRunId: 'run-cost-once',
    }, { tools: {} });
    const costModel = new GraphModel({ root: { nodes: [], edges: [] } });
    const costContext = new AgentToolContext({
      projectRoot: costRoot,
      model: costModel,
      confirm: async () => true,
      audit: () => {},
      askUser: async () => '',
      sandbox: policy,
      runId: 'run-cost-once',
      signal: new AbortController().signal,
      mutateWorkbench: async (fn) => {
        fn(costModel);
        return true;
      },
    });
    const costReg = toolkit.buildDefaultRegistry();
    const manager4 = new SubagentManager({
      agent: { runAgentChat: agent.runAgentChat },
      toolkit,
      cfg: costCfg,
      registry: costReg,
      runId: 'run-cost-once',
    });
    manager4.register(costReg);

    // 子代理：真实工具循环 2 轮（第 1 轮调 read_file，第 2 轮收尾）→ 2 条记账
    const childStub = installScriptedModel([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }], finishReason: 'tool_calls', usage: perTurnUsage },
      { content: '子代理完成', finishReason: 'stop', usage: perTurnUsage },
    ], { loopLast: false });
    let delegated;
    try {
      delegated = await costReg.execute('delegate_task', { role: 'explorer', objective: '读 a.txt' }, costContext);
    } finally {
      childStub.restore();
    }
    // 主代理：同一本账、同一个 run 的 1 轮
    const mainStub = installScriptedModel([{ content: '主代理完成', finishReason: 'stop', usage: perTurnUsage }], { loopLast: false });
    try {
      await agent.runAgentChat({
        cfg: costCfg,
        messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '测试用任务' }],
        tools: { registry: toolkit.buildDefaultRegistry(), context: costContext },
        signal: new AbortController().signal,
        onDelta: () => {},
      });
    } finally {
      mainStub.restore();
    }

    check('#6 子代理委派成功（成本判据要有真实记账可测）', () => {
      assert.strictEqual(delegated.ok, true, String(delegated.text).slice(0, 200));
      assert.strictEqual(childStub.calls, subagentTurns, '子代理模型轮数=' + childStub.calls);
    });
    const sum = ledger.summary('run-cost-once');
    check('#6 账本总量 = 每轮真实 usage 之和（不是 2 倍）', () => {
      assert.strictEqual(sum.requests, subagentTurns + 1, '记账条数错了（重复记账）：' + JSON.stringify(sum));
      assert.strictEqual(
        sum.totalTokens,
        perTurnUsage.total_tokens * (subagentTurns + 1),
        '总量必须等于主模型 + 子代理逐轮之和：' + JSON.stringify(sum),
      );
    });
    check('#6 子代理逐轮用量归因到 kind=subagent（不污染主模型口径）', () => {
      assert.strictEqual(
        (ledger.byKind.subagent || {}).totalTokens,
        perTurnUsage.total_tokens * subagentTurns,
        JSON.stringify(ledger.byKind),
      );
      assert.strictEqual((ledger.byKind.main || {}).totalTokens, perTurnUsage.total_tokens, JSON.stringify(ledger.byKind));
    });
    fs.rmSync(costRoot, { recursive: true, force: true });
  }

  console.log('subagent role isolation ok');
  console.log(failures === 0 ? 'SUBAGENT TEST: PASS' : 'SUBAGENT TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exit(1); // 显式退出：失败路径上可能还挂着等待取消的子任务 promise，别让用例挂死
});
