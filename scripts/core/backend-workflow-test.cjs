'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = /** @type {any} */ (require('module'));
const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const { StdioRpc } = require('../../electron/backends/stdioRpc.cjs');
const { AcpBackend } = require('../../electron/backends/acp.cjs');
const {BackendPort}=require('../../electron/backends/backendPort.cjs');
const backendFactory = require('../../electron/backends/index.cjs');
const originalFactory = backendFactory.createBackend;
const fixture = path.join(__dirname, '../fixtures/acp-workflow.cjs');
class FixtureRpc extends StdioRpc {
  constructor(command, args, cwd) { super(process.execPath, [fixture], cwd, { spawn: (_f, _a, options) => spawn(process.execPath, [fixture], options) }); }
}
backendFactory.createBackend = (name, settings) => name === 'codex' ? new BackendPort(name,settings,new AcpBackend(settings,{StdioRpc:FixtureRpc})) : originalFactory(name, settings);
const ipc = /** @type {any} */ (new EventEmitter()); const handlers = new Map();
ipc.handle = (name, fn) => handlers.set(name, fn);
const oldLoad = Module._load;
Module._load = function(request, parent, main) { return request === 'electron' ? { ipcMain: ipc } : oldLoad.call(this, request, parent, main); };
// This isolated integration test must exercise the real confirmation bridge;
// do not inherit the host's blanket test auto-answer mode.
delete process.env.CODENODE_TEST;
const agentIpc = require('../../electron/ipc/agent.cjs');
Module._load = oldLoad;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-backend-workflow-')));
const userData = path.join(root, '.userdata');
const events = [];
let stoppedRun = null; let approve = false;
let stopScheduled = false; let stopFailure = null;
function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      let value;
      try { value = predicate(); } catch {}
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(check, 10);
    };
    check();
  });
}
const sender = { id: 42, isDestroyed: () => false, send: (channel, payload) => {
  if (channel === 'agent:delta') { events.push(payload); if (payload.kind === 'start') stoppedRun = payload.requestId;
    if (payload.kind === 'start' || payload.kind === 'backend_approval' || (payload.kind === 'state' && ['RUNNING','WAITING_USER','CANCELLED'].includes(payload.state))) console.log('BACKEND WORKFLOW EVENT: ' + payload.kind + (payload.phase ? ':' + payload.phase : '') + (payload.state ? ':' + payload.state : '')); }
  if (channel === 'agent:delta' && payload.kind === 'backend_approval' && payload.phase === 'denied' && !approve && !stopScheduled) {
    stopScheduled = true;
    void waitFor(() => require('../../electron/backends/runExternal.cjs').sessionFromRun(root, stoppedRun)?.session?.sessionId,
      'Codex turn handle was not persisted before workflow cancellation')
      .then(() => handlers.get('agent:stop')({ sender }, stoppedRun))
      .catch(error => { stopFailure = error; void handlers.get('agent:stop')({ sender }, stoppedRun); });
  }
  if (channel === 'tools:request' && payload.type === 'confirm') {
    console.log('BACKEND WORKFLOW EVENT: tools:confirm');
    setImmediate(() => {
      ipc.emit('tools:response', { sender }, { id: payload.id, result: { ok: approve } });
    });
  }
} };
const event = { sender };
const config = require('../../config/agent.backends.json');
async function main() {
  const settings = { ...config.defaults, backend: 'codex', sandbox: 'workspace-write', executable: process.execPath };
  require('../../electron/backends/settings.cjs').write(root, userData, 'project', settings);
  fs.writeFileSync(path.join(root, '.codenode/agent.properties'), 'sandbox.mode=permissive\nediting.lintCommand=node -e "process.exit(0)"\nediting.testCommand=node math.test.cjs\n');
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(root, 'math.test.cjs'), "require('assert').strictEqual(require('./math.cjs')(2,3),5);\n");
  agentIpc.register({ ipcMain: /** @type {any} */ (ipc), userDataDir: () => userData });
  require('../../electron/ipc/project.cjs').register({ ipcMain: /** @type {any} */ (ipc),
    dialog: /** @type {any} */ ({ showMessageBox: async () => ({ response: 1 }) }),
    getFocusedWindow: () => /** @type {any} */ ({ webContents: sender }),
    sandbox: require('../../electron/sandbox.cjs'), runWorkflowChat: agentIpc.runWorkflowChat });
  const graph = { nodes: [{ id: 'task', type: 'task', data: { label: 'P0 file task', prompt: 'interrupt-test', writeScope: 'math.cjs' } }], edges: [] };
  console.log('BACKEND WORKFLOW STAGE: setup');
  const state = handlers.get('project:workflow-state')(event, root, 'p0', { action: 'read', graph });
  const interrupted = await handlers.get('project:workflow-execute')(event, root, 'p0', { nodeId: 'task', graph, expectedRevision: state.state.revision });
  console.log('BACKEND WORKFLOW STAGE: interrupted first run');
  assert.equal(stopFailure, null, stopFailure?.message);
  assert.equal(interrupted.ok, true); assert.equal(interrupted.executionOk, false);
  assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
  const oldRunId = stoppedRun;
  const plan = await handlers.get('agent:resume-plan')(event, root, oldRunId);
  assert.equal(plan.requiresReview, true);
  console.log('BACKEND WORKFLOW STAGE: resume review');
  approve = true;
  const resumed = await agentIpc.runWorkflowChat(event, { projectRoot: root, prompt: 'resume-edit', requestId: 'workflow-resume', resumeRunId: oldRunId, resumeForce: true });
  console.log('BACKEND WORKFLOW STAGE: resumed run returned');
  assert.equal(resumed.ok, true); assert.equal(resumed.codeVerification.verified, true);
  assert(resumed.changes.files.some(f => f.path === 'math.cjs'));
  execFileSync(process.execPath, ['math.test.cjs'], { cwd: root, windowsHide: true });
  assert(events.some(e => e.kind === 'backend_approval' && e.phase === 'denied'));
  assert(events.some(e => e.kind === 'code_verification' && e.codeVerification.verified));
  const session = require('../../electron/backends/runExternal.cjs').sessionFromRun(root, 'workflow-resume').session;
  assert.equal(session.sessionId,'acp-workflow');assert.equal(session.protocol,'acp');
  assert.equal(agentIpc.activeRequests.size, 0);
  console.log('BACKEND WORKFLOW: PASS (project workflow IPC → real agent handler → protocol process → deny → stop → persisted resume → measured file diff → independent shell test)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  backendFactory.createBackend = originalFactory;
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('codenode-backend-workflow-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
