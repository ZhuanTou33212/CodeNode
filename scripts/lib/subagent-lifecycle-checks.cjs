'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SubagentManager, readTaskViews, persistTaskView, subagentViewFile } = require('../../electron/subagents.cjs');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const { GraphModel } = require('../../electron/tools/GraphModel.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs');
const checkpoint = require('../../electron/runCheckpoint.cjs');
const runStore = require('../../electron/runStore.cjs');

module.exports = async function lifecycleChecks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-lifecycle-'));
  const model = new GraphModel({ root: { nodes: [], edges: [] } });
  const context = new AgentToolContext({ projectRoot: root, model, confirm: async () => true, audit: () => {} });
  const cfg = { tools: {}, rag: { enabled: false }, subagent: { maxConcurrentTasks: 2 } };
  const make = (runId, runner, override = {}) => {
    const registry = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: { runAgentChat: runner }, toolkit, registry, cfg: { ...cfg, ...override }, runId });
    manager.register(registry);
    return { manager, registry };
  };
  const answer = () => ({ content: '已完成', toolCalls: [], usage: null });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  try {
    let active = 0;
    let peak = 0;
    let writing = false;
    const { manager, registry } = make('shared', async ({ tools }) => {
      const writer = tools.context.role() === 'builder';
      assert.strictEqual(writing, false, '写任务期间不得启动其他任务');
      if (writer) assert.strictEqual(active, 0, '写任务必须独占');
      writing = writer;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      if (writer) writing = false;
      return answer();
    });
    const batch = (prefix) => registry.execute('delegate_tasks', { tasks: [0, 1].map((n) => ({ taskId: prefix + n, role: 'explorer', objective: '检索' })) }, context);
    const outcomes = await Promise.all([
      batch('a'), batch('b'),
      manager.delegate(context, { taskId: 'direct', role: 'explorer', objective: '单独委派' }),
      manager.delegate(context, { taskId: 'writer', role: 'builder', objective: '写任务' }),
    ]);
    assert.ok(outcomes.every((item) => item.ok), '所有任务应成功结算');
    assert.strictEqual(peak, 2, '跨批次和单独委派必须共用上限');
    assert.strictEqual(manager.scheduler.active, 0);
    console.log('PASS  生命周期：跨批次共享并发上限，写任务独占');

    let release = () => {};
    let entered = false;
    const held = make('cancel', async () => {
      entered = true;
      await new Promise((resolve) => { release = () => resolve(null); }); // 故意忽略 abort，直到真实返回。
      return answer();
    }, { subagent: { maxConcurrentTasks: 1 } });
    const first = held.manager.delegate(context, { taskId: 'held', role: 'builder', objective: '等待外部结果' });
    try {
      for (let i = 0; i < 100 && !entered; i++) await tick();
      assert.ok(entered);
      const second = held.manager.delegate(context, { taskId: 'queued', role: 'explorer', objective: '排队任务' });
      const cancelQueued = await held.registry.execute('cancel_subagent_task', { taskId: 'queued' }, context);
      assert.strictEqual(cancelQueued.data.status, 'cancelling');
      const queuedResult = await second;
      assert.strictEqual(queuedResult.data.status, 'cancelled');
      assert.strictEqual(held.manager.startedTaskCount, 1, '排队取消不得调用模型');
      await held.registry.execute('cancel_subagent_task', { taskId: 'held', reason: '用户主动取消' }, context);
      assert.strictEqual(held.manager.tasks.get('held').status, 'cancelling');
      assert.strictEqual(held.manager.scheduler.active, 1, '未退出的执行不得提前释放槽位');
    } finally { release(); }
    const stopped = await first;
    assert.strictEqual(stopped.ok, false, '忽略 abort 后返回成功不得成为 done');
    assert.strictEqual(stopped.data.status, 'cancelled');
    assert.strictEqual(stopped.data.executionSettled, true);
    assert.strictEqual(stopped.data.requiresReview, true, '写任务取消需复核副作用');
    assert.strictEqual(held.manager.scheduler.active, 0);
    console.log('PASS  生命周期：排队可取消，运行取消等待退出，未知写入要求复核');

    const setupError = make('setup-error', async () => { throw new Error('不应进入模型调用'); });
    setupError.manager.updateStage = async () => { throw new Error('模拟准备阶段异常'); };
    const failedSetup = await setupError.manager.delegate(context, { taskId: 'setup', role: 'builder', objective: '准备阶段失败' });
    assert.strictEqual(failedSetup.ok, false);
    assert.strictEqual(setupError.manager.scheduler.active, 0, '准备阶段异常也必须释放槽位');
    assert.strictEqual(readTaskViews(root, 'setup-error').tasks[0].status, 'failed');
    assert.strictEqual(readTaskViews(root, 'setup-error').tasks[0].executionSettled, true);
    console.log('PASS  生命周期：准备阶段异常也进入统一收尾并释放并发槽');

    runStore.startRun(root, 'recover', { prompt: '恢复', model: 'mock' });
    persistTaskView(root, 'recover', { taskId: 'settled', status: 'running', role: 'explorer' });
    checkpoint.appendCheckpoint(root, 'recover', { type: 'subagent_task_settled', taskId: 'settled',
      task: { taskId: 'settled', status: 'done', role: 'explorer', executionSettled: true, requiresReview: false } });
    assert.strictEqual(checkpoint.planResume(root, 'recover').mode, 'auto', '结算事件应覆盖崩溃前的旧 running 视图');
    persistTaskView(root, 'recover', { taskId: 'settled', executionId: 'new-execution', status: 'running', role: 'explorer' });
    assert.strictEqual(checkpoint.planResume(root, 'recover').mode, 'review', '旧 taskId 的结算不能确认新一次执行');
    persistTaskView(root, 'recover', { taskId: 'unknown-write', role: 'builder', status: 'cancelled', executionSettled: true, requiresReview: true });
    assert.strictEqual(checkpoint.planResume(root, 'recover').mode, 'review');
    const file = subagentViewFile(root, 'corrupt');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => persistTaskView(root, 'corrupt', { taskId: 'new', status: 'running' }));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken', '不能用新记录覆盖损坏的恢复证据');
    assert.strictEqual(readTaskViews(root, 'corrupt').ok, false);
    console.log('PASS  生命周期：恢复按结算证据对账，损坏视图保留并拒绝自动恢复');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
