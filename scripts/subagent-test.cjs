'use strict';

const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');

(async () => {
  const builder = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'builder' });
  assert.strictEqual(builder.contains('write_file'), true);
  assert.strictEqual(builder.contains('execute_shell'), false);
  const readOnly = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' });
  assert.strictEqual(readOnly.contains('write_file'), false);

  const model = new GraphModel({ root: { nodes: [{ id: 'stage-1', type: 'stage', position: { x: 0, y: 0 }, data: { label: '探查', status: 'pending' } }], edges: [] } });
  const context = new AgentToolContext({
    projectRoot: process.cwd(),
    model,
    confirm: async () => true,
    mutateWorkbench: async (fn) => { fn(model); return true; },
    audit: () => {},
  });
  const supervisor = toolkit.buildDefaultRegistry();
  const manager = new SubagentManager({
    agent: { runAgentChat: async ({ tools }) => {
      assert.strictEqual(tools.context.role(), 'explorer');
      assert.strictEqual(tools.registry.contains('write_file'), false);
      return { content: '探查完成', toolCalls: [], usage: null };
    } },
    toolkit,
    cfg: { tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] }, rag: { enabled: true } },
    registry: supervisor,
    runId: 'run-test',
  });
  manager.register(supervisor);
  const result = await supervisor.execute('delegate_task', {
    role: 'explorer',
    objective: '读取项目结构',
    stageNodeId: 'stage-1',
  }, context);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(model.byId('stage-1').data.status, 'done');
  assert.strictEqual(model.byId('stage-1').data.result_summary, '探查完成');
  console.log('subagent role isolation ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
