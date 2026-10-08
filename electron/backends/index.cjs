'use strict';
const { CodexBackend } = require('./codex.cjs');

class BuiltinBackend {
  constructor() { this.controller = null; this.result = null; this.listener = (delta) => {}; }
  async capabilities() {
    return { backend: 'builtin', available: true, conversation: true, events: true, approvals: true,
      interrupt: true, resume: true, customTools: true, hardBudget: true, usage: true };
  }
  start(input) {
    this.controller = input.controller || new AbortController();
    const abort = () => this.controller?.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const onDelta = input.onDelta || this.listener;
    this.result = require('../agent.cjs').runAgentChat({ ...input, signal: this.controller.signal, onDelta })
      .finally(() => input.signal?.removeEventListener('abort', abort));
    return this.result;
  }
  events(onDelta) { this.listener = onDelta; return () => { this.listener = () => {}; }; }
  respondToApproval(request, accepted) { return request.resolve(accepted === true); }
  async interrupt() { this.controller?.abort(); return this.result; }
  resume(input) { return this.start(input); }
}
function createBackend(name, settings, deps) {
  if (name === 'builtin') return new BuiltinBackend();
  if (name === 'codex') return new CodexBackend(settings, deps);
  throw new Error('未知 Agent 后端：' + name);
}
module.exports = { createBackend, BuiltinBackend };
