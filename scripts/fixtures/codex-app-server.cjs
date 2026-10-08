'use strict';
// Deterministic protocol peer. Real stdin/stdout transport and file effects;
// never claims to validate a live model's decisions or platform sandbox.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const file = path.join(process.cwd(), '.codenode', 'fixture-thread.json');
let thread = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: 'thread-fixture', cwd: process.cwd(), turns: [] };
let awaiting = null;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const persist = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(thread)); };
const notify = (method, params) => send({ method, params: { threadId: thread.id, ...params } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(path.join(path.dirname(file), 'fixture-rpc.jsonl'), JSON.stringify(m) + '\n');
  const answer = result => send({ id: m.id, result });
  if (m.method === 'initialize') answer({ userAgent: 'fixture/anything' });
  else if (m.method === 'account/read') answer({ account: { type: 'chatgpt' } });
  else if (m.method === 'windowsSandbox/readiness') answer({ status: 'ready' });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') answer({ thread, model: 'fixture-model' });
  else if (m.method === 'thread/read') answer({ thread });
  else if (m.method === 'turn/start') {
    const turn = { id: 'turn-' + (thread.turns.length + 1), status: 'inProgress', items: [] };
    thread.turns.push(turn); persist();
    notify('turn/started', { turn }); answer({ turn });
    const text = m.params.input[0].text;
    // Install the turn handle before its first approval request can arrive.
    // Sending both in the same stdout chunk can race turnId assignment on
    // slower POSIX runners when the client cancels from the approval callback.
    setImmediate(() => {
      if (text.includes('disconnect-test')) { setTimeout(() => process.exit(1), 20); return; }
      awaiting = { turn, text };
      const edit = text.includes('resume-edit');
      send({ id: 'approval-' + turn.id, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        params: { kind: 'command', threadId: thread.id, turnId: turn.id, itemId: 'item-' + turn.id, cwd: process.cwd(), startedAtMs: Date.now(),
          command: edit ? undefined : 'node denied.cjs', reason: 'fixture request' } });
    });
  } else if (m.method === 'turn/interrupt') {
    const turn = thread.turns.find(t => t.id === m.params.turnId);
    turn.status = 'interrupted'; persist(); answer({}); notify('turn/completed', { turn });
  } else if (!m.method && awaiting && m.id === 'approval-' + awaiting.turn.id) {
    const { turn, text } = awaiting;
    if (m.result?.decision === 'accept' && text.includes('resume-edit')) fs.writeFileSync('math.cjs', 'module.exports = (a,b) => a + b;\n');
    else if (m.result?.decision === 'accept') fs.writeFileSync('denied.txt', 'unexpected');
    notify('item/agentMessage/delta', { turnId: turn.id, itemId: 'reply-' + turn.id, delta: text.includes('resume-edit') ? '修改完成' : '操作已拒绝' });
    notify('thread/tokenUsage/updated', { turnId: turn.id, tokenUsage: { total: { inputTokens: thread.turns.length * 10,
      outputTokens: thread.turns.length * 3, totalTokens: thread.turns.length * 13, cachedInputTokens: 0 } } });
    if (!text.includes('interrupt-test')) {
      turn.status = 'completed'; persist(); notify('turn/completed', { turn });
    }
  }
});
