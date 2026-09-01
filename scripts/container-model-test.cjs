'use strict';

/**
 * 范围节点容器化 P0/P3 回归测试：
 * - 旧 members 自动迁移到 childIds 并补全 parentId/memberBadge
 * - addToScope/removeFromScope 维护唯一父
 * - 自动整理后成员仍在父包围盒内
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'codenode-container-model-test');

function compile() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const res = childProcess.spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
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

const mk = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, status: 'pending', ...data } });

function reset() {
  useGraphStore.setState({ nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [], selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], flow: {} });
}

function main() {
  reset();
  // 1. 旧 members 迁移
  useGraphStore.getState().load(
    [mk('scope1', 'scope', { members: ['t1'] }), mk('t1', 'task')],
    []
  );
  let g = useGraphStore.getState();
  let scope = g.nodes.find((n) => n.id === 'scope1');
  let task = g.nodes.find((n) => n.id === 't1');
  assert.deepStrictEqual(scope.data.childIds, ['t1'], 'members 应迁移为 childIds');
  assert.strictEqual(task.data.parentId, 'scope1', '应反向补全 parentId');
  assert.ok(task.data.memberBadge, '应补全 memberBadge');

  // 2. 唯一父：从旧父移到新父
  useGraphStore.getState().load(
    [mk('scope1', 'scope', { childIds: ['t1'] }), mk('scope2', 'scope', { childIds: [] }), mk('t1', 'task')],
    []
  );
  useGraphStore.getState().addToScope('t1', 'scope2');
  g = useGraphStore.getState();
  scope = g.nodes.find((n) => n.id === 'scope1');
  let scope2 = g.nodes.find((n) => n.id === 'scope2');
  task = g.nodes.find((n) => n.id === 't1');
  assert.deepStrictEqual(scope.data.childIds, [], '旧父应移除成员');
  assert.deepStrictEqual(scope2.data.childIds, ['t1'], '新父应添加成员');
  assert.strictEqual(task.data.parentId, 'scope2', 'parentId 应更新');

  // 3. 移除
  useGraphStore.getState().removeFromScope('t1');
  g = useGraphStore.getState();
  scope2 = g.nodes.find((n) => n.id === 'scope2');
  task = g.nodes.find((n) => n.id === 't1');
  assert.deepStrictEqual(scope2.data.childIds, [], '移除后 childIds 为空');
  assert.strictEqual(task.data.parentId, null, '移除后 parentId 为 null');

  // 4. 自动整理后成员仍在父包围盒内
  useGraphStore.getState().load(
    [
      mk('start', 'start'),
      mk('t1', 'task'),
      mk('t2', 'task'),
      mk('end', 'end'),
      mk('scope1', 'scope', { childIds: ['t1', 't2'] }),
    ],
    [
      { id: 'e1', source: 'start', target: 't1' },
      { id: 'e2', source: 't1', target: 't2' },
      { id: 'e3', source: 't2', target: 'end' },
    ]
  );
  useGraphStore.getState().arrangeNodes();
  g = useGraphStore.getState();
  const pos = (id) => g.nodes.find((n) => n.id === id).position;
  const sc = g.nodes.find((n) => n.id === 'scope1');
  const sp = pos('scope1');
  for (const id of ['t1', 't2']) {
    const p = pos(id);
    assert.ok(p.x >= sp.x && p.y >= sp.y, id + ' 应在 scope 内（左上）');
    assert.ok(p.x + 170 <= sp.x + sc.data.width, id + ' 应在 scope 内（右边界）');
    assert.ok(p.y + 90 <= sp.y + sc.data.height, id + ' 应在 scope 内（下边界）');
  }

  console.log('CONTAINER MODEL TEST: PASS');
}

try {
  main();
} catch (error) {
  console.error('CONTAINER MODEL TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(OUT, { recursive: true, force: true });
}
