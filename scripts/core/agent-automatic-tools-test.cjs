'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require("../../electron/agent.cjs");
const settings = require("../../electron/agentSettings.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { GraphModel } = require("../../electron/tools/GraphModel.cjs");
const { AgentToolResult } = require("../../electron/tools/result.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-automatic-tools-'));
(async () => {
  try {
    const cfg = agent.parseToolsConfig({});
    assert.equal(cfg.toolsConfirmWrites, false);
    let prompts = 0, highExecuted = false;
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const context = new AgentToolContext({ projectRoot: root, model, autoExecuteTools: true,
      confirm: async () => { prompts++; return false; }, audit: () => {},
      mutateWorkbench: async callback => { callback(model); return true; } });
    const registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg, projectRoot: root });
    const written = await registry.execute('write_file', { path: 'src/a.ts', content: 'export const value = 1;\n' }, context);
    assert.equal(written.ok, true, written.text);
    const edited = await registry.execute('edit_file', { path: 'src/a.ts', oldText: 'value = 1', newText: 'value = 2' }, context);
    assert.equal(edited.ok, true, edited.text);
    const created = await registry.execute('workbench_edit', { operations: [{ action: 'create', id: 'ordinary-node', type: 'task', name: '自动创建' }] }, context);
    assert.equal(created.ok, true, created.text);
    assert.equal(model.nodes().length, 1);
    const forked = await registry.execute('write_file', { path: 'fork.txt', content: 'child' }, context.fork({ taskId: 'child' }));
    assert.equal(forked.ok, true, forked.text);
    assert.equal(prompts, 0, 'Ordinary file and canvas writes must never request UI confirmation');
    const outside = await registry.execute('write_file', { path: '../outside.txt', content: 'blocked' }, context);
    assert.equal(outside.ok, false, 'Automatic mode must preserve project boundaries');
    registry.registerDescriptor({ name: 'explicit_high', description: 'high risk', readOnly: false, mutatesWorkspace: true,
      requiresConfirmation: 'HIGH', requiredCapability: 'workspace.write', inputSchema: { type: 'object', properties: {} } },
      async () => { highExecuted = true; return AgentToolResult.ok('unexpected'); });
    const denied = await registry.execute('explicit_high', {}, context);
    assert.equal(denied.ok, false); assert.equal(highExecuted, false); assert.equal(prompts, 1);
    registry.tools.get('explicit_high').descriptor.confirmationEnforced = false;
    const stillDenied = await registry.execute('explicit_high', {}, context);
    assert.equal(stillDenied.ok, false); assert.equal(highExecuted, false); assert.equal(prompts, 2, 'HIGH must remain mandatory even for compatibility descriptors');
    const deleted = await registry.execute('workbench_edit', { operations: [{ action: 'delete', nodeId: 'ordinary-node' }] }, context);
    assert.equal(deleted.ok, false); assert.equal(model.nodes().length, 1); assert.equal(prompts, 3);
    assert.equal(await context.confirm('WRITE', '创建工作树', 'worktree'), false);
    assert.equal(prompts, 4, 'Worktree and unlisted writes must retain confirmation');
    settings.writeSettings(root, { autoExecuteTools: false });
    assert.equal(agent.loadConfig(root).tools.toolsConfirmWrites, true);
    settings.writeSettings(root, { autoExecuteTools: true });
    assert.equal(agent.loadConfig(root).tools.toolsConfirmWrites, false);
    assert.throws(() => settings.writeSettings(root, { autoExecuteTools: 'true' }), /布尔值/);
    assert.equal(settings.canAutoExecute('worktree', { action: 'create' }), false);
    assert.equal(settings.canAutoExecute('workbench_edit', { operations: [{ action: 'create' }, { action: 'delete' }] }), false);
    console.log('AUTOMATIC TOOLS: PASS (ordinary calls without prompts, fork inheritance, boundaries, HIGH/deletion/worktree retained, persisted settings)');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('codenode-automatic-tools-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
