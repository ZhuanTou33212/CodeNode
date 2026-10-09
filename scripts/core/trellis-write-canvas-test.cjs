'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFile } = require('../../electron/atomicFile.cjs');
const trellis = require('../../electron/trellis/index.cjs');
const writes = require('../../electron/trellis/writes.cjs');
const canvas = require('../../electron/trellis/canvas.cjs');
const sandbox = require('../../electron/sandbox.cjs');
const fixture = require('../fixtures/trellis-v0.6.17.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trellis-writes-'));
process.env.CODENODE_HOME = path.join(root, 'home'); process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
const put = (source, content) => { const file = path.join(root, source); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const read = source => fs.readFileSync(path.join(root, source), 'utf8');
const taskPath = fixture.taskPath;
const journalPath = '.trellis/workspace/tester/journal-1.md';
const indexPath = '.trellis/workspace/tester/index.md';
const index = '# Workspace Index - tester\n\nUSER NOTES MUST SURVIVE\n<!-- @@@auto:current-status -->\n- **Active File**: `journal-1.md`\n- **Total Sessions**: 0\n- **Last Active**: 2026-10-09\n- **Custom**: keep\n<!-- @@@/auto:current-status -->\n<!-- @@@auto:active-documents -->\n| File | Lines | Status |\n|------|-------|--------|\n| `journal-1.md` | ~3 | Active |\n<!-- @@@/auto:active-documents -->\n<!-- @@@auto:session-history -->\n| # | Date | Title | Commits | Branch |\n|---|------|-------|---------|--------|\n<!-- @@@/auto:session-history -->\nTAIL NOTES\n';
async function main() {
  try {
    for (const [source, content] of Object.entries(fixture.files)) put(source, content);
    put(journalPath, '# Journal - tester (Part 1)\n\nUSER JOURNAL TEXT\n'); put(indexPath, index);
    const original = read(taskPath + '/task.json');
    const task = trellis.readTask(root, taskPath);
    const proposal = writes.proposeTaskUpdate(root, taskPath, { expectedFingerprint: task.fingerprint, status: 'planning', reason: '用户重新规划' });
    assert.equal(read(task.source), original, 'preview never writes upstream');
    assert.equal(writes.applyProposal(root, proposal.id).status, 'applied');
    assert.equal(read(task.source), original.replace('"status":"in_progress"', '"status":"planning"'), 'preserve all other JSON bytes and unknown fields');
    assert.equal(writes.applyProposal(root, proposal.id).status, 'applied', 'double apply is idempotent');
    assert.equal(writes.applyProposal(root, proposal.id, 'rollback').status, 'rolled-back');
    assert.equal(read(task.source), original);
    assert.throws(() => writes.proposeTaskUpdate(root, taskPath, { expectedFingerprint: task.fingerprint, status: 'completed', reason: '确认完成' }), /人工/);
    assert.throws(() => writes.proposeTaskUpdate(root, taskPath, { expectedFingerprint: task.fingerprint, status: 'invented', reason: '状态' }), /格式/);
    const conflict = writes.proposeTaskUpdate(root, taskPath, { expectedFingerprint: task.fingerprint, status: 'planning', reason: '重规划' });
    put(task.source, original + ' ');
    assert.equal(writes.applyProposal(root, conflict.id).status, 'needs-recovery'); assert.equal(read(task.source), original + ' ');
    put(task.source, original);
    assert.equal(writes.applyProposal(root, conflict.id, 'rollback').status, 'rolled-back');
    const input = { developer: 'tester', summary: '实现摘要', verification: '局部检查；未执行全项目验收', nextSteps: '独立审查', expectedFingerprint: task.fingerprint };
    put(indexPath, index.replace('| File | Lines | Status |', '| File | Lines | Status | Custom |'));
    assert.throws(() => writes.proposeJournal(root, taskPath, input), /列结构/); put(indexPath, index);
    const journal = writes.proposeJournal(root, taskPath, input);
    assert.equal(read(indexPath), index);
    let writesCount = 0;
    const partial = writes.applyProposal(root, journal.id, 'apply', { write: (file, content, encoding, guard) => { if (++writesCount === 2) throw new Error('injected index failure'); atomicWriteFile(file, content, encoding, guard); } });
    assert.equal(partial.status, 'needs-recovery'); assert.deepEqual(partial.applied, [journalPath]);
    assert.equal(read(indexPath), index); assert.match(read(journalPath), /## Session 1:/);
    delete require.cache[require.resolve('../../electron/trellis/writes.cjs')];
    const restarted = require('../../electron/trellis/writes.cjs');
    assert.equal(restarted.readProposal(root, journal.id).status, 'needs-recovery');
    assert.equal(restarted.applyProposal(root, journal.id, 'resume').status, 'applied');
    assert.equal((read(journalPath).match(/## Session 1:/g) || []).length, 1, 'resume never appends duplicate journal entries');
    assert.match(read(indexPath), /\*\*Total Sessions\*\*: 1/); assert.match(read(indexPath), /USER NOTES MUST SURVIVE/); assert.match(read(indexPath), /Custom\*\*: keep/); assert.match(read(indexPath), /TAIL NOTES/);
    const second = writes.proposeJournal(root, taskPath, input);
    assert.equal(writes.applyProposal(root, second.id).status, 'applied');
    const externalIndex = read(indexPath) + '\nEXTERNAL NOTES'; put(indexPath, externalIndex);
    assert.equal(writes.applyProposal(root, second.id, 'rollback').status, 'needs-recovery'); assert.equal(read(indexPath), externalIndex);
    // Rotation creates a new numbered upstream journal, and rollback removes only its own unchanged file.
    put(indexPath, index); put(journalPath, '# Journal - tester (Part 1)\n' + '\n'.repeat(2000));
    const rotation = writes.proposeJournal(root, taskPath, input);
    assert.ok(rotation.files[0].source.endsWith('journal-2.md')); assert.equal(writes.applyProposal(root, rotation.id).status, 'applied');
    assert.equal(writes.applyProposal(root, rotation.id, 'rollback').status, 'rolled-back'); assert.equal(fs.existsSync(path.join(root, '.trellis/workspace/tester/journal-2.md')), false);
    const spec = trellis.readDocument(root, '.trellis/spec/index.md');
    const specProposal = writes.proposeSpecUpdate(root, spec.source, { expectedFingerprint: spec.fingerprint, content: spec.content + '\n新约定\n', reason: '测试确认可复用规则', scope: '本项目' });
    assert.equal(writes.applyProposal(root, specProposal.id).status, 'applied'); assert.match(read(spec.source), /新约定/);
    writes.applyProposal(root, specProposal.id, 'rollback');
    const graph = canvas.createGraph(root, taskPath);
    assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 3);
    assert.deepEqual(graph.nodes.map(node => node.data.trellis.role), ['explorer', 'builder', 'verifier', 'reviewer']);
    assert.equal(canvas.resolveBinding(root, graph.nodes[1].data.trellis).role, 'builder');
    assert.throws(() => canvas.resolveBinding(root, { ...graph.nodes[1].data.trellis, role: 'verifier' }), /绑定/);
    put(taskPath + '/prd.md', '# UPDATED REQUIREMENT');
    assert.throws(() => canvas.resolveBinding(root, graph.nodes[1].data.trellis), /资料已变化/);
    put(taskPath + '/prd.md', fixture.files[taskPath + '/prd.md']);
    // Real main-process canvas dispatch: actual role-filtered requests, no label-based inference.
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = /** @type {any} */ ({ id: electronPath, loaded: true, exports: { ipcMain: new (require('node:events').EventEmitter)() } });
    const agent = require('../../electron/agent.cjs');
    const originalLoad = agent.loadConfig;
    agent.loadConfig = project => { const cfg = originalLoad(project); return { ...cfg, apiBase: 'http://scripted.local/v1', apiKey: 'synthetic', model: 'scripted', costSettings: { ...cfg.costSettings, roleModels: {}, roleBudgets: Object.fromEntries(['explorer','builder','verifier','reviewer','canvas'].map(role => [role, {maxTurns: 4, tokenBudget: 50000, maxOutputTokens: 512}])) }, rag: { ...cfg.rag, enabled: false }, hooks: { enabled: false }, sandbox: { ...cfg.sandbox, mode: 'off' } }; };
    const handlers = new Map(); const domain = require('../../electron/ipc/agent.cjs');
    domain.register({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, userDataDir: () => path.join(root, 'userdata') });
    const { installScriptedModel } = require('../lib/scripted-model.cjs');
    const event = { sender: { id: 1, isDestroyed: () => false, send: () => {} } };
    const projectHandlers = new Map();
    require('../../electron/ipc/project.cjs').register(/** @type {any} */ ({ ipcMain: { handle: (name, handler) => projectHandlers.set(name, handler) }, dialog: { showMessageBox: async () => ({ response: 1 }) }, getFocusedWindow: () => ({ webContents: event.sender }), sandbox, runWorkflowChat: domain.runWorkflowChat }));
    const workflow = require('../../electron/workflowState.cjs');
    let workflowView = workflow.dispatch(root, 'trellis-dag', { action: 'read', graph }).state;
    try {
      for (const node of graph.nodes) {
        const stub = installScriptedModel([{ content: 'synthetic stage result' }]);
        try {
          const result = await projectHandlers.get('project:workflow-execute')(event, root, 'trellis-dag', { graph, nodeId: node.id, expectedRevision: workflowView.revision });
          assert.equal(result.ok, true, result.error);
          assert.equal(result.executionOk, true, result.output); workflowView = result.state;
          const request = stub.seen.find(item => item.kind !== 'intent');
          assert.match(String(request.messages[0].content), /DEMO_PRD/);
          const names = request.body.tools.map(tool => tool.function.name);
          assert.ok(request.body.max_tokens <= 512, 'canvas role respects existing role output budget');
          if (['explorer', 'reviewer'].includes(node.data.trellis.role)) { assert.ok(!names.includes('write_file')); assert.ok(!names.includes('execute_shell')); }
          if (node.data.trellis.role === 'verifier') { assert.ok(names.includes('execute_shell')); assert.ok(!names.includes('write_file')); }
          assert.equal(trellis.readTask(root, taskPath).status, 'in_progress');
        } finally { stub.restore(); }
      }
      assert.equal(workflowView.completed.length, 4);
      const runs = trellis.taskRuns(root, taskPath);
      assert.equal(runs.length, 4);
      assert.deepEqual(runs.map(run => canvas.resumeBinding(root, run.runId).role).sort(), ['builder','explorer','reviewer','verifier']);
      assert.equal(canvas.resumeBinding(root, 'non-canvas-run'), null);
    } finally { agent.loadConfig = originalLoad; }
    console.log('TRELLIS WRITE/CANVAS: PASS (byte-preserving task update, conflict guards, human acceptance, journal/index/rotation, partial recovery/rollback, specs, pinned canvas roles, actual main requests and tool permissions)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
