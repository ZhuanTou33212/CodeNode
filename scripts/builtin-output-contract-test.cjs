'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { schemas } = require('../electron/tools/builtInOutputSchemas.cjs');
const { validateOutput } = require('../electron/tools/outputSchema.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { getScalarStore } = require('../electron/scalars/index.cjs');
const sandbox = require('../electron/sandbox.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-builtin-output-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'export const contract = 1;\n');
  const registry = toolkit.buildDefaultRegistry();
  toolkit.registerDiscoverTool(registry);
  const manager = new SubagentManager({ cfg: {}, registry, runId: 'output-inventory' });
  manager.register(registry);
  const actual = registry.listDescriptors();
  assert.deepEqual(actual.map((d) => d.name).sort(), Object.keys(schemas).sort());
  assert.equal(actual.length, 41, 'New built-ins require a named executable output contract');
  for (const descriptor of actual) {
    assert.notEqual(descriptor.outputSchema, null, descriptor.name);
    assert.notEqual(validateOutput([], descriptor.outputSchema), null, descriptor.name + ' must not accept arbitrary data');
    if (descriptor.name !== 'read_skill') {
      assert.notEqual(validateOutput({}, descriptor.outputSchema), null, descriptor.name + ' needs required result fields');
    }
    const rejected = registry._validateOutput(AgentToolResult.ok('invalid array payload', []), descriptor, descriptor.name, {});
    assert.equal(rejected.ok, false, descriptor.name + ' execution boundary');
    assert.equal(rejected.failure.retryable, false, descriptor.name + ' unsafe retries');
  }
  // Every implementation also supports direct registration with the same contract.
  for (const module of toolkit.BUILTINS) {
    const direct = new AgentToolRegistry();
    module.register(direct);
    for (const descriptor of direct.listDescriptors()) assert.notEqual(descriptor.outputSchema, null, descriptor.name);
  }
  console.log('PASS 41 built-in output contracts are registered, executable, and reject missing/wrong payloads');

  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
  sandbox.setDefaultPolicy(policy);
  const graph = new GraphModel({ root: { nodes: [], edges: [] } });
  const context = new AgentToolContext({ projectRoot: root, model: graph, fsWorker: false,
    sandbox: policy, scalarStore: getScalarStore(root), runId: 'output-inventory', confirm: async () => true,
    mutateWorkbench: async (fn) => { fn(graph); graph.bumpRevision(); return true; },
    saveProject: async () => path.join(root, 'workflow.cnode'), askUser: async () => 'answer', ui: async () => true,
    ragConfig: { enabled: true, embedProvider: 'none' },
  });
  /** @type {Array<[string, any]>} */
  const samples = [
    ['read_file', { path: 'source.js' }], ['read_file', { path: 'source.js', analyze: true }],
    ['find_files', { pattern: '**/*' }], ['search_files', { pattern: 'contract' }], ['list_directory', {}],
    ['scan_project', {}], ['project_info', {}], ['analyze_project', {}],
    ['write_file', { path: 'written.txt', content: 'before', backup: false }],
    ['edit_file', { path: 'written.txt', oldText: 'before', newText: 'after' }],
    ['bulk_edit', { action: 'create_files', list: [{ path: 'batch.txt', content: 'batch' }] }],
    ['workbench_edit', { action: 'create', id: 'schema-node', type: 'task', name: 'Task' }],
    ['get_workbench_model', {}], ['get_workbench_model', { view: 'counts' }],
    ['query_scalars', { prefix: 'node:' }], ['retrieve_context', { query: 'contract', mode: 'file' }],
    ['ask_user', { question: 'Contract test?' }], ['save_project', {}],
    ['remember', { content: 'Use the contract fixture', scope: 'project' }], ['recall', { query: 'contract' }],
    ['discover_tools', { query: 'read' }],
  ];
  for (const [name, args] of samples) {
    const result = await registry.execute(name, args, context);
    assert.equal(result.ok, true, name + ': ' + result.text);
    assert.equal(validateOutput(result.data, registry.descriptorOf(name).outputSchema), null, name);
  }
  console.log('PASS real file, shell-independent, canvas, scalar, retrieval, memory and plan-compatible payloads');

  // A successful lookup of a failed task remains a successful query; the task
  // status is a separate contract from the tool's own ok status.
  manager.taskViewsHydrated = true;
  for (const status of ['failed', 'blocked', 'cancelled', 'queued']) {
    const taskId = 'state-' + status;
    manager.tasks.set(taskId, { taskId, runId: 'output-inventory', role: 'explorer', objective: 'Inspect',
      status, summary: '', startedAt: new Date().toISOString(), envelope: null, review: { status: 'not_eligible' } });
    const result = await registry.execute('get_subagent_task', { taskId }, context);
    assert.equal(result.ok, true, result.text);
    assert.equal(result.data.status, status);
  }
  console.log('PASS querying failed/blocked/queued tasks preserves their lifecycle state');

  const writeTool = registry.tools.get('write_file');
  const originalWrite = writeTool.executor;
  let writes = 0;
  writeTool.executor = async (...args) => { writes++; const result = await originalWrite(...args); if (result.ok) result.data.bytes = 'invalid'; return result; };
  const invalidWrite = await registry.execute('write_file', { path: 'invalid-receipt.txt', content: 'written exactly once', backup: false }, context);
  assert.equal(fs.readFileSync(path.join(root, 'invalid-receipt.txt'), 'utf8'), 'written exactly once');
  assert.equal(writes, 1);
  assert.equal(invalidWrite.ok, false);
  assert.equal(invalidWrite.failure.code, 'EFFECT_UNKNOWN');
  assert.equal(invalidWrite.data.outputValidation.path, '$.data.bytes');
  assert.equal(invalidWrite.failure.retryable, false);
  writeTool.executor = originalWrite;

  const shellTool = registry.tools.get('execute_shell');
  const originalShell = shellTool.executor;
  let shellRuns = 0;
  shellTool.executor = async (...args) => { shellRuns++; const result = await originalShell(...args); if (result.ok) result.data.exitCode = '0'; return result; };
  const invalidShell = await registry.execute('execute_shell', {
    command: 'node -e "require(\'fs\').writeFileSync(\'shell-marker.txt\',\'once\')"', timeoutSeconds: 20,
  }, context);
  assert.equal(fs.readFileSync(path.join(root, 'shell-marker.txt'), 'utf8'), 'once');
  assert.equal(shellRuns, 1);
  assert.equal(invalidShell.ok, false);
  assert.equal(invalidShell.failure.code, 'EFFECT_UNKNOWN');
  assert.equal(invalidShell.failure.retryable, false);
  shellTool.executor = originalShell;
  console.log('PASS real file/Shell side effects with malformed receipts cannot become success or safe retry');
  console.log('BUILTIN OUTPUT CONTRACTS: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
