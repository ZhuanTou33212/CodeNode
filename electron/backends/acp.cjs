'use strict';
const crypto = require('crypto');
const { StdioRpc } = require('./stdioRpc.cjs');
const { redact } = require('../redaction.cjs');
const config = require('../../config/agent.backends.json');

const names = { hermes: 'Hermes Agent', opencode: 'OpenCode', openclaw: 'OpenClaw' };
class AcpBackend {
  constructor(settings, deps = {}) {
    this.settings = settings; this.deps = deps; this.rpc = null; this.listener = (delta) => {};
    this.sessionId = null; this.settle = null; this.timer = undefined; this.stopping = false;
    this.capabilityInfo = null; this.messages = new Map(); this.tools = new Map(); this.toolCalls = [];
    this.diffText = ''; this.cwd = null;
  }
  events(listener) { this.listener = listener; }
  emit(delta) { this.listener(delta); }
  command() {
    const command = this.settings.executable || config.commands[this.settings.backend];
    const args = this.settings.args?.length ? this.settings.args : config.defaultArgs[this.settings.backend] || [];
    return { command, args: [...args] };
  }
  async connect(cwd) {
    const { command, args } = this.command();
    this.rpc = new (this.deps.StdioRpc || StdioRpc)(command, args, cwd, this.deps);
    this.rpc.on('notification', message => this.notification(message));
    this.rpc.on('request', message => { void this.permission(message).catch(error => this.fail(error)); });
    this.rpc.on('disconnect', error => this.fail(error));
    const result = await this.rpc.request('initialize', { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'codenode', title: 'CodeNode', version: require('../../package.json').version } });
    if (result.protocolVersion !== 1) throw new Error('Agent ACP 协议版本不兼容：' + result.protocolVersion);
    this.capabilityInfo = result.agentCapabilities || {};
    this.agentInfo = result.agentInfo || {};
    return result;
  }
  async capabilities(cwd) {
    try {
      await this.connect(cwd);
      return { backend: this.settings.backend, available: true, authenticated: null, protocol: 'ACP', protocolVersion: 1,
        conversation: true, events: true, approvals: true, interrupt: true,
        resume: this.capabilityInfo.loadSession === true || !!this.capabilityInfo.sessionCapabilities?.resume,
        usage: false, hardBudget: false, customTools: false, permissions: this.settings.sandbox, proxySource:this.rpc?.proxySource,
        cost: 'unknown', version: this.agentInfo.version || 'unknown' };
    } catch (error) { return { backend: this.settings.backend, available: false, error: error.message }; }
    finally { await this.rpc?.close(); this.rpc = null; }
  }
  async start(input) {
    if(input.onDelta)this.events(input.onDelta);
    this.input = input; this.cwd = input.projectRoot; this.messages = new Map(); this.tools = new Map(); this.toolCalls = []; this.diffText = ''; this.stopping = false;
    const abort = () => { void this.interrupt(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true, stopReason: 'cancelled' };
      await this.connect(input.projectRoot);
      // OpenClaw ACP bridge rejects the mcpServers field entirely, even when
      // empty; other ACP agents accept an empty list for session lifecycle calls.
      const sessionMcp = this.settings.backend === 'openclaw' ? {} : { mcpServers: [] };
      if (input.backendSession?.sessionId) {
        const canLoad = this.capabilityInfo.loadSession === true;
        const canResume = !!this.capabilityInfo.sessionCapabilities?.resume;
        if (canLoad) await this.rpc.request('session/load', { sessionId: input.backendSession.sessionId, cwd: input.projectRoot, ...sessionMcp });
        else if (canResume) await this.rpc.request('session/resume', { sessionId: input.backendSession.sessionId, cwd: input.projectRoot, ...sessionMcp });
        else throw new Error(this.settings.backend + ' 未声明 ACP 会话恢复能力，不能恢复原执行');
        this.sessionId = input.backendSession.sessionId;
      } else {
        const created = await this.rpc.request('session/new', { cwd: input.projectRoot, ...sessionMcp });
        if (!created?.sessionId) throw new Error('ACP session/new 未返回会话编号');
        this.sessionId = created.sessionId;
      }
      input.onSession?.({ backend: this.settings.backend, protocol: 'acp', protocolVersion: 1,
        sessionId: this.sessionId, cwd: input.projectRoot, model: this.settings.model || null,
        adapterSettings:this.settings,
        permissions: { sandbox: this.settings.sandbox, network: 'agent-managed' } });
      if (this.stopping || input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true, stopReason: 'cancelled' };
      const terminal = new Promise(resolve => { this.settle = resolve; });
      this.emit({ kind: 'state', state: 'RUNNING', previous: null, sequence: 0 });
      const prior = !input.backendSession && input.history?.length ?
        '此前对话（仅作上下文）：\n' + input.history.map(item => item.role + ': ' + item.content).join('\n') + '\n\n' : '';
      const text = prior + String(input.prompt || '') + (input.canvasSummary ? '\n\n当前画布上下文：\n' + input.canvasSummary : '');
      const result = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        Number(this.settings.turnTimeoutMs) > 0 ? Number(this.settings.turnTimeoutMs) : 10 * 60 * 1000);
      if (this.settle) this.finish(result?.stopReason || 'end_turn');
      return await terminal;
    } catch (error) {
      return { content: this.content(), reasoning: '', toolCalls: this.toolCalls, state: 'FAILED', error: error.message,
        ...(error.code != null ? { backendErrorCode: error.code } : {}), ...(error.data != null ? { backendErrorDetails: redact(error.data) } : {}),
        ...(error.method ? { backendErrorMethod: error.method } : {}),
        ...(this.rpc?.stderrTail?.length ? { backendStderr: redact(this.rpc.stderrTail.join('\n')).slice(-4000) } : {}),
        stopReason: this.sessionId ? 'backend_result_unknown' : 'backend_start_failed' };
    } finally {
      this.settle = null; clearTimeout(this.timer); input.signal?.removeEventListener('abort', abort);
      await this.rpc?.close(); this.rpc = null;
    }
  }
  resume(input) { return this.start(input); }
  content() { return [...this.messages.values()].join(''); }
  finish(stopReason) {
    if (!this.settle) return;
    const settle = this.settle; this.settle = null; clearTimeout(this.timer);
    const aborted = stopReason === 'cancelled';
    settle({ content: this.content(), reasoning: '', toolCalls: this.toolCalls, usage: null,
      state: aborted ? 'CANCELLED' : ['end_turn', 'completed', 'max_tokens'].includes(stopReason) ? 'COMPLETED' : 'FAILED',
      aborted, error: null, stopReason, backendSession: { sessionId: this.sessionId } });
  }
  fail(error) { if (this.settle) { const done = this.settle; this.settle = null; done({ content: this.content(), toolCalls: this.toolCalls, state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' }); } }
  notification(message) {
    const p = message.params || {};
    if (p.sessionId && p.sessionId !== this.sessionId) return;
    if (message.method === 'session/update') {
      const update = p.update || {};
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        const id = update.messageId || 'assistant'; this.messages.set(id, (this.messages.get(id) || '') + update.content.text);
        this.emit({ kind: 'content', text: update.content.text });
      } else if (update.sessionUpdate === 'tool_call') {
        this.tools.set(update.toolCallId, update);
        this.emit({ kind: 'tool', toolCalls: [{ name: update.name || 'agent_tool', callId: update.toolCallId,
          args: redact(update.rawInput), result: null, ok: null }] });
      } else if (update.sessionUpdate === 'tool_call_update') {
        const previous = this.tools.get(update.toolCallId) || {};
        const merged = { ...previous, ...update }; this.tools.set(update.toolCallId, merged);
        if (update.content) for (const block of update.content) if (block.type === 'diff') this.diffText += `--- ${block.path}\n${block.oldText || ''}\n+++ ${block.path}\n${block.newText || ''}\n`;
        if (update.status && ['completed', 'failed'].includes(update.status)) {
          const record = { name: merged.name || 'agent_tool', callId: update.toolCallId,
            ok: update.status === 'completed', args: redact(merged.rawInput), data: { content: redact(update.content || []), status: update.status } };
          this.toolCalls.push(record); this.emit({ kind: 'tool_result', toolCalls: [record] });
        }
      }
    } else if (message.method === 'session/info_update') this.emit({ kind: 'backend_info', info: redact(p) });
  }
  async permission(message) {
    const p = message.params || {}; if (p.sessionId !== this.sessionId) { await this.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } }); return; }
    const subject = p.subject || {}; const toolCall = p.toolCall || {};
    let option;
    if (this.settings.sandbox === 'read-only') {
      // ACP subject/tool kinds are agent-supplied metadata. They cannot authorize
      // filesystem or command access on their own, so read-only mode rejects every
      // permission request and lets the remote runtime continue with allowed reads.
      option = p.options?.find(item => item.kind === 'reject_once' || item.kind === 'reject_always');
      if (!option) return this.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } });
    } else if (!this.stopping) {
      const accepted = await this.input.confirm('HIGH', this.settings.backend + ' ACP 权限请求',
        JSON.stringify({ title: p.title, description: p.description, subject: redact(subject), toolCall: redact(toolCall), options: p.options }, null, 2));
      if (accepted) option = p.options?.find(item => item.kind === 'allow_once') || option;
      else option = p.options?.find(item => item.kind === 'reject_once') || option;
    } else option = p.options?.find(item => item.kind === 'reject_once' || item.kind === 'reject_always');
    if (option?.kind === 'allow_always' || option?.kind === 'reject_always') option = p.options?.find(item => item.kind === (option.kind === 'allow_always' ? 'allow_once' : 'reject_once')) || option;
    await this.rpc.respond(message.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
  }
  async interrupt() {
    this.stopping = true; if (!this.rpc || !this.sessionId || !this.settle) return;
    this.rpc.send({ method: 'session/cancel', params: { sessionId: this.sessionId } }).catch(error => this.fail(error));
    clearTimeout(this.timer); this.timer = setTimeout(() => this.fail(new Error('ACP 中断终态未获确认')), config.interruptTimeoutMs);
  }
}
module.exports = { AcpBackend };
