'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'codenode-scope-frame-test');

const result = childProcess.spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', 'src/store/graphStore.ts', 'src/lib/flow.ts', 'src/types.ts', '--outDir', OUT, '--module', 'commonjs', '--target', 'es2020', '--esModuleInterop', '--skipLibCheck', '--jsx', 'react-jsx', '--moduleResolution', 'node'],
  { cwd: PROJECT, encoding: 'utf-8', shell: process.platform === 'win32' }
);
if (result.status !== 0) throw new Error(result.stdout || result.stderr || 'scope frame compile failed');
process.env.NODE_PATH = path.join(PROJECT, 'node_modules');
require('module').Module._initPaths();

const { useGraphStore } = require(path.join(OUT, 'store', 'graphStore.js'));
const mk = (id, type, position, data = {}) => ({
  id,
  type,
  position,
  data: { label: id, status: 'pending', ...data },
});

useGraphStore.setState({ nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [], selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], resizingIds: [], flow: {} });
useGraphStore.getState().load([
  mk('outer', 'scope', { x: 100, y: 100 }, { width: 500, height: 350, childIds: ['inner'] }),
  mk('inner', 'scope', { x: 180, y: 160 }, { width: 260, height: 180, childIds: ['task'] }),
  mk('task', 'task', { x: 220, y: 220 }),
], []);

let g = useGraphStore.getState;
g().onNodesChange([{ id: 'outer', type: 'position', position: { x: 180, y: 140 }, dragging: true }]);
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'inner').position, { x: 260, y: 200 });
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'task').position, { x: 300, y: 260 });

g().moveNode('outer', { x: 200, y: 150 });
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'task').position, { x: 320, y: 270 });

g().moveNode('outer', { x: 500, y: 500 }, { moveChildren: false });
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'task').position, { x: 320, y: 270 }, 'resize origin must not move members');

g().setNodeParent('outer', 'inner');
assert.strictEqual(g().nodes.find((n) => n.id === 'outer').data.parentId, null, 'frame cycle must be rejected');
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'outer').data.members, ['inner']);
assert.deepStrictEqual(g().nodes.find((n) => n.id === 'inner').data.members, ['task']);

console.log('SCOPE FRAME TEST: PASS');
fs.rmSync(OUT, { recursive: true, force: true });
