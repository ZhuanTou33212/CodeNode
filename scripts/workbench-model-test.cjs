'use strict';

/**
 * workbench_edit 建模能力回归测试：
 * - create 支持自定义 id（同批连线/包裹）
 * - 单批 create + connect 把 start 连线到链路开头、end 连线到链路结尾
 * - scope 支持 create 时 members 初值、add_members/set_members/remove_members
 * - 删除节点时自动清理 scope members 残留引用
 */
const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');

const model = new GraphModel({ root: { nodes: [], edges: [] } });
const ctx = new AgentToolContext({
  projectRoot: null,
  model,
  mutateWorkbench: async (fn) => { fn(model); return true; },
});
const reg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });

const exec = (args) => reg.execute('workbench_edit', args, ctx);

async function main() {
  // 1. 自定义 id + 单批连线（start→...→end）
  const r = await exec({
    operations: [
      { action: 'create', id: 'start-1', name: '开始', type: 'start' },
      { action: 'create', id: 't1', name: '任务1', type: 'task' },
      { action: 'create', id: 'end-1', name: '结束', type: 'end' },
      { action: 'connect', sourceId: 'start-1', targetId: 't1' },
      { action: 'connect', sourceId: 't1', targetId: 'end-1' },
    ],
  });
  assert.strictEqual(r.ok, true, r.text);
  assert.ok(model.byId('start-1'), '自定义 id start-1 应创建成功');
  assert.ok(model.byId('end-1'), '自定义 id end-1 应创建成功');
  assert.ok(model.edges().some((e) => e.source === 'start-1' && e.target === 't1'), 'start 应连线到链路第一个节点');
  assert.ok(model.edges().some((e) => e.source === 't1' && e.target === 'end-1'), '最后一个节点应连线到 end');

  // 2. scope create 时带 members
  const s = await exec({
    operations: [
      { action: 'create', id: 'cond', name: '条件循环', type: 'scope', members: ['t1'] },
    ],
  });
  assert.strictEqual(s.ok, true, s.text);
  assert.deepStrictEqual(model.byId('cond').data.members, ['t1'], 'create scope 应带初始 members');

  // 3. add_members / set_members / remove_members
  await exec({ action: 'create', id: 't2', name: '任务2', type: 'task' });
  await exec({ action: 'add_members', nodeId: 'cond', memberIds: ['t2'] });
  assert.deepStrictEqual(model.byId('cond').data.members.sort(), ['t1', 't2'], 'add_members 应追加成员');
  await exec({ action: 'set_members', nodeId: 'cond', memberIds: ['t2'] });
  assert.deepStrictEqual(model.byId('cond').data.members, ['t2'], 'set_members 应整体替换');
  await exec({ action: 'remove_members', nodeId: 'cond', memberIds: ['t2'] });
  assert.deepStrictEqual(model.byId('cond').data.members, [], 'remove_members 应移除成员');

  // 4. 非法：非 scope 节点不能加成员
  const bad = await exec({ action: 'add_members', nodeId: 't1', memberIds: ['t2'] });
  assert.ok(!bad.ok || bad.data.errors, '非 scope 节点加成员应报错');

  // 5. 删除成员节点 → 自动清理 scope members 残留
  await exec({ action: 'create', id: 'cond2', name: '范围2', type: 'scope', members: ['t1', 't2'] });
  await exec({ action: 'delete', nodeId: 't1' });
  assert.deepStrictEqual(model.byId('cond2').data.members, ['t2'], '删除节点后应清理 scope members');

  console.log('WORKBENCH MODEL TEST: PASS');
}

main()
  .catch((error) => {
    console.error('WORKBENCH MODEL TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
