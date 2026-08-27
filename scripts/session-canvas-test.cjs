'use strict';

/**
 * 画布-会话解耦回归测试：
 * 1) 画布为空 + Agent 输出内容 → 新开画布承载；
 * 2) 画布已有节点 + Agent 就地修改 → 不新开画布，就地更新当前画布并保持 active；
 * 3) markActive 生效。
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'codenode-session-test');

function compile() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const src = [
    'src/global.d.ts',
    'src/store/graphStore.ts',
    'src/store/sessionStore.ts',
    'src/store/chatStore.ts',
    'src/store/uiStore.ts',
    'src/store/projectStore.ts',
    'src/store/usageStore.ts',
    'src/lib/flow.ts',
    'src/types.ts',
  ];
  const res = childProcess.spawnSync(
    'npx',
    ['tsc', ...src, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2020', '--esModuleInterop', '--skipLibCheck', '--jsx', 'react-jsx', '--moduleResolution', 'node'],
    { cwd: PROJECT, encoding: 'utf-8', shell: process.platform === 'win32' }
  );
  if (res.status !== 0) {
    console.error(res.stdout || res.stderr);
    throw new Error('stores 编译失败');
  }
}
compile();
process.env.NODE_PATH = path.join(PROJECT, 'node_modules');
require('module').Module._initPaths();

const { useGraphStore } = require(path.join(OUT, 'store', 'graphStore.js'));
const { useSessionStore } = require(path.join(OUT, 'store', 'sessionStore.js'));
const { useChatStore } = require(path.join(OUT, 'store', 'chatStore.js'));
const { useUiStore } = require(path.join(OUT, 'store', 'uiStore.js'));

const mkNode = (id, type, label) => ({ id, type, position: { x: 0, y: 0 }, data: { label, status: 'pending' } });

function reset() {
  useGraphStore.setState({ nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [], selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], flow: {} });
  useSessionStore.setState({ sessions: {}, order: [], activeId: null, streaming: false, messages: [], progress: null });
}

function installApi(agentChatImpl) {
  global.window = {
    codenode: {
      onAgentDelta: () => () => {},
      agentChat: async (payload) => agentChatImpl(payload),
    },
  };
}

async function runTurn(agentChatImpl) {
  installApi(agentChatImpl);
  await useChatStore.getState().send('测试需求');
}

async function main() {
  // ---- 场景 A：画布为空 → Agent 输出内容 → 新开画布 ----
  reset();
  useSessionStore.getState().initProject('你好');
  assert.strictEqual(useSessionStore.getState().order.length, 1, '初始应有 1 个画布');
  const canvas1Id = useSessionStore.getState().activeId;
  await runTurn(async () => ({
    ok: true,
    reply: '已完成',
    reasoning: '',
    toolCalls: [],
    usage: null,
    document: { root: { nodes: [mkNode('s1', 'start', '开始'), mkNode('t1', 'task', '任务')], edges: [] } },
  }));
  const ssA = useSessionStore.getState();
  assert.strictEqual(ssA.order.length, 2, '画布为空时应新开画布承载 Agent 输出');
  const newCanvas = ssA.sessions[ssA.activeId];
  assert.strictEqual(newCanvas.doc.root.nodes.length, 2, '新画布应包含 Agent 创建的内容');
  assert.ok(ssA.sessions[canvas1Id], '原画布应保留');
  // 新画布由 Agent 承载 → 仍应保持 active（工作画布）
  assert.strictEqual(ssA.sessions[ssA.activeId].status, 'active');

  // ---- 场景 B：画布已有节点 → Agent 就地修改 → 不新开画布 ----
  reset();
  useSessionStore.getState().initProject('你好');
  useGraphStore.getState().addNode(mkNode('a1', 'start', '已有入口'));
  const before = useSessionStore.getState().activeId;
  const beforeCount = useSessionStore.getState().order.length;
  await runTurn(async () => ({
    ok: true,
    reply: '已修改',
    reasoning: '',
    toolCalls: [],
    usage: null,
    document: {
      root: {
        nodes: [mkNode('a1', 'start', '已有入口'), mkNode('b1', 'task', '新增任务'), mkNode('c1', 'end', '结束')],
        edges: [],
      },
    },
  }));
  const ssB = useSessionStore.getState();
  assert.strictEqual(ssB.order.length, beforeCount, '就地修改不应新开画布');
  assert.strictEqual(ssB.activeId, before, '就地修改应保持在当前画布');
  assert.strictEqual(ssB.sessions[before].doc.root.nodes.length, 3, '当前画布应包含旧节点 + Agent 新增节点');
  assert.ok(ssB.sessions[before].doc.root.nodes.some((n) => n.id === 'a1'), '已有节点应保留');
  assert.strictEqual(ssB.sessions[before].status, 'active', '就地修改后当前画布应保持 active');

  // ---- 场景 C：运行期间用户删除节点 → 不应复活 ----
  reset();
  useSessionStore.getState().initProject('你好');
  useGraphStore.getState().addNode(mkNode('x1', 'task', '会被删'));
  useGraphStore.getState().addNode(mkNode('y1', 'task', '保留'));
  const sC1 = useSessionStore.getState().activeId;
  // 发送前 ctx 里有 x1、y1；发送过程中用户删除 x1
  installApi(async () => ({
    ok: true,
    reply: 'ok',
    reasoning: '',
    toolCalls: [],
    usage: null,
    document: {
      root: { nodes: [mkNode('x1', 'task', '会被删'), mkNode('y1', 'task', '保留'), mkNode('z1', 'end', '新')], edges: [] },
    },
  }));
  const p = useChatStore.getState().send('需求');
  useGraphStore.getState().deleteNodes(['x1']); // 模拟运行期间删除
  await p;
  const ssC = useSessionStore.getState();
  const docIds = ssC.sessions[ssC.activeId].doc.root.nodes.map((n) => n.id);
  assert.ok(!docIds.includes('x1'), '运行期间被删除的节点不应复活');
  assert.ok(docIds.includes('y1'), '保留的节点应保留');
  assert.ok(docIds.includes('z1'), 'Agent 新增节点应生效');
  assert.strictEqual(ssC.order.length, 1, '就地修改不应新开画布');

  // ---- 场景 D：markActive ----
  reset();
  useSessionStore.getState().initProject('hi');
  useSessionStore.getState().finishTurn('done', '', []);
  assert.strictEqual(useSessionStore.getState().sessions[useSessionStore.getState().activeId].status, 'completed', 'finishTurn 会标记 completed');
  useSessionStore.getState().markActive();
  assert.strictEqual(useSessionStore.getState().sessions[useSessionStore.getState().activeId].status, 'active', 'markActive 应恢复 active');

  console.log('SESSION CANVAS TEST: PASS');
}

main()
  .catch((error) => {
    console.error('SESSION CANVAS TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(OUT, { recursive: true, force: true });
  });
