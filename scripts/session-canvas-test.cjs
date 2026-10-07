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

function clearCompiledOutput() {
  const target = path.resolve(OUT);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || path.basename(target) !== 'codenode-session-test') {
    throw new Error('拒绝清理意外路径：' + target);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function compile() {
  clearCompiledOutput();
  const src = [
    'src/global.d.ts',
    'src/store/graphStore.ts',
    'src/store/sessionStore.ts',
    'src/store/chatStore.ts',
    'src/store/uiStore.ts',
    'src/store/projectStore.ts',
    'src/store/usageStore.ts',
    'src/lib/projectActions.ts',
    'src/lib/flow.ts',
    'src/types.ts',
  ];
  const res = childProcess.spawnSync(
    'npx',
    ['tsc', '--ignoreConfig', ...src, '--outDir', OUT, '--rootDir', PROJECT, '--resolveJsonModule', '--module', 'Node16', '--target', 'es2020', '--esModuleInterop', '--skipLibCheck', '--jsx', 'react-jsx', '--moduleResolution', 'Node16'],
    { cwd: PROJECT, encoding: 'utf-8', shell: process.platform === 'win32' }
  );
  if (res.status !== 0) {
    console.error(res.stdout || res.stderr);
    throw new Error('stores 编译失败');
  }
}
compile();
process.env.NODE_PATH = path.join(PROJECT, 'node_modules');
/** @type {any} */ (require('module').Module)._initPaths();

const { useGraphStore } = require(path.join(OUT, 'src', 'store', 'graphStore.js'));
const { useSessionStore } = require(path.join(OUT, 'src', 'store', 'sessionStore.js'));
const { useChatStore } = require(path.join(OUT, 'src', 'store', 'chatStore.js'));
const { useUiStore } = require(path.join(OUT, 'src', 'store', 'uiStore.js'));
const { useProjectStore } = require(path.join(OUT, 'src', 'store', 'projectStore.js'));
const projectActions = require(path.join(OUT, 'src', 'lib', 'projectActions.js'));
const cnode = require(path.join(PROJECT, 'electron', 'cnode.cjs'));

const savedLocal = new Map();
global.localStorage = {
  get length() { return savedLocal.size; },
  clear: () => { savedLocal.clear(); },
  getItem: (key) => savedLocal.has(key) ? savedLocal.get(key) : null,
  key: (index) => [...savedLocal.keys()][index] || null,
  setItem: (key, value) => { savedLocal.set(key, String(value)); },
  removeItem: (key) => { savedLocal.delete(key); },
};

const mkNode = (id, type, label) => ({ id, type, position: { x: 0, y: 0 }, data: { label, status: 'pending' } });

function reset() {
  useGraphStore.setState({ nodes: [], edges: [], root: { nodes: [], edges: [] }, past: [], future: [], selectedId: null, selectedIds: [], altDragIds: [], draggingIds: [], flow: {} });
  useSessionStore.setState({ sessions: {}, order: [], activeId: null, memoryConversationId: '', memoryTaskEpoch: 0, streaming: false, messages: [], progress: null });
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
  const memoryId = useSessionStore.getState().memoryConversationId;
  await runTurn(async (payload) => {
    assert.strictEqual(payload.memoryConversationId, memoryId, '首轮应传稳定记忆会话 ID');
    return {
      ok: true,
      reply: '已完成',
      reasoning: '',
      toolCalls: [],
      usage: null,
      document: { root: { nodes: [mkNode('s1', 'start', '开始'), mkNode('t1', 'task', '任务')], edges: [] } },
    };
  });
  const ssA = useSessionStore.getState();
  assert.strictEqual(ssA.order.length, 2, '画布为空时应新开画布承载 Agent 输出');
  assert.notStrictEqual(ssA.activeId, canvas1Id);
  assert.strictEqual(ssA.memoryConversationId, memoryId, '自动新建画布不能改变记忆会话 ID');
  assert.strictEqual(ssA.memoryTaskEpoch, 0, 'Agent 自动新画布仍属于原任务代');
  const newCanvas = ssA.sessions[ssA.activeId];
  assert.strictEqual(newCanvas.doc.root.nodes.length, 2, '新画布应包含 Agent 创建的内容');
  assert.ok(ssA.sessions[canvas1Id], '原画布应保留');
  // 新画布由 Agent 承载 → 仍应保持 active（工作画布）
  assert.strictEqual(ssA.sessions[ssA.activeId].status, 'active');
  await runTurn(async (payload) => {
    assert.strictEqual(payload.memoryConversationId, memoryId, '下一轮仍应使用同一记忆会话 ID');
    assert.strictEqual(payload.sessionId, ssA.activeId, '计划仍绑定当前画布 ID');
    return { ok: true, reply: '继续', reasoning: '', toolCalls: [], usage: null };
  });
  useSessionStore.getState().switchSession(canvas1Id);
  assert.strictEqual(useSessionStore.getState().memoryConversationId, memoryId, '手动切换画布不改变记忆会话 ID');
  useSessionStore.getState().newCanvas();
  assert.strictEqual(useSessionStore.getState().memoryTaskEpoch, 1, '用户手动新画布启动新任务代');
  assert.strictEqual(useSessionStore.getState().memoryConversationId, memoryId, '新任务仍在同一对话中');

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

  // ---- 场景 E：.cnode 保存/打开后，稳定记忆 ID 保留 ----
  reset();
  useSessionStore.getState().initProject('你好');
  const persistentId = useSessionStore.getState().memoryConversationId;
  useSessionStore.getState().newCanvas();
  const persistentEpoch = useSessionStore.getState().memoryTaskEpoch;
  const projectFile = path.join(os.tmpdir(), 'codenode-memory-session-roundtrip.cnode');
  useProjectStore.setState({ root: path.dirname(projectFile), projectFile, loadRoot: async () => {} });
  let encoded = null;
  global.window = { codenode: {
    saveProject: async (_target, payload) => {
      encoded = cnode.encodeCnode(payload);
      return { ok: true, filePath: projectFile };
    },
    openGraph: async () => ({ ok: true, filePath: projectFile, data: cnode.decodeCnode(encoded) }),
  } };
  await projectActions.saveProject();
  assert.equal(cnode.decodeCnode(encoded).canvases.memoryConversationId, persistentId);
  assert.equal(cnode.decodeCnode(encoded).canvases.memoryTaskEpoch, persistentEpoch);
  useSessionStore.getState().reset();
  await projectActions.openProjectFile();
  assert.equal(useSessionStore.getState().memoryConversationId, persistentId, '工程重载后仍使用同一记忆会话 ID');
  assert.equal(useSessionStore.getState().memoryTaskEpoch, persistentEpoch, '工程重载后保留任务代');

  reset();
  useSessionStore.getState().startOnCurrent('没有预初始化的指令');
  assert.ok(useSessionStore.getState().memoryConversationId, '懒创建首个画布也必须产生稳定记忆 ID');

  console.log('SESSION CANVAS TEST: PASS');
}

main()
  .catch((error) => {
    console.error('SESSION CANVAS TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearCompiledOutput();
  });
