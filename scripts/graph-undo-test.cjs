'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'codenode-tsc-test');

function compile() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const res = childProcess.spawnSync(
    'npx',
    ['tsc', 'src/store/graphStore.ts', 'src/lib/flow.ts', 'src/types.ts', '--outDir', OUT, '--module', 'commonjs', '--target', 'es2020', '--esModuleInterop', '--skipLibCheck', '--jsx', 'react-jsx', '--moduleResolution', 'node'],
    { cwd: PROJECT, encoding: 'utf-8', shell: process.platform === 'win32' }
  );
  if (res.status !== 0) {
    console.error(res.stdout || res.stderr);
    throw new Error('graphStore 编译失败');
  }
}
compile();
process.env.NODE_PATH = path.join(PROJECT, 'node_modules');
require('module').Module._initPaths();

const { useGraphStore } = require(path.join(OUT, 'store', 'graphStore.js'));

function reset() {
  useGraphStore.setState({
    nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [],
    selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], flow: {},
  });
}

const mkNode = (id, extra) => ({ id, type: 'task', position: { x: 0, y: 0 }, data: { label: id, status: 'pending', ...extra } });

function main() {
  reset();
  const g = () => useGraphStore.getState();

  // 1. 添加两个节点 + 一条连线
  useGraphStore.getState().addNode(mkNode('n1'));
  useGraphStore.getState().addNode(mkNode('n2'));
  useGraphStore.getState().onConnect({ source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null });
  assert.strictEqual(g().nodes.length, 2);
  assert.strictEqual(g().edges.length, 1);
  assert.strictEqual(g().past.length, 3, 'addNode x2 + connect 应各记一次历史');

  // 2. 删除连线（断连）应可撤销
  useGraphStore.getState().onEdgesChange([{ id: g().edges[0].id, type: 'remove' }]);
  assert.strictEqual(g().edges.length, 0);
  assert.strictEqual(g().past.length, 4, '断连应记入历史');
  useGraphStore.getState().undo();
  assert.strictEqual(g().edges.length, 1, '撤销后连线应恢复');

  // 3. React Flow 删除节点路径：onNodesChange remove 记录历史；deleteNodes 不重复记录
  reset();
  useGraphStore.getState().addNode(mkNode('n1'));
  useGraphStore.getState().addNode(mkNode('n2'));
  const pastBefore = g().past.length;
  useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
  assert.ok(!g().nodes.some((n) => n.id === 'n1'), 'onNodesChange remove 应移除节点');
  assert.strictEqual(g().past.length, pastBefore + 1, 'onNodesChange 删除应记入历史');
  // React Flow 随后调用 onNodesDelete → deleteNodes，节点已不存在 → 不应重复记历史
  useGraphStore.getState().deleteNodes(['n1']);
  assert.strictEqual(g().past.length, pastBefore + 1, '重复删除不应二次记历史');
  useGraphStore.getState().undo();
  assert.ok(g().nodes.some((n) => n.id === 'n1'), '撤销应恢复被删节点');

  // 3b. 删除带连线的节点：随节点连带移除的边不应重复记历史（单步撤销）
  reset();
  useGraphStore.getState().addNode(mkNode('n1'));
  useGraphStore.getState().addNode(mkNode('n2'));
  useGraphStore.getState().onConnect({ source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null });
  const eid = g().edges[0].id;
  const p3b = g().past.length;
  useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
  useGraphStore.getState().onEdgesChange([{ id: eid, type: 'remove' }]);
  assert.strictEqual(g().edges.length, 0);
  assert.strictEqual(g().past.length, p3b + 1, '节点删除+连带边删除应只记一次历史');
  useGraphStore.getState().undo();
  assert.ok(g().nodes.some((n) => n.id === 'n1'), '撤销应同时恢复节点');
  assert.strictEqual(g().edges.length, 1, '撤销应恢复被连带删除的边');

  // 4. 直接调用 deleteNodes（工具栏/X 键路径）：存在才记历史，且彻底清理 members/选中
  reset();
  useGraphStore.getState().addNode({ id: 'scope', type: 'scope', position: { x: 0, y: 0 }, data: { label: 'scope', status: 'pending', members: ['child1', 'child2'] } });
  useGraphStore.getState().addNode(mkNode('child1'));
  useGraphStore.getState().setSelectedIds(['child1']);
  useGraphStore.getState().setAltDrag(['child1']);
  const pBefore = g().past.length;
  useGraphStore.getState().deleteNodes(['child1']);
  assert.ok(!g().nodes.some((n) => n.id === 'child1'));
  assert.strictEqual(g().selectedIds.length, 0, '删除后应清理选中');
  assert.strictEqual(g().altDragIds.length, 0, '删除后应清理 altDrag');
  const scope = g().nodes.find((n) => n.id === 'scope');
  assert.ok(!scope.data.members.includes('child1'), '容器 members 应同步移除');
  assert.strictEqual(g().past.length, pBefore + 1, '存在节点时删除应记历史');
  useGraphStore.getState().undo();
  assert.ok(g().nodes.some((n) => n.id === 'child1'), '撤销应恢复节点');
  assert.ok(g().nodes.find((n) => n.id === 'scope').data.members.includes('child1'), '撤销应恢复 members');

  // 5. commit 去重：重复 commit 相同状态不叠加历史
  reset();
  useGraphStore.getState().addNode(mkNode('n1'));
  const c1 = g().past.length;
  useGraphStore.getState().commit();
  useGraphStore.getState().commit();
  useGraphStore.getState().commit();
  assert.strictEqual(g().past.length, c1 + 1, '相同快照的连续 commit 应去重');

  // 6. 移动（拖拽）可撤销：拖前 commit → 拖后 undo 回原位
  reset();
  useGraphStore.getState().addNode(mkNode('n1'));
  useGraphStore.getState().commit(); // onNodeDragStart
  useGraphStore.getState().moveNode('n1', { x: 500, y: 500 });
  assert.deepStrictEqual(g().nodes.find((n) => n.id === 'n1').position, { x: 500, y: 500 });
  useGraphStore.getState().undo();
  assert.deepStrictEqual(g().nodes.find((n) => n.id === 'n1').position, { x: 0, y: 0 }, '移动应可撤销');

  // 7. 编辑（Inspector onFocus commit → updateNodeData）可撤销
  reset();
  useGraphStore.getState().addNode(mkNode('n1', { label: '旧名' }));
  useGraphStore.getState().commit(); // onFocus beginEdit
  useGraphStore.getState().updateNodeData('n1', { label: '新名' });
  assert.strictEqual(g().nodes.find((n) => n.id === 'n1').data.label, '新名');
  useGraphStore.getState().undo();
  assert.strictEqual(g().nodes.find((n) => n.id === 'n1').data.label, '旧名', '编辑应可撤销');

  // 8. 加载遗留 agent/user 节点应被剥离（已废弃类型完全移除）
  reset();
  useGraphStore.getState().load(
    [
      { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { label: '旧Agent' } },
      { id: 'u1', type: 'user', position: { x: 0, y: 0 }, data: { label: '旧User' } },
      mkNode('t1'),
    ],
    [{ id: 'e1', source: 'a1', target: 't1' }]
  );
  assert.ok(!g().nodes.some((n) => n.type === 'agent' || n.type === 'user'), '遗留 agent/user 节点加载时应剥离');
  assert.ok(g().nodes.some((n) => n.id === 't1'), '正常节点应保留');
  assert.strictEqual(g().edges.length, 0, '指向被剥离节点的边应清理');

  console.log('GRAPH STORE UNDO TEST: PASS');
}

main();
