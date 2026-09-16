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

  console.log('subagent role isolation ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
