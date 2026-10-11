'use strict';
// Muse Code backend (MSP) coverage: handshake, session/turn lifecycle, streamed
// items, approval and supplementary-input round trips, cancellation and the
// transport-level statement that Muse is not an ACP backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createBackend } = require('../../electron/backends/index.cjs');
const { StdioRpc } = require('../../electron/backends/stdioRpc.cjs');
const { uuidv7 } = require('../../electron/backends/muse.cjs');
const settings = require('../../electron/backends/settings.cjs');
const config = require('../../config/agent.backends.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-muse-')));
const fixture = path.resolve(__dirname, '../fixtures/msp-basic.cjs');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ports = [];

function fixtureBackend(logName, extraEnv = {}, overrides = {}) {
  const logPath = path.join(root, logName);
  class FixtureRpc extends StdioRpc {
    constructor(_command, _args, cwd, options = {}) {
      super(process.execPath, [fixture], cwd, { ...options,
        env: { ...options.env, FIXTURE_MSP_LOG: logPath, ...extraEnv },
        spawn: (_file, _args, spawnOptions) => spawn(process.execPath, [fixture], spawnOptions) });
    }
  }
  const port = createBackend('muse', { backend: 'muse', executable: 'muse-fixture', args: [], sandbox: 'workspace-write', ...overrides }, { StdioRpc: FixtureRpc });
  ports.push(port);
  return { port, calls: () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
function waitFor(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) { resolve(true); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function main() {
  // Identity: Muse is an MSP backend, never an ACP one, and its session handle is
  // not persisted across restarts by the reference integration.
  assert(config.mspBackends.includes('muse'), 'muse is declared as an MSP backend');
  assert(!config.acpBackends.includes('muse'), 'muse must not be offered as an ACP backend');
  assert.equal(settings.normalize({ ...config.defaults, backend: 'muse' }).transport, 'msp');
  const described = createBackend('muse', { backend: 'muse', sandbox: 'workspace-write' });
  ports.push(described);
  assert.equal(described.describe().transport, 'msp');
  assert.equal(described.describe().capabilities.sessionContinuity, 'unsupported');
  assert.equal(described.describe().capabilities.inputRequests, 'msp');
  assert.equal(described.describe().capabilities.permissions, true);
  assert.match(uuidv7(), UUIDV7);
  console.log('MUSE BACKEND STAGE: identity');

  const happy = fixtureBackend('happy.jsonl');
  const happyDeltas = []; const sessions = [];
  const happyResult = await happy.port.submit({ id: 'muse-happy', projectRoot: root, prompt: 'Say hi',
    onDelta: delta => happyDeltas.push(delta), onSession: session => sessions.push(session), confirm: async () => true });
  assert.equal(happyResult.state, 'COMPLETED', happyResult.error);
  assert.equal(happyResult.content, 'MSP_RUNTIME_OK', 'item/delta text becomes the answer without duplication from item/completed');
  assert.equal(happyResult.reasoning, 'MSP_THINKING');
  assert.equal(happyResult.toolCalls.length, 1);
  assert.equal(happyResult.toolCalls[0].name, 'write_file');
  assert.deepEqual(happyResult.toolCalls[0].args, { path: 'math.cjs' });
  assert.equal(happyResult.toolCalls[0].ok, true);
  assert.equal(happyResult.usage.total_tokens, 15);
  assert.equal(sessions[0].protocol, 'msp');
  assert.equal(sessions[0].permissions.enforcement, 'msp-requests');
  assert.match(happyResult.backendSession.sessionId, UUIDV7);
  assert.equal(happyDeltas.filter(delta => delta.kind === 'content').length, 2,
    'item/delta streams progressively and item/completed does not re-emit the same text');
  assert(happyDeltas.some(delta => delta.kind === 'tool' && delta.toolCalls[0].ok === null));
  assert(happyDeltas.some(delta => delta.kind === 'tool_result' && delta.toolCalls[0].ok === true));
  assert(happyDeltas.some(delta => delta.kind === 'reasoning'));
  const happyCalls = happy.calls();
  const initialize = happyCalls.find(call => call.in?.method === 'initialize');
  assert.equal(initialize.in.params.clientInfo.name, 'codenode');
  assert(happyCalls.some(call => call.in?.method === 'initialized'), 'the MSP handshake is completed with an initialized notification');
  const started = happyCalls.find(call => call.in?.method === 'session/start');
  const startedSessionId = started.in.params.sessionId;
  assert.equal(happyResult.backendSession.sessionId, startedSessionId, 'the session handle comes from session/start');
  assert.match(started.in.params.commandId, UUIDV7, 'MSP commandId must be a UUIDv7');
  assert.match(started.in.params.sessionId, UUIDV7);
  assert.equal(started.in.params.workspaceRoot, root);
  assert.equal(Object.hasOwn(started.in.params, 'approvalMode'), false, 'workspace-write never pre-authorises the Muse session');
  const turn = happyCalls.find(call => call.in?.method === 'turn/start');
  assert.deepEqual(turn.in.params.input, [{ type: 'text', text: 'Say hi' }]);
  assert.equal(turn.in.params.ifBusy, 'queue');
  assert.equal(turn.in.params.displayText, 'Say hi');
  console.log('MUSE BACKEND STAGE: turn lifecycle');

  const approve = fixtureBackend('approve.jsonl', { FIXTURE_MSP_PERMISSION: '1' });
  const approveDeltas = []; let asked = 0;
  const approveResult = await approve.port.submit({ id: 'muse-approve', projectRoot: root, prompt: 'Write',
    onDelta: delta => approveDeltas.push(delta), confirm: async () => { asked++; return true; } });
  assert.equal(approveResult.state, 'COMPLETED', approveResult.error);
  assert.equal(asked, 1);
  const approveCalls = approve.calls();
  const decide = approveCalls.find(call => call.in?.method === 'approval/decide');
  assert.equal(decide.in.params.choiceId, 'allow_once', 'an approval never escalates to a session or provider-persistent policy');
  assert.deepEqual(decide.in.params.requirementId, { approvalId: 'approval-1', sourceIndex: 0 });
  assert(approveDeltas.some(delta => delta.kind === 'backend_approval' && delta.phase === 'requested'));
  assert(approveDeltas.some(delta => delta.kind === 'backend_approval' && delta.phase === 'resolved' && delta.accepted === true));
  assert(approveCalls.some(call => call.reply?.id === 900 && JSON.stringify(call.reply.result) === '{}'),
    'the server-to-client approval request only receives a delivery receipt');
  console.log('MUSE BACKEND STAGE: approval');

  const readonly = fixtureBackend('readonly.jsonl', { FIXTURE_MSP_PERMISSION: '1' }, { sandbox: 'read-only' });
  const readonlyDeltas = []; let readonlyAsked = 0;
  const readonlyResult = await readonly.port.submit({ id: 'muse-readonly', projectRoot: root, prompt: 'Write',
    onDelta: delta => readonlyDeltas.push(delta), confirm: async () => { readonlyAsked++; return true; } });
  assert.equal(readonlyResult.state, 'COMPLETED', readonlyResult.error);
  assert.equal(readonlyAsked, 0, 'read-only must not surface an approval dialog');
  assert.equal(readonly.calls().find(call => call.in?.method === 'approval/decide').in.params.choiceId, 'deny');
  assert(readonlyDeltas.some(delta => delta.kind === 'backend_approval' && delta.phase === 'denied' && delta.accepted === false));
  console.log('MUSE BACKEND STAGE: read-only');

  const input = fixtureBackend('input.jsonl', { FIXTURE_MSP_INPUT: '1' });
  let question = ''; let options = [];
  const inputResult = await input.port.submit({ id: 'muse-input', projectRoot: root, prompt: 'Ask',
    askUser: async (text, list) => { question = text; options = list; return 'Postgres'; }, confirm: async () => false });
  assert.equal(inputResult.state, 'COMPLETED', inputResult.error);
  assert.match(question, /Which database\?/);
  assert.deepEqual(options, ['Postgres', 'SQLite'], 'single-choice questions offer the declared labels');
  assert.deepEqual(input.calls().find(call => call.in?.method === 'userInput/answer').in.params.answers,
    [{ questionId: 'db_choice', selectedLabel: 'Postgres' }]);
  assert(input.calls().some(call => call.reply?.id === 901 && JSON.stringify(call.reply.result) === '{}'));
  console.log('MUSE BACKEND STAGE: supplementary input');

  const cancel = fixtureBackend('cancel.jsonl', { FIXTURE_MSP_HOLD: '1' });
  const controller = new AbortController(); const cancelDeltas = [];
  const pending = cancel.port.submit({ id: 'muse-cancel', projectRoot: root, prompt: 'Hold', signal: controller.signal,
    onDelta: delta => cancelDeltas.push(delta), confirm: async () => false });
  await waitFor(() => cancelDeltas.some(delta => delta.kind === 'content'), 'the Muse fixture never streamed');
  controller.abort();
  const cancelResult = await pending;
  assert.equal(cancelResult.state, 'CANCELLED', JSON.stringify(cancelResult));
  assert.equal(cancelResult.aborted, true);
  assert(cancel.calls().some(call => call.in?.method === 'turn/cancel'), 'cancelling the turn goes through turn/cancel');
  // MSP has no session/close: the host is released by closing stdin (EOF).
  await cancel.port.close();
  assert.equal(cancel.port.status().state, 'closed');
  console.log('MUSE BACKEND STAGE: cancellation');

  console.log('MUSE BACKEND: PASS (MSP handshake, session/turn lifecycle, streamed items, approval, input, cancellation, non-ACP identity)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const port of ports) await port.close().catch(() => {});
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-muse-')) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
