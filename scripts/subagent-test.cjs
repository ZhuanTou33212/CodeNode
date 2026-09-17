'use strict';

const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const roles = require('../electron/tools/roles.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');

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

  console.log('subagent role isolation ok');
})().catch((error) => {
  console.error(error);
  process.exit(1); // 显式退出：失败路径上可能还挂着等待取消的子任务 promise，别让用例挂死
});
