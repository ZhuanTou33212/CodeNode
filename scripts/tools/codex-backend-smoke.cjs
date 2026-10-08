'use strict';
// Opt-in live model check; does not run in offline CI. Uses installed Codex auth.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { runExternal } = require('../../electron/backends/runExternal.cjs');
const backendConfig = require('../../config/agent.backends.json');
const agent = require('../../electron/agent.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-codex-live-'));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90000);
const events = [];
fs.writeFileSync(path.join(root, 'message.txt'), 'CODENODE_P0_LIVE_7391\n');
runExternal({ projectRoot: root, requestId: 'live-readonly', sessionId: 'live-session',
  settings: { ...backendConfig.defaults, backend: 'codex' }, cfg: agent.loadConfig(null), signal: controller.signal,
  reasoningEffort: 'low',
  prompt: 'Read message.txt in the current directory. Return its exact content. Do not modify any file. Do not start subagents.',
  confirm: async () => false, onDelta: event => { events.push(event.kind); if (event.kind !== 'content' && event.kind !== 'reasoning') console.log('event:', event.kind); if (event.kind === 'backend_approval' && event.phase === 'requested') fs.writeFileSync(path.join(__dirname, '../../.cache/p0-readonly-approval.json'), JSON.stringify(require('../../electron/redaction.cjs').redact(event), null, 2)); },
  onProtocol: method => console.log('protocol:', method),
}).then(result => {
  console.log(JSON.stringify({ ok: result.ok, state: result.state, reply: result.reply, error: result.error,
    stopReason: result.stopReason, usage: result.usage, changes: result.changes, events }));
  assert.equal(result.ok, true); assert.match(result.reply, /CODENODE_P0_LIVE_7391/);
  assert.equal(result.changes.files.length, 0);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout);
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('codenode-codex-live-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
