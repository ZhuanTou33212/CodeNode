/**
 * agent-cache-invalidation-test.cjs —— 只读结果缓存的失效边界（真实工具循环）
 *
 * 走的链路（不绕过 harness）：
 *   toolkit.buildDefaultRegistryWithConfig 装配真实工具 → agent.runAgentChat 真实工具循环
 *   → AgentToolContext 注入 sandbox 策略 → scripts/lib/scripted-model.cjs 替换 global.fetch 提供确定性模型输出
 *
 * 回归 bug：缓存失效此前按「写工具清单」（MUTATION_TOOLS）判定，而能改文件的工具不止写入类——
 * execute_shell 跑脚本/构建、poll_job 轮询正在写盘的后台任务、delegate_task 的 builder 子代理落盘、
 * 扩展与 MCP 工具执行外部命令都不在清单里，执行后缓存不失效 → 随后的 read_file 命中旧结果
 * （实测：shell 写入后 read_file 仍返回 OLD-CONTENT，而磁盘已是 NEW-CONTENT）。
 *
 * 现在的规则：缓存只在「只读白名单」工具之间保活，其余任何工具（含执行失败/未注册的）执行后一律清空。
 * 本用例同时锁住两个方向：该失效的必须失效，纯只读之间的复用不能被误伤。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cache-test-'));
const aTxt = path.join(root, 'work', 'a.txt');
function resetWorkspace() {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(aTxt, 'OLD-CONTENT\n');
  // 由 shell 执行、把 a.txt 改成 NEW-CONTENT 的小脚本（模拟构建/格式化/脚本类命令改文件）
  fs.writeFileSync(path.join(root, 'work', 'touch.cjs'), "require('fs').writeFileSync('work/a.txt','NEW-CONTENT\\n');\n");
}
resetWorkspace();

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

let fetchStub = null;

function makeRegistry() {
  return toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['read_file', 'write_file', 'execute_shell', 'list_directory'],
  });
}

async function runTurn(script) {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  fetchStub = installScriptedModel(script, { loopLast: false });
  try {
    return await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'scripted',
        model: 'scripted-model',
        maxTokens: 2048,
        reasoningEffort: '',
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: { registry: makeRegistry(), context },
      signal: controller.signal,
      timeoutMs: 20000,
    });
  } finally {
    fetchStub.restore();
    fetchStub = null;
  }
}

function callsOf(result, name) {
  return (result.toolCalls || []).filter((item) => item.name === name);
}

(async () => {
  // ---------------------------------------------------------------- 场景 1：纯只读之间的复用必须保留
  resetWorkspace();
  console.log('== 场景 1：连续两次同参 read_file（只读之间）→ 第二次命中缓存，结果不变 ==');
  const sameRead = await runTurn([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'c3', name: 'list_directory', args: { path: 'work' } }] },
    { toolCalls: [{ id: 'c4', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { content: '完成' },
  ]);
  const reads = callsOf(sameRead, 'read_file');
  check('只读之间：第 2 次同参 read_file 命中缓存（repeated=true）', reads[1] && reads[1].repeated === true,
    JSON.stringify(reads[1] && reads[1].result));
  check('只读之间：经过 list_directory 后第 3 次仍命中缓存（只读工具不互相失效）', reads[2] && reads[2].repeated === true,
    JSON.stringify(reads[2] && reads[2].result));
  check('只读之间：内容仍是 OLD-CONTENT', String(reads[2] && reads[2].result).includes('OLD-CONTENT'));

  // ---------------------------------------------------------------- 场景 2：回归主场景（shell 改文件后必须失效）
  resetWorkspace();
  console.log('\n== 场景 2：read_file → execute_shell（脚本改文件）→ read_file 必须读到新内容 ==');
  const afterShell = await runTurn([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'c2', name: 'execute_shell', args: { command: 'node work/touch.cjs', timeoutSeconds: 30 } }] },
    { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { content: '完成' },
  ]);
  const shellReads = callsOf(afterShell, 'read_file');
  const shellCalls = callsOf(afterShell, 'execute_shell');
  check('shell 命令真实执行成功', shellCalls[0] && shellCalls[0].ok === true, JSON.stringify(shellCalls[0] && shellCalls[0].data));
  check('磁盘确实已被 shell 改写', fs.readFileSync(aTxt, 'utf8').includes('NEW-CONTENT'));
  check('shell 之后同参 read_file 不再复用缓存（repeated 不为 true）', shellReads[1] && shellReads[1].repeated !== true,
    'repeated=' + JSON.stringify(shellReads[1] && shellReads[1].repeated));
  check('shell 之后读到的是新内容 NEW-CONTENT', String(shellReads[1] && shellReads[1].result).includes('NEW-CONTENT'),
    JSON.stringify(String(shellReads[1] && shellReads[1].result).slice(0, 80)));

  // ---------------------------------------------------------------- 场景 3：写工具路径不能被改坏
  resetWorkspace();
  console.log('\n== 场景 3：read_file → write_file → read_file 仍要读到写入后的内容 ==');
  const afterWrite = await runTurn([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'work/a.txt', content: 'WRITTEN-CONTENT\n' } }] },
    { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { content: '完成' },
  ]);
  const writeReads = callsOf(afterWrite, 'read_file');
  check('write_file 之后 read_file 未复用缓存', writeReads[1] && writeReads[1].repeated !== true);
  check('write_file 之后读到 WRITTEN-CONTENT', String(writeReads[1] && writeReads[1].result).includes('WRITTEN-CONTENT'));

  // ---------------------------------------------------------------- 场景 4：非只读工具即使失败也清缓存（fail-closed）
  resetWorkspace();
  console.log('\n== 场景 4：read_file → 未注册工具（失败）→ read_file 也要清缓存（fail-closed） ==');
  const afterUnknown = await runTurn([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'c2', name: 'definitely_unknown_tool', args: {} }] },
    { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { content: '完成' },
  ]);
  const unknownReads = callsOf(afterUnknown, 'read_file');
  check('未知工具调用确实失败', (afterUnknown.toolCalls || []).some((item) => item.name === 'definitely_unknown_tool' && item.ok === false));
  check('失败的非只读工具之后 read_file 未复用缓存', unknownReads[1] && unknownReads[1].repeated !== true,
    'repeated=' + JSON.stringify(unknownReads[1] && unknownReads[1].repeated));

  // ---------------------------------------------------------------- 场景 5：不同参数不共享缓存键
  resetWorkspace();
  console.log('\n== 场景 5：read_file 不同 offset 之间不互相复用 ==');
  const offsetReads = await runTurn([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'work/a.txt', offset: 1 } }] },
    { toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'work/a.txt', offset: 2 } }] },
    { content: '完成' },
  ]);
  const twoReads = callsOf(offsetReads, 'read_file');
  check('不同参数不共享缓存（第二次不是 repeated）', twoReads[1] && twoReads[1].repeated !== true);

  console.log('\n== 结论：' + (failures === 0 ? '全部通过' : failures + ' 项失败') + ' ==');
  try {
    cleanup(root);
  } catch {}
  if (failures) process.exit(1);
})().catch((error) => {
  console.error('agent-cache-invalidation-test 异常：', error && error.stack ? error.stack : error);
  if (fetchStub) fetchStub.restore();
  process.exit(1);
});

function cleanup(dir) {
  const walk = (target) => {
    let items = [];
    try {
      items = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(target, item.name);
      if (item.isDirectory()) walk(full);
      else try { fs.unlinkSync(full); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
  };
  walk(dir);
}

assert.ok(true);
