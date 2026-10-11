'use strict';
// Deterministic Muse Session Protocol (MSP) fixture: NDJSON JSON-RPC 2.0 over
// stdio, mirroring the shapes in the MSP transcripts (handshake, session/start,
// turn/start, item stream, approval and userInput round trips, turn/cancel).
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const logPath = process.env.FIXTURE_MSP_LOG;
const log = entry => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); };
const emit = (method, params) => { send({ jsonrpc: '2.0', method, params }); log({ out: method, params }); };
let sessionId = '';
let turnId = '';
let phase = 'idle';
const AGENT_ITEM = 'item-agent-1';
const TOOL_ITEM = 'item-tool-1';
const REASON_ITEM = 'item-reason-1';

function finishTurn(terminal) {
  if (phase === 'held' && terminal === 'completed') return;
  emit('turn/completed', { sessionId, viewCursor: 'v:20', turnId, terminal,
    ...(terminal === 'completed' ? { durationMs: 12, usage: { inputTokens: 11, outputTokens: 4, cachedTokens: 0, reasoningTokens: 2 } } : {}) });
  phase = 'done';
}
function requestApproval() {
  phase = 'permission';
  const params = { sessionId, viewCursor: 'v:12', approvalId: 'approval-1', turnId, itemId: TOOL_ITEM, toolCallId: 'call-1',
    toolName: 'write_file', rawArgs: '{"path":"math.cjs"}', subject: { kind: 'fileAccess', toolName: 'write_file', path: 'math.cjs', access: 'write' },
    currentRequirementId: { approvalId: 'approval-1', sourceIndex: 0 }, protectedWrite: false, judgeEscalated: false,
    availableChoices: [
      { choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
      { choiceId: 'allow_session', label: 'Allow for this session', decision: 'approvedForSession', scope: 'session', rulePreview: 'write math.cjs' },
      { choiceId: 'deny', label: 'Reject', decision: 'abort', scope: 'once' },
    ] };
  emit('approval/requested', params);
  // The same ask also arrives as a server-to-client request that only needs a receipt.
  send({ jsonrpc: '2.0', id: 900, method: 'approval/request', params });
}
function requestInput() {
  phase = 'input';
  const params = { sessionId, viewCursor: 'v:13', userInputId: 'input-1', turnId, itemId: TOOL_ITEM, toolCallId: 'call-2',
    toolName: 'request_user_input', autoResolutionMs: 120000,
    questions: [{ id: 'db_choice', header: 'Database', question: 'Which database?', selection: { mode: 'single' },
      options: [{ label: 'Postgres', description: 'Matches the other services.' }, { label: 'SQLite', description: 'Zero-ops, single node only.' }] }] };
  emit('userInput/requested', params);
  send({ jsonrpc: '2.0', id: 901, method: 'userInput/request', params });
}
function afterStream() {
  if (process.env.FIXTURE_MSP_PERMISSION === '1') { requestApproval(); return; }
  if (process.env.FIXTURE_MSP_INPUT === '1') { requestInput(); return; }
  finishTurn('completed');
}
function startStream(commandId) {
  emit('turn/started', { sessionId, viewCursor: 'v:2', turnId, commandId });
  emit('item/started', { sessionId, viewCursor: 'v:3', item: { itemId: AGENT_ITEM, kind: 'agentMessage', turnId, revision: 1, status: 'inProgress', text: '' } });
  emit('item/delta', { sessionId, viewCursor: 'v:4', itemId: AGENT_ITEM, field: 'text', delta: 'MSP_' });
  emit('item/delta', { sessionId, viewCursor: 'v:5', itemId: AGENT_ITEM, field: 'text', delta: 'RUNTIME_OK' });
  emit('item/completed', { sessionId, viewCursor: 'v:6', item: { itemId: AGENT_ITEM, kind: 'agentMessage', turnId, revision: 2, status: 'completed', text: 'MSP_RUNTIME_OK' } });
  emit('item/started', { sessionId, viewCursor: 'v:7', item: { itemId: TOOL_ITEM, kind: 'toolCall', turnId, revision: 1, status: 'inProgress', tool: 'write_file', callId: 'call-1', args: '{"path":"math.cjs"}' } });
  emit('item/completed', { sessionId, viewCursor: 'v:8', item: { itemId: TOOL_ITEM, kind: 'toolCall', turnId, revision: 2, status: 'completed', tool: 'write_file', callId: 'call-1', args: '{"path":"math.cjs"}', visibleOutput: 'math.cjs updated\n' } });
  emit('item/started', { sessionId, viewCursor: 'v:9', item: { itemId: REASON_ITEM, kind: 'reasoning', turnId, revision: 1, status: 'inProgress' } });
  emit('item/delta', { sessionId, viewCursor: 'v:10', itemId: REASON_ITEM, field: 'text', delta: 'MSP_THINKING' });
  emit('item/completed', { sessionId, viewCursor: 'v:11', item: { itemId: REASON_ITEM, kind: 'reasoning', turnId, revision: 2, status: 'completed' } });
  if (process.env.FIXTURE_MSP_HOLD === '1') { phase = 'held'; return; }
  afterStream();
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log({ in: message });
  const result = value => send({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') result({ serverInfo: { name: 'muse-session-server', version: '1.4.4-fixture' }, userAgent: 'fixture',
    museHome: '/tmp/muse', platformFamily: 'unix', platformOs: 'linux', schema: { version: 1, fingerprint: 'sha256:' + '0'.repeat(64) },
    grantedCapabilities: [], experimentalApi: false, sessionDurability: 'durable' });
  else if (message.method === 'initialized') { /* notification */ }
  else if (message.method === 'session/start' || message.method === 'session/resume') {
    sessionId = message.params.sessionId || 'msp-fixture';
    result({ session: { sessionId, status: 'idle', turnCount: 0, path: '/tmp/muse/session.jsonl', workspaceRoot: message.params.workspaceRoot || null,
      providerId: 'muse', modelId: 'muse-fixture', approvalMode: { mode: 'promptUnmatched', source: 'startup', lastCommandId: null },
      forkedFrom: null, activeTurnId: null }, viewCursor: 'v:1',
      ...(message.method === 'session/resume' ? { history: { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' }, pendingRequests: [] } : {}) });
  } else if (message.method === 'turn/start') {
    turnId = 'turn-fixture';
    result({ commandId: message.params.commandId, status: 'accepted', turnId, startedNewTurn: true, disposition: 'started' });
    // Stream in a later tick so the client has already recorded the turn handle
    // from the acknowledgement before any item arrives.
    setTimeout(() => startStream(message.params.commandId), process.env.FIXTURE_MSP_HOLD === '1' ? 20 : 0);
  } else if (message.method === 'approval/decide') {
    result({ commandId: message.params.commandId, status: 'accepted', approvalId: message.params.approvalId, terminal: true });
    if (phase === 'permission') { if (process.env.FIXTURE_MSP_INPUT === '1') requestInput(); else { phase = 'decided'; finishTurn('completed'); } }
  } else if (message.method === 'userInput/answer' || message.method === 'userInput/cancel') {
    result({ commandId: message.params.commandId, status: 'accepted', userInputId: message.params.userInputId });
    if (phase === 'input') finishTurn('completed');
  } else if (message.method === 'turn/cancel') {
    result({ status: 'accepted' });
    finishTurn('cancelled');
  } else log({ reply: message });
});
