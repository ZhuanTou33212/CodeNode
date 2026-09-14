'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { EventEmitter } = require('events');
async function main() {
  const { AgentToolContext } = require('../electron/tools/context.cjs');
  assert.strictEqual(await new AgentToolContext({}).confirm('HIGH', 'write', ''), false);
  const cancelled = new AbortController();
  const ctx = new AgentToolContext({ signal: cancelled.signal, confirm: async () => { cancelled.abort(); return true; } });
  assert.strictEqual(await ctx.confirm('WRITE', 'write', ''), false);
  const ipcMain = new EventEmitter();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/tools/bridge.cjs'), 'utf8'), {
    module, process: { env: {} }, setTimeout, clearTimeout,
    require: name => { assert.strictEqual(name, 'electron'); return { ipcMain }; },
  });
  const events = [];
  const sender = { id: 1, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) };
  const controller = new AbortController();
  const bridge = module.exports.makeBridge(sender, controller.signal);
  const waiting = bridge.confirm('HIGH', 'test', '');
  const id = events[0].payload.id;
  ipcMain.emit('tools:response', { sender: { id: 2 } }, { id, result: { ok: true } });
  controller.abort();
  assert.ok(!(await waiting), 'foreign response must not authorize operation');
  assert.ok(events.some(event => event.payload.type === 'cancel' && event.payload.id === id));
  assert.strictEqual(ipcMain.listenerCount('tools:response'), 0);
  assert.ok(!(await bridge.confirm('HIGH', 'closed', '')));
  const second = module.exports.makeBridge(sender);
  const next = second.confirm('HIGH', 'test', '');
  second.cleanup();
  assert.ok(!(await next));
  assert.strictEqual(ipcMain.listenerCount('tools:response'), 0);
  console.log('BRIDGE CANCELLATION: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
