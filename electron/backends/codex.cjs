'use strict';
const fs = require('fs');
const path = require('path');
const { RpcClient, executableVersion } = require('./rpc.cjs');
const config = require('../../config/agent.backends.json');
const { redact } = require('../redaction.cjs');
const { resolveInRoot } = require('../tools/impl/shared.cjs');
const { launchEnvironment } = require('./network.cjs');

class CodexBackend {
  constructor(settings, deps = {}) {
    this.settings = settings; this.deps = deps; this.rpc = null;
    this.threadId = null; this.turnId = null; this.stopping = false;
    this.approvals = new Map(); this.listener = (delta) => {};
    this.settle = null; this.timer = undefined; this.version = null;
    this.messages = new Map(); this.toolCalls = []; this.reasoning = ''; this.usage = null;
    this.usageTotal = null;
  }
  events(listener) { this.listener = listener; return () => { this.listener = () => {}; }; }
  emit(delta) { this.listener(delta); }
  async connect(cwd) {
    this.version = await (this.deps.executableVersion || executableVersion)(this.settings.executable);
    if (!config.supportedProtocolVersions.includes(this.version)) throw new Error('Codex 协议版本未验证，支持 ' + config.supportedProtocolVersions.join(' / ') + '，实际 ' + this.version);
    const network = await (this.deps.launchEnvironment || launchEnvironment)();
    this.proxySource = network.proxySource;
    this.rpc = new (this.deps.RpcClient || RpcClient)(this.settings.executable, cwd, { env: network.env });
    this.rpc.on('notification', message => this.notification(message));
    this.rpc.on('request', message => { void this.approval(message).catch(error => this.fail(error)); });
    this.rpc.on('disconnect', error => this.fail(error));
    const initialized = await this.rpc.request('initialize', {
      clientInfo: { name: 'codenode', title: 'CodeNode', version: require('../../package.json').version },
      capabilities: { experimentalApi: false },
    });
    this.codexHome = initialized.codexHome || null;
    this.rpc.send({ method: 'initialized', params: {} });
    return initialized;
  }
  async capabilities(cwd) {
    try {
      await this.connect(cwd);
      const account = await this.rpc.request('account/read', { refreshToken: false });
      let commandSandbox = null;
      if (process.platform === 'win32') {
        let readiness = 'unknown';
        try { readiness = (await this.rpc.request('windowsSandbox/readiness', {})).status; } catch {}
        let lastSetupError = null;
        if (this.codexHome) try {
          const errorPath = path.join(this.codexHome, '.sandbox', 'setup_error.json');
          if (fs.statSync(errorPath).size <= 8192) {
            const error = JSON.parse(fs.readFileSync(errorPath, 'utf8'));
            lastSetupError = { code: String(error.code || ''), message: String(redact(error.message || '')) };
          }
        } catch {}
        commandSandbox = { readiness, lastSetupError, verified: false };
      }
      return { backend: 'codex', available: true, authenticated: !!account.account,
        protocolVersion: this.version, conversation: true, events: true, approvals: true,
        interrupt: true, resume: true, usage: true, hardBudget: false, customTools: false,
        permissions: this.settings.sandbox, cost: 'unknown', version: this.version, proxySource: this.proxySource, commandSandbox };
    } catch (error) { return { backend: 'codex', available: false, error: error.message }; }
    finally { await this.rpc?.close(); this.rpc = null; }
  }
  policy(cwd) {
    return this.settings.sandbox === 'read-only' ? { type: 'readOnly' } :
      { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  }
  async start(input) {
    if (input.onDelta) this.events(input.onDelta);
    this.input = input;
    this.messages = new Map(); this.reasoning = ''; this.toolCalls = []; this.usage = null;
    this.usageTotal = null;
    this.stopping = false;
    const abort = () => { void this.interrupt(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true };
      await this.connect(input.projectRoot);
      const approvalPolicy = config.approvalPolicies[this.settings.sandbox];
      const params = { cwd: input.projectRoot, approvalPolicy, approvalsReviewer: 'user',
        sandbox: this.settings.sandbox, ...(this.settings.model ? { model: this.settings.model } : {}) };
      let thread;
      if (input.backendSession) {
        if (path.resolve(input.backendSession.cwd) !== path.resolve(input.projectRoot)) throw new Error('后端会话工作目录不匹配');
        // Observe the original handle before allowing another turn. A missing or
        // running turn cannot be turned into permission to replay side effects.
        const observed = await this.rpc.request('thread/read', { threadId: input.backendSession.threadId, includeTurns: true });
        if (observed.thread.status?.type === 'active' || observed.thread.turns?.some(turn => turn.status === 'inProgress')) throw new Error('原 Codex 执行仍在运行，不能重复启动；请先核实原执行状态');
        if (input.backendSession.turnId && !observed.thread.turns?.some(turn => turn.id === input.backendSession.turnId)) {
          throw new Error('原 Codex 执行状态无法核实，停止恢复以避免重复副作用');
        }
        thread = await this.rpc.request('thread/resume', { ...params, threadId: input.backendSession.threadId });
      } else {
        thread = await this.rpc.request('thread/start', { ...params,
          developerInstructions: '你在 CodeNode 中执行一个有界任务。遵循项目规范与用户授权。只修改当前工作目录内本任务需要的文件；完成后报告差异与验证。画布仅作为上下文，本后端未接入画布修改工具。' });
      }
      this.threadId = thread.thread.id;
      const saveSession = () => input.onSession?.({ backend: 'codex', protocolVersion: this.version,
        threadId: this.threadId, turnId: this.turnId, cwd: input.projectRoot, model: thread.model || this.settings.model || null,
        adapterSettings: this.settings,
        usageTotal: this.usageTotal || input.backendSession?.usageTotal || null,
        proxySource: this.proxySource,
        permissions: { approvalPolicy, sandbox: this.settings.sandbox, network: false } });
      this.saveSession = saveSession; saveSession();
      if (this.stopping || input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true };
      const terminal = new Promise(resolve => { this.settle = resolve; });
      this.emit({ kind: 'state', state: 'RUNNING', previous: null, sequence: 0 });
      // History is imported only for a new backend session. Subsequent turns use
      // persisted Codex context, never a second copy of the whole transcript.
      const prior = !input.backendSession && input.history?.length ?
        '此前对话（仅作上下文）：\n' + input.history.map(item => item.role + ': ' + item.content).join('\n') + '\n\n' : '';
      const text = prior + String(input.prompt || '') + (input.canvasSummary ? '\n\n当前画布上下文：\n' + input.canvasSummary : '');
      const started = await this.rpc.request('turn/start', { threadId: this.threadId, cwd: input.projectRoot,
        input: [{ type: 'text', text }], sandboxPolicy: this.policy(input.projectRoot), approvalPolicy, approvalsReviewer: 'user',
        ...(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoningEffort) ? { effort: input.reasoningEffort } : {}) });
      this.turnId = started.turn.id; saveSession();
      if (this.stopping || input.signal?.aborted) void this.interrupt();
      const result = await terminal;
      return result;
    } catch (error) {
      return { content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, usage: this.usage,
        state: 'FAILED', error: error.message, stopReason: this.turnId ? 'backend_result_unknown' : 'backend_start_failed' };
    } finally {
      this.settle = null; clearTimeout(this.timer); this.approvals.clear();
      input.signal?.removeEventListener('abort', abort);
      await this.rpc?.close(); this.rpc = null;
    }
  }
  resume(input) { return this.start(input); }
  content() { return [...(this.messages || new Map()).values()].join('\n'); }
  finish(turn) {
    if (!this.settle) return;
    const settle = this.settle; this.settle = null;
    clearTimeout(this.timer);
    const state = turn.status === 'completed' ? 'COMPLETED' : turn.status === 'interrupted' ? 'CANCELLED' : 'FAILED';
    settle({ content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, usage: this.usage,
      state, aborted: state === 'CANCELLED', error: state === 'FAILED' ? turn.error?.message || 'Codex 执行失败' : null,
      stopReason: turn.status, backendSession: { threadId: this.threadId, turnId: this.turnId } });
  }
  fail(error) {
    if (!this.settle) return;
    const settle = this.settle; this.settle = null;
    settle({ content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, usage: this.usage,
      state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' });
  }
  notification({ method, params: p }) {
    this.input?.onProtocol?.(method);
    if (!p || p.threadId !== this.threadId) return;
    if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
    if (method === 'turn/started') { this.turnId = p.turn.id; this.saveSession?.(); }
    if (method === 'item/agentMessage/delta') {
      this.messages.set(p.itemId, (this.messages.get(p.itemId) || '') + p.delta);
      this.emit({ kind: 'content', text: p.delta });
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.reasoning += p.delta; this.emit({ kind: 'reasoning', text: p.delta });
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage.total;
      const base = this.input.backendSession?.usageTotal || {};
      this.usageTotal = usage;
      this.usage = { prompt_tokens: Math.max(0, usage.inputTokens - (base.inputTokens || 0)),
        completion_tokens: Math.max(0, usage.outputTokens - (base.outputTokens || 0)),
        total_tokens: Math.max(0, usage.totalTokens - (base.totalTokens || 0)),
        prompt_tokens_details: { cached_tokens: Math.max(0, usage.cachedInputTokens - (base.cachedInputTokens || 0)) } };
      this.saveSession?.();
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      this.messages.set(p.item.id, p.item.text);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      if (!item || !['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) return;
      if (method === 'item/started') this.emit({ kind: 'tool', toolCalls: [{ name: item.type, id: item.id, callId: item.id,
        args: { command: item.command || null, changes: item.changes || null } }] });
      else {
        const record = { name: item.type, callId: item.id, ok: item.status === 'completed' && (item.exitCode == null || item.exitCode === 0),
          args: { command: item.command || null, changes: item.changes || null },
          data: { output: item.aggregatedOutput || '', exitCode: item.exitCode, changes: item.changes || null } };
        this.toolCalls.push(record); this.emit({ kind: 'tool_result', toolCalls: [record] });
      }
    } else if (method === 'turn/completed') {
      if (this.turnId && p.turn.id !== this.turnId) return;
      this.turnId = p.turn.id; this.saveSession?.(); this.finish(p.turn);
    } else if (method === 'turn/diff/updated') this.emit({ kind: 'backend_diff', diff: redact(p.diff), turnId: p.turnId });
    else if (method === 'error') this.emit({ kind: 'plan_warning', message: redact(p.error?.message || 'Codex 执行遇到错误'), willRetry: !!p.willRetry });
  }
  async approval(message) {
    const p = message.params || {};
    if (p.threadId !== this.threadId || this.turnId && p.turnId !== this.turnId || this.stopping) {
      this.rpc?.send({ id: message.id, error: { code: -32000, message: 'Inactive execution' } }); return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      this.rpc?.send({ id: message.id, error: { code: -32601, message: 'CodeNode does not support this request' } }); return;
    }
    this.approvals.set(message.id, p);
    this.emit({ ...redact(p), kind: 'backend_approval', phase: 'requested', requestId: message.id, method: message.method });
    const outside = value => value && !resolveInRoot(this.input.projectRoot, value);
    if (outside(p.cwd) || outside(p.grantRoot)) { this.respondToApproval(message.id, false); return; }
    const approved = await this.input.confirm('HIGH', 'Codex ' + (p.command ? '命令审批' : '文件审批'),
      JSON.stringify({ command: p.command, cwd: p.cwd, reason: p.reason, itemId: p.itemId, grantRoot: p.grantRoot }, null, 2));
    this.respondToApproval(message.id, approved === true);
  }
  respondToApproval(id, approved) {
    const p = this.approvals.get(id);
    if (!p || !this.rpc || this.rpc.closed) return false;
    this.approvals.delete(id);
    // Read-only never grants write/root escalation, even if an old dialog is accepted.
    const accept = approved === true && !this.stopping && this.settings.sandbox !== 'read-only';
    this.rpc.respond(id, { decision: accept ? 'accept' : 'decline' });
    this.emit({ kind: 'backend_approval', phase: accept ? 'accepted' : 'denied', requestId: id, itemId: p.itemId });
    return true;
  }
  async interrupt() {
    this.stopping = true;
    if (!this.rpc || !this.threadId || !this.turnId || !this.settle) return;
    for (const id of this.approvals.keys()) this.respondToApproval(id, false);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error('中断终态未获确认，需要核实原执行状态')), config.interruptTimeoutMs);
    try { await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, config.interruptTimeoutMs); }
    catch (error) { this.fail(error); }
  }
}
module.exports = { CodexBackend };
