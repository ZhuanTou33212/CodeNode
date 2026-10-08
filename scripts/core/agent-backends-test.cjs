'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { RpcClient } = require('../../electron/backends/rpc.cjs');
const { CodexBackend } = require('../../electron/backends/codex.cjs');
const { BuiltinBackend } = require('../../electron/backends/index.cjs');
const settings = require('../../electron/backends/settings.cjs');
const external = require('../../electron/backends/runExternal.cjs');
const runStore = require('../../electron/runStore.cjs');
const { capture, compare } = require('../../electron/backends/workspaceDiff.cjs');
const { launchEnvironment } = require('../../electron/backends/network.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-backends-'));
const userData = path.join(root, '.userdata');
const fixture = path.join(__dirname, '../fixtures/codex-app-server.cjs');
class FixtureRpc extends RpcClient {
  constructor(command, cwd) { super(command, cwd, { spawn: (_file, _args, options) => spawn(process.execPath, [fixture], options) }); }
}
const selected = { ...settings.config.defaults, backend: 'codex', executable: process.execPath, sandbox: 'workspace-write' };
const create = () => new CodexBackend(selected, { RpcClient: FixtureRpc, executableVersion: async () => settings.config.protocolVersion });
const cfg = { editing: { autoVerify: true, blockOnFailure: true, lintCommand: 'node -e "process.exit(0)"', testCommand: 'node math.test.cjs' } };
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
async function main() {
  const network = await launchEnvironment({ platform: 'win32', env: {}, readProxy: async () => ({ enabled: 1, server: '127.0.0.1:7890', bypass: '<local>;*.example.local' }) });
  assert.equal(network.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(network.proxySource, 'windows-system');
  assert.match(network.env.NO_PROXY, /localhost/); assert.match(network.env.NO_PROXY, /\.example.local/);
  const inherited = await launchEnvironment({ platform: 'win32', env: { HTTPS_PROXY: 'http://explicit:8080', NO_PROXY: 'private.local' }, readProxy: async () => { throw new Error('must not read system'); } });
  assert.equal(inherited.env.HTTPS_PROXY, 'http://explicit:8080'); assert.equal(inherited.env.NO_PROXY, 'private.local');
  const separate = await launchEnvironment({ platform: 'win32', env: {}, readProxy: async () => ({ enabled: 1, server: 'http=127.0.0.1:8080;https=127.0.0.1:8443' }) });
  assert.equal(separate.env.HTTP_PROXY, 'http://127.0.0.1:8080/'); assert.equal(separate.env.HTTPS_PROXY, 'http://127.0.0.1:8443/');
  console.log('BACKEND TEST STAGE: proxy/settings');
  assert.equal(settings.read(root, userData).settings.backend, 'builtin');
  settings.write(root, userData, 'machine', selected);
  settings.write(root, userData, 'project', { ...selected, sandbox: 'read-only' });
  assert.equal(settings.read(root, userData).settings.sandbox, 'read-only');
  settings.write(root, userData, 'project', null);
  assert.equal(settings.read(root, userData).settings.sandbox, 'workspace-write');
  assert.throws(() => settings.normalize({ ...selected, sandbox: 'danger-full-access' }));
  assert.throws(() => settings.normalize({ ...selected, backend: 'openclaw', args: ['acp', '--token', 'sample-secret'] }), /不能保存明文密钥/);
  assert.throws(() => settings.normalize({ ...selected, backend: 'openclaw', args: ['acp', '--password=sample-secret'] }), /不能保存明文密钥/);
  const invalid = new CodexBackend(selected, { executableVersion: async () => '999.0.0' });
  assert.equal((await invalid.capabilities(root)).available, false);
  const agent = require('../../electron/agent.cjs');
  const original = agent.runAgentChat;
  const value = /** @type {any} */ ({ content: 'unchanged', usage: { total_tokens: 9 }, state: 'COMPLETED' });
  let count = 0;
  agent.runAgentChat = async input => { count++; assert.equal(input.cfg.test, true); return value; };
  try { assert.equal(await new BuiltinBackend().start({ cfg: { test: true } }), value); assert.equal(count, 1); }
  finally { agent.runAgentChat = original; }
  console.log('BACKEND TEST STAGE: builtin delegation');
  assert.equal((await create().capabilities(root)).available, true);
  console.log('BACKEND TEST STAGE: Codex capabilities');
  const readOnlyRoot = path.join(root, 'readonly-project'); fs.mkdirSync(readOnlyRoot);
  const readOnly = new CodexBackend({ ...selected, sandbox: 'read-only' }, { RpcClient: FixtureRpc, executableVersion: async () => settings.config.protocolVersion });
  const deniedEvents = [];
  await readOnly.start({ projectRoot: readOnlyRoot, prompt: 'resume-edit', confirm: async () => true, onDelta: event => deniedEvents.push(event) });
  assert.equal(fs.existsSync(path.join(readOnlyRoot, 'math.cjs')), false, 'Read-only must decline escalation even after a dialog accepts');
  assert(deniedEvents.some(event => event.kind === 'backend_approval' && event.phase === 'denied'));
  console.log('BACKEND TEST STAGE: read-only permission');
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  fs.writeFileSync(path.join(root, 'math.test.cjs'), "require('assert').strictEqual(require('./math.cjs')(2,3),5);\n");
  const events = []; const controller = new AbortController();
  const common = { projectRoot: root, settings: selected, cfg, history: [], canvasSummary: 'task → end',
    sessionId: 'canvas-session', onDelta: event => {
      events.push(event);
      if (event.kind === 'start' || event.kind === 'backend_approval' || (event.kind === 'state' && ['RUNNING','WAITING_USER','CANCELLED'].includes(event.state))) {
        console.log('BACKEND TEST EVENT: ' + event.kind + (event.phase ? ':' + event.phase : '') + (event.state ? ':' + event.state : ''));
      }
    } };
  const firstPending = external.runExternal({ ...common, requestId: 'first', prompt: 'interrupt-test', signal: controller.signal,
    confirm: async () => false }, { createBackend: create });
  await waitFor(() => events.some(event => event.kind === 'backend_approval' && event.phase === 'denied'), 'Codex fixture did not request and receive a denial');
  await waitFor(() => external.sessionFromRun(root, 'first')?.session?.turnId === 'turn-1', 'Codex turn handle was not persisted before cancellation');
  controller.abort();
  const first = await firstPending;
  assert.equal(first.state, 'CANCELLED');
  assert.equal(first.aborted, true);
  assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
  assert(events.some(e => e.kind === 'backend_approval' && e.phase === 'denied'));
  assert(!events.some(e => e.kind === 'command'), 'Protocol fields must not overwrite host event kind');
  console.log('BACKEND TEST STAGE: cancelled run persisted');
  const record = external.sessionFromRun(root, 'first');
  assert.equal(record.session.threadId, 'thread-fixture'); assert.equal(record.session.turnId, 'turn-1');
  const plan = external.resumePlan(root, 'first', new Set());
  assert.equal(plan.requiresReview, true);
  const review = await external.runExternal({ ...common, requestId: 'review', prompt: 'resume-edit', resumeRunId: 'first', confirm: async () => true }, { createBackend: create });
  assert.equal(review.needsReview, true);
  console.log('BACKEND TEST STAGE: review gate');
  let checks = 0;
  const resumed = await external.runExternal({ ...common, requestId: 'resumed', prompt: 'resume-edit', resumeRunId: 'first', resumeForce: true,
    confirm: async () => true }, { createBackend: create, verifyRun: async (hook) => {
      checks++; const output = execFileSync(process.execPath, hook.command.startsWith('node -e') ? ['-e', 'process.exit(0)'] : ['math.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
      return { ok: true, output, exitCode: 0 };
    } });
  assert.equal(resumed.ok, true); assert.equal(resumed.reply, '修改完成');
  assert.equal(resumed.usage.total_tokens, 13, 'Cumulative usage must exclude the previous turn');
  assert.equal(resumed.codeVerification.verified, true); assert.equal(checks, 2);
  console.log('BACKEND TEST STAGE: resumed run verified');
  assert(resumed.changes.files.some(file => file.path === 'math.cjs' && file.before !== file.after));
  assert.equal(resumed.costUnknown, true);
  const duplicate = await external.runExternal({ ...common, requestId: 'resumed', prompt: 'resume-edit', confirm: async () => true }, { createBackend: create });
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已有执行记录/);
  // A completed model turn cannot admit downstream work when independent
  // validation fails. Change real inputs so another validation is required.
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  const rejected = await external.runExternal({ ...common, requestId: 'verification-failed', prompt: 'resume-edit',
    confirm: async () => true }, { createBackend: create,
    verifyRun: async () => ({ ok: false, output: 'independent check failed', exitCode: 1 }) });
  assert.equal(rejected.ok, false); assert.equal(rejected.stopReason, 'verification_unavailable');
  assert.equal(rejected.codeVerification.verified, false);
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  const outOfScope = await external.runExternal({ ...common, requestId: 'goal-scope-violation', prompt: 'resume-edit', goalWriteScope: ['docs'],
    confirm: async () => true }, { createBackend: create, verifyRun: async () => ({ ok: true, output: 'passes', exitCode: 0 }) });
  assert.equal(outOfScope.ok, false); assert.equal(outOfScope.stopReason, 'goal_scope_violation');
  console.log('BACKEND TEST STAGE: scope violation');
  assert.deepEqual(outOfScope.goalScopeViolations, ['math.cjs']);
  assert.match(fs.readFileSync(path.join(root, 'math.cjs'), 'utf8'), /module\.exports/, 'out-of-scope changes stay available for review');
  assert.equal(runStore.summarizeRun(runStore.readRun(root, 'resumed')).stateHistoryValid, true);
  const calls = fs.readFileSync(path.join(root, '.codenode/fixture-rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const read = calls.findIndex(c => c.method === 'thread/read');
  const resume = calls.findIndex(c => c.method === 'thread/resume');
  assert(read >= 0 && resume > read); assert(calls.some(c => c.method === 'turn/interrupt'));
  assert.equal(calls.find(c => c.method === 'turn/start').params.sandboxPolicy.writableRoots[0], root);
  const disconnected = await external.runExternal({ ...common, requestId: 'disconnected', sessionId: 'other', prompt: 'disconnect-test', confirm: async () => false }, { createBackend: create });
  assert.equal(disconnected.stopReason, 'backend_result_unknown');
  const blocked = await external.runExternal({ ...common, requestId: 'blocked', prompt: 'resume-edit', resumeRunId: 'disconnected', resumeForce: true, confirm: async () => true }, { createBackend: create });
  assert.equal(blocked.ok, false); assert.match(blocked.error, /仍在运行/);
  console.log('BACKEND TEST STAGE: disconnect and duplicate guard');
  const before = capture(root); fs.writeFileSync(path.join(root, 'new.txt'), 'new'); fs.unlinkSync(path.join(root, 'math.cjs'));
  const files = compare(before, capture(root)).files;
  assert(files.some(f => f.path === 'new.txt' && f.kind === 'added'));
  assert(files.some(f => f.path === 'math.cjs' && f.kind === 'deleted'));
  console.log('AGENT BACKENDS: PASS (real RPC transport, denial, confirmed interruption, persisted resume, unknown-result guard, file fingerprints, independent tests, cumulative usage, settings scopes, builtin delegation)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-backends-')) fs.rmSync(resolved, { recursive: true, force: true });
});
