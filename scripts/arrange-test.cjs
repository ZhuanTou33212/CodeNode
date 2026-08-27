'use strict';

/**
 * 自动整理（Blender Node Arrange 风格）回归测试：
 * - 关联节点按连通分量分块排版（链条成列、分支并列）
 * - 互不关联的分量各自成块，不再混排成一列
 * - 范围节点(scope) 的成员被平移进范围节点内包裹
 * - 含 start 的分量排最前
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'codenode-arrange-test');

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

const mk = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, status: 'pending', ...data } });

function reset() {
  useGraphStore.setState({ nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [], selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], flow: {} });
}

function main() {
  reset();  const g = () => useGraphStore.getState();
  // 分量A（含 start 的完整链）：start→t1→t2→end
  // 分量B（独立组件）：a1→a2
  // 分量C（孤立）：solo
  // scope 成员：t1 放入 scope（分量A 内的包裹）
  useGraphStore.getState().load(
    [
      mk('start', 'start'),
      mk('t1', 'task'),
      mk('t2', 'task'),
      mk('end', 'end'),
      mk('scope1', 'scope', { childIds: ['t1', 't2'] }),
      mk('a1', 'task'),
      mk('a2', 'task'),
      mk('solo', 'task'),
    ],
    [
      { id: 'e1', source: 'start', target: 't1' },
      { id: 'e2', source: 't1', target: 't2' },
      { id: 'e3', source: 't2', target: 'end' },
      { id: 'e4', source: 'a1', target: 'a2' },
    ]
  );
  useGraphStore.getState().arrangeNodes();

  const nodes = g().nodes;
  const pos = (id) => nodes.find((n) => n.id === id).position;

  // 1. 链条方向：start → t1 → t2 → end 的 x 应递增（列布局）
  assert.ok(pos('start').x < pos('t1').x, 'start 应在 t1 左侧');
  assert.ok(pos('t1').x < pos('t2').x, 't1 应在 t2 左侧');
  assert.ok(pos('t2').x < pos('end').x, 't2 应在 end 左侧');

  // 2. 分量分块：独立分量 a1/a2 与链条分量 x 应明显错开（块间间距）
  const chainBlockX = Math.min(pos('start').x, pos('t1').x, pos('t2').x, pos('end').x, pos('scope1').x);
  const compBBlockX = Math.min(pos('a1').x, pos('a2').x);
  assert.ok(compBBlockX - chainBlockX > 60, '独立分量应作为独立块，与链条块水平错开');
  // 块内 a1→a2 仍保持左到右
  assert.ok(pos('a1').x < pos('a2').x, '块内链条方向保留');

  // 3. 孤立节点单独成块
  assert.ok(Math.abs(pos('solo').x - chainBlockX) > 60, '孤立节点应单独成块');

  // 4. scope 成员被包裹进 scope：t1/t2 应位于 scope 内（在 scope 右/下范围内）
  const sp = pos('scope1');
  const scopeNode1 = nodes.find((n) => n.id === 'scope1');
  const sd1 = scopeNode1.data;
  assert.ok(pos('t1').x >= sp.x && pos('t1').y >= sp.y, 't1 应在 scope 内（右下）');
  assert.ok(pos('t2').x >= sp.x && pos('t2').y >= sp.y, 't2 应在 scope 内（右下）');
  assert.ok(pos('t1').x + 170 <= sp.x + sd1.width, 'scope 应在横向完整包裹 t1');
  assert.ok(pos('t2').x + 170 <= sp.x + sd1.width, 'scope 应在横向完整包裹 t2');

  // 5. 含 start 的分量排最前（x 最小）
  const allX = nodes.map((n) => n.position.x);
  assert.strictEqual(Math.min(...allX), pos('start').x, '含 start 的分量应位于最左侧');

  // 6. 左侧成员场景：scope 应向左扩展，而不是忽略左侧成员
  reset();
  useGraphStore.getState().load(
    [mk('left-solo', 'task'), mk('left-scope', 'scope', { childIds: ['left-solo'] })],
    []
  );
  useGraphStore.getState().arrangeNodes();
  const nodes2 = useGraphStore.getState().nodes;
  const pos2 = (id) => nodes2.find((n) => n.id === id).position;
  const scope2 = nodes2.find((n) => n.id === 'left-scope');
  const sp2 = pos2('left-scope');
  const solo2 = pos2('left-solo');
  assert.ok(sp2.x < solo2.x, 'scope 应位于左侧成员左边（向左扩展）');
  assert.ok(solo2.x + 170 <= sp2.x + scope2.data.width, 'scope 应在横向完整包裹左侧成员');

  console.log('ARRANGE TEST: PASS', JSON.stringify({ chain: [pos('start'), pos('t1'), pos('t2'), pos('end')].map((p) => p.x), scope: pos('scope1'), t1: pos('t1'), t2: pos('t2'), a1: pos('a1'), solo: pos('solo') }));
}

try {
  main();
} catch (error) {
  console.error('ARRANGE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(OUT, { recursive: true, force: true });
}
