'use strict';
// Live inference transport check. File/sandbox acceptance remains a separate
// test:backend-live gate; this test must not turn that gate green.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CodexBackend } = require('../../electron/backends/codex.cjs');
const config = require('../../config/agent.backends.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-connection-'));
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90000);
const startedAt = Date.now();
const events = [];
let session;
new CodexBackend(config.defaults).start({ projectRoot: root, signal: controller.signal, reasoningEffort: 'low',
  prompt: 'Reply with exactly CODENODE_CONNECTION_OK. Do not use tools or subagents.',
  confirm: async () => false, onSession: value => { session = value; }, onDelta: event => { events.push(event.kind); },
}).then(result => {
  const report = { ok: result.state === 'COMPLETED' && result.content.trim() === 'CODENODE_CONNECTION_OK',
    scope: 'Real model connection only; not file-command or sandbox acceptance', elapsedMs: Date.now() - startedAt,
    state: result.state, reply: result.content, error: result.error, events, session, usage: result.usage };
  const output = path.join(__dirname, '../../.cache/p0-connection-result.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); assert.equal(report.ok, true);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timer);
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('codenode-connection-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
