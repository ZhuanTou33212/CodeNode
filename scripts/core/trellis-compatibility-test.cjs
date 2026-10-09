'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const trellis = require('../../electron/trellis/index.cjs');
const runStore = require('../../electron/runStore.cjs');
const { captureInputs } = require('../../electron/codeVerification.cjs');
const { buildPromptContext } = require('../../electron/promptContext.cjs');
const { buildSubagentPrompt } = require('../../electron/subagentPrompt.cjs');
const fixture = require('../fixtures/trellis-v0.6.17.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trellis-'));
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
process.env.CODENODE_HOME = path.join(root, 'home');
const write = (source, text) => { const full = path.join(root, source); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
async function main() {
  try {
    assert.equal(trellis.detectProject(root).detected, false);
    for (const [source, text] of Object.entries(fixture.files)) write(source, text);
    const taskPath = fixture.taskPath;
    const baseline = JSON.stringify(fixture.files);
    const project = trellis.detectProject(root);
    assert.equal(project.tasks.length, 1); assert.equal(project.tasks[0].raw.meta.unknown, 'preserve');
    const snapshot = trellis.resolveContext(root, taskPath);
    assert.equal(snapshot.ready, true, JSON.stringify(snapshot.diagnostics));
    for (const role of ['supervisor', 'explorer', 'builder', 'verifier', 'reviewer']) {
      const context = trellis.assertReady(snapshot, role);
      assert.match(context.text, /DEMO_PRD/); assert.match(context.text, /BASE_RULES/);
      const system = buildSubagentPrompt({ role, objective: 'synthetic task' }, { role, trellisContext: context });
      assert.match(system, /DEMO_PRD/);
      if (role === 'builder') { assert.match(system, /BUILDER_RULES/); assert.doesNotMatch(system, /CHECK_RULES/); }
      if (['verifier', 'reviewer'].includes(role)) { assert.match(system, /CHECK_RULES/); assert.doesNotMatch(system, /BUILDER_RULES/); }
    }
    const budgetInput = { trellisContext: trellis.assertReady(snapshot), buildSkillsIndex: () => '', truncateCanvasSummary: text => ({ text }), truncateSkillsIndex: text => ({ text }), userMemoryStore: { readUserMemory: () => ({ entries: [] }), buildUserMemoryInjection: () => ({ text: '', tokens: 0 }) }, memoryConfig: { budgetTokens: 0 } };
    const prompt = buildPromptContext(budgetInput);
    assert.match(prompt.trellisText, /DEMO_PRD/); assert.equal(prompt.contextBudget.trace.find(row => row.id === 'trellis').reason, 'full');
    assert.throws(() => buildPromptContext({ ...budgetInput, dynamicContextConfig: { totalTokens: 1, sections: [] } }), /预算/);
    trellis.selectTask(root, 'conversation-a', taskPath);
    assert.equal(trellis.selectedTask(root, 'conversation-b'), null);
    assert.throws(() => trellis.selectTask(root, '__proto__', taskPath), /会话/);
    const handlers = new Map();
    // Pure Node harness provides the Electron event surface used by ToolBridge.
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = /** @type {any} */ ({ id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain: new (require('node:events').EventEmitter)() } });
    require('../../electron/ipc/agent.cjs').register({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, userDataDir: () => path.join(root, 'userdata') });
    assert.equal((await handlers.get('trellis:project')({}, root, 'conversation-a')).value.selectedTask, taskPath);
    assert.equal((await handlers.get('trellis:context')({}, root, taskPath)).value.ready, true);
    assert.equal((await handlers.get('trellis:context')({}, root, '../outside')).ok, false);
    const loaded = trellis.contextForRun(root, 'conversation-a');
    // Exercise the actual desktop handler and real child dispatcher with offline model requests.
    const agent = require('../../electron/agent.cjs');
    const { installScriptedModel } = require('../lib/scripted-model.cjs');
    const originalLoad = agent.loadConfig;
    agent.loadConfig = project => ({ ...originalLoad(project), apiBase: 'http://scripted.local/v1', apiKey: 'synthetic', model: 'scripted', rag: { ...originalLoad(project).rag, enabled: false }, hooks: { enabled: false }, sandbox: { ...originalLoad(project).sandbox, mode: 'off' } });
    let stub = installScriptedModel([{ content: 'offline main reply' }]);
    try {
      const result = await handlers.get('agent:chat')({ sender: { isDestroyed: () => false, send: () => {} } }, { projectRoot: root, memoryConversationId: 'conversation-a', sessionId: 'demo-session', requestId: 'trellis-main', prompt: '读取所选任务资料并报告，不修改文件', history: [], document: { root: { nodes: [], edges: [] } } });
      assert.equal(result.ok, true, result.error);
      assert.ok(stub.seen.some(request => request.messages.some(message => message.role === 'system' && String(message.content).includes('DEMO_PRD'))), 'actual desktop request includes Trellis PRD');
      assert.ok(runStore.readRun(root, 'trellis-main').some(event => event.type === 'trellis_context'));
    } finally { stub.restore(); agent.loadConfig = originalLoad; }
    const toolkit = require('../../electron/tools/toolkit.cjs');
    const { AgentToolContext } = require('../../electron/tools/context.cjs');
    const { GraphModel } = require('../../electron/tools/GraphModel.cjs');
    const { SubagentManager } = require('../../electron/subagents.cjs');
    const sandbox = require('../../electron/sandbox.cjs');
    const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const parent = new AgentToolContext({ projectRoot: root, model, confirm: async () => true, audit: () => {}, askUser: async () => '', sandbox: policy, runId: 'trellis-child', mutateWorkbench: async fn => { fn(model); return true; } });
    const manager = new SubagentManager({ agent: { runAgentChat: agent.runAgentChat }, toolkit, cfg: { apiBase: 'http://scripted.local/v1', apiKey: 'synthetic', model: 'scripted', maxTokens: 2048, limits: { maxTotalTokens: 1000000 }, rag: { enabled: false }, tools: {}, trellisSnapshot: loaded }, registry, runId: 'trellis-child' });
    manager.register(registry);
    for (const role of ['explorer', 'builder', 'verifier', 'reviewer']) {
      stub = installScriptedModel([{ content: 'offline child reply' }]);
      try {
        const result = await registry.execute('delegate_task', { role, objective: '检查给定任务资料', acceptanceCriteria: ['报告所收到的规范'] }, parent);
        assert.equal(result.ok, true, result.text);
        const system = String(stub.seen[0]?.messages[0]?.content);
        assert.match(system, /DEMO_PRD/); assert.match(system, /BASE_RULES/);
        if (role === 'builder') { assert.match(system, /BUILDER_RULES/); assert.doesNotMatch(system, /CHECK_RULES/); }
        if (['verifier', 'reviewer'].includes(role)) { assert.match(system, /CHECK_RULES/); assert.doesNotMatch(system, /BUILDER_RULES/); }
      } finally { stub.restore(); }
    }
    write('demo.cjs', 'module.exports=1;');
    runStore.startRun(root, 'demo-run', { prompt: 'test' });
    trellis.recordContext(root, 'demo-run', loaded);
    const inputs = captureInputs(root);
    runStore.finishRun(root, 'demo-run', 'cancelled', { codeVerification: { status: 'passed', verified: true, fingerprint: inputs.fingerprint, files: ['demo.cjs'], checks: [{ command: 'node --check demo.cjs', exitCode: 0 }], scope: 'local' } });
    assert.equal(trellis.taskRuns(root, taskPath)[0].status, 'cancelled');
    assert.equal(trellis.taskRuns(root, taskPath)[0].evidenceFresh, true);
    write('demo.cjs', 'module.exports=2;');
    assert.equal(trellis.taskRuns(root, taskPath)[0].verification.status, 'stale');
    // Restart metadata and Run snapshots survive a fresh module instance.
    delete require.cache[require.resolve('../../electron/trellis/index.cjs')];
    const restarted = require('../../electron/trellis/index.cjs');
    assert.equal(restarted.selectedTask(root, 'conversation-a'), taskPath);
    for (const [source, text] of Object.entries(fixture.files)) assert.equal(fs.readFileSync(path.join(root, source), 'utf8'), text);
    assert.equal(JSON.stringify(fixture.files), baseline);
    write(taskPath + '/prd.md', '必需规则'.repeat(10000));
    assert.equal(trellis.resolveContext(root, taskPath).ready, false, 'total context budget is diagnosed without truncation');
    assert.ok(trellis.resolveContext(root, taskPath).diagnostics.some(row => /预算/.test(row.error)));
    write(taskPath + '/prd.md', '# EXTERNALLY_CHANGED');
    assert.match(restarted.contextForRun(root, 'conversation-a').text, /EXTERNALLY_CHANGED/);
    assert.match(restarted.contextForRun(root, 'conversation-a', 'demo-run').text, /DEMO_PRD/);
    assert.deepEqual(restarted.sourceChanges(root, loaded), [taskPath + '/prd.md']);
    write(taskPath + '/check.jsonl', '{broken\n');
    assert.equal(trellis.resolveContext(root, taskPath).ready, false);
    assert.throws(() => trellis.contextForRun(root, 'conversation-a'), /上下文不完整/);
    fs.unlinkSync(path.join(root, taskPath, 'prd.md'));
    assert.ok(trellis.resolveContext(root, taskPath).diagnostics.some(row => row.source.endsWith('/prd.md')));
    write(taskPath + '/task.json', 'invalid');
    assert.equal(trellis.detectProject(root).tasks.length, 0);
    assert.ok(trellis.detectProject(root).diagnostics.length);
    assert.throws(() => trellis.readDocument(root, '../outside'), /越界/);
    write('.env', 'synthetic-secret');
    assert.throws(() => trellis.readDocument(root, '.env'), /受保护/);
    assert.throws(() => trellis.readDocument(root, '.CODENODE/trellis.json'), /受保护/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trellis-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => trellis.readDocument(root, 'escape/file.md'), /越界/);
    } finally { fs.rmSync(path.join(root, 'escape'), { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
    write('oversize.md', 'x'.repeat(65537)); assert.throws(() => trellis.readDocument(root, 'oversize.md'), /预算/);
    console.log('TRELLIS COMPATIBILITY: PASS (read-only, roles, budget, restart, snapshots, evidence freshness, IPC, unsafe paths, malformed/missing files)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
