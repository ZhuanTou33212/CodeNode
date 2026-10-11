'use strict';
// Muse Code backend: MSP (Muse Session Protocol) over the `muse serve` child's
// stdio. MSP framing is newline-delimited JSON-RPC 2.0, so the shared StdioRpc
// transport is reused; everything above the transport is MSP-specific.
const crypto = require('crypto');
const { StdioRpc } = require('./stdioRpc.cjs');
const { redact } = require('../redaction.cjs');
const config = require('../../config/agent.backends.json');

// MSP requires UUIDv7 for commandId/sessionId; Node only ships UUIDv4.
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = Date.now();
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(ms / 2 ** (8 * (5 - index))) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const ALLOW_DECISIONS = ['approved'];
const DENY_DECISIONS = ['denied', 'deniedPolicyAmendment', 'abort', 'timedOut'];
function scopeRank(choice) { return ({ once: 0, session: 1, localPersistent: 3 })[choice?.scope] ?? 2; }
function parseArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw.slice(0, 4000); }
}
function textContent(text) { return { type: 'text', text: String(text ?? '') }; }

class MuseCodeBackend {
  constructor(settings, deps = {}) {
    this.settings = settings; this.deps = deps; this.rpc = null; this.listener = (_delta) => {};
    this.settle = null; this.turnTimer = undefined; this.interruptTimer = undefined; this.stopping = false;
    this.sessionId = null; this.turnId = null; this.sessionInfo = {}; this.serverInfo = {}; this.capabilityInfo = null;
    this.messages = new Map(); this.items = new Map(); this.toolCalls = []; this.approvals = new Set(); this.userInputs = new Set();
    this.reasoning = ''; this.usage = null; this.cancelRequested = false; this.cancelSent = false; this.cwd = null;
  }
  events(listener) { this.listener = listener; }
  emit(delta) { this.listener(delta); }
  command() {
    const command = this.settings.executable || config.commands[this.settings.backend];
    const args = Array.isArray(this.settings.args) ? this.settings.args : config.defaultArgs[this.settings.backend] || [];
    return { command, args: [...args] };
  }
  // `home` is the per-backend extra path field: for Muse it carries the path the
  // host must see as the workspace root (a Linux path when Muse runs in WSL2).
  workspaceRoot(projectRoot) { return String(this.settings.home || '').trim() || projectRoot; }
  capabilitySnapshot() {
    return { backend: this.settings.backend, protocol: 'MSP', protocolVersion: 1, conversation: true, events: true,
      approvals: true, interrupt: true, resume: this.capabilityInfo?.sessionDurability === 'durable',
      usage: true, hardBudget: false, customTools: false, authMethods: [], permissions: this.settings.sandbox,
      permissionEnforcement: config.permissionEnforcement?.[this.settings.backend] || 'msp-requests',
      proxySource: this.rpc?.proxySource, cost: 'unknown', version: this.serverInfo?.version || 'unknown' };
  }
  async connect(cwd) {
    if (this.rpc) return this.capabilityInfo;
    const { command, args } = this.command();
    this.rpc = new (this.deps.StdioRpc || StdioRpc)(command, args, cwd, { ...this.deps, env: { ...this.deps.env } });
    this.rpc.on('notification', message => { this.notification(message); });
    this.rpc.on('request', message => { void this.dispatch(message); });
    this.rpc.on('disconnect', error => this.fail(error));
    const result = await this.rpc.request('initialize', { clientInfo: { name: 'codenode', title: 'CodeNode', version: require('../../package.json').version }, capabilities: {} });
    if (result?.schema?.version !== 1) throw new Error('Muse Code MSP 协议版本不兼容：' + JSON.stringify(result?.schema?.version ?? null));
    this.serverInfo = result.serverInfo || {};
    this.capabilityInfo = { museHome: result.museHome ?? null, schema: result.schema ?? null,
      sessionDurability: result.sessionDurability ?? null, grantedCapabilities: result.grantedCapabilities || [] };
    await this.rpc.send({ jsonrpc: '2.0', method: 'initialized' });
    return this.capabilityInfo;
  }
  async startSession(projectRoot) {
    const params = { commandId: uuidv7(), workspaceRoot: this.workspaceRoot(projectRoot), sessionId: uuidv7() };
    if (this.settings.model) params.modelId = this.settings.model;
    const created = await this.rpc.request('session/start', params);
    if (!created?.session?.sessionId) throw new Error('MSP session/start 未返回会话编号');
    this.sessionId = created.session.sessionId; this.sessionInfo = created.session;
    this.emit({ kind: 'backend_info', info: redact(created.session) });
  }
  async resumeSession(sessionId) {
    const resumed = await this.rpc.request('session/resume', { commandId: uuidv7(), sessionId });
    if (!resumed?.session?.sessionId) throw new Error('MSP session/resume 未返回会话编号');
    this.sessionId = resumed.session.sessionId; this.sessionInfo = resumed.session;
    this.emit({ kind: 'backend_info', info: redact(resumed.session) });
    // MSP re-sends unresolved approvals and questions right after resume, so the
    // pointers are reported only; the replayed requests drive the real handling.
    const pending = (resumed.pendingRequests || []).map(request => request.kind).filter(Boolean);
    if (pending.length) this.emit({ kind: 'backend_info', info: { muse: '会话恢复后仍有待处理请求', pendingRequests: pending } });
  }
  promptParts(input, text) {
    /** @type {any[]} */
    const parts = [textContent(text)];
    for (const attachment of input.attachments || []) {
      const match = /^data:([^;,]+);base64,(.*)$/.exec(attachment.dataUrl || '');
      if (!match) throw new Error('附件必须是内嵌 base64');
      // MSP currently accepts only inline images; other media types are refused
      // explicitly instead of being silently dropped.
      if (!/^image\//.test(match[1]) || match[1] === 'image/svg+xml') throw new Error('Muse Code 只接收内联图片附件：' + match[1]);
      if (Buffer.byteLength(match[2]) > config.acpLimits.contentBytes) throw new Error('附件超过内容上限');
      parts.push({ type: 'image', mediaType: match[1], base64Data: match[2] });
    }
    return parts;
  }
  async run(input) {
    if (input.onDelta) this.events(input.onDelta);
    this.input = input; this.cwd = input.projectRoot; this.stopping = false; this.settle = null;
    this.sessionId = null; this.turnId = null; this.messages = new Map(); this.items = new Map(); this.toolCalls = [];
    this.approvals = new Set(); this.userInputs = new Set(); this.reasoning = ''; this.usage = null;
    this.cancelRequested = false; this.cancelSent = false;
    const abort = () => { void this.interrupt(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true, stopReason: 'cancelled' };
      await this.connect(input.projectRoot);
      if (input.backendSession?.sessionId) await this.resumeSession(input.backendSession.sessionId);
      else await this.startSession(input.projectRoot);
      input.onSession?.({ backend: this.settings.backend, protocol: 'msp', protocolVersion: 1, sessionId: this.sessionId,
        cwd: input.projectRoot, workspaceRoot: this.workspaceRoot(input.projectRoot), model: this.settings.model || null,
        adapterSettings: this.settings,
        permissions: { sandbox: this.settings.sandbox, network: 'agent-managed', enforcement: 'msp-requests' } });
      if (this.stopping || input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true, stopReason: 'cancelled' };
      const terminal = new Promise(resolve => { this.settle = resolve; });
      this.turnTimer = setTimeout(() => this.fail(new Error('Muse Code 回合超时')), Number(this.settings.turnTimeoutMs) > 0 ? Number(this.settings.turnTimeoutMs) : 10 * 60 * 1000);
      this.emit({ kind: 'state', state: 'RUNNING', previous: null, sequence: 0 });
      const prior = !input.backendSession && input.history?.length ?
        '此前对话（仅作上下文）：\n' + input.history.map(item => item.role + ': ' + item.content).join('\n') + '\n\n' : '';
      const text = prior + String(input.prompt || '') + (input.canvasSummary ? '\n\n当前画布上下文：\n' + input.canvasSummary : '');
      const accepted = await this.rpc.request('turn/start', { sessionId: this.sessionId, commandId: uuidv7(),
        input: this.promptParts(input, text), displayText: String(input.prompt || '').slice(0, 4000), ifBusy: 'queue' });
      this.turnId = accepted?.turnId || null;
      if (this.cancelRequested) this.sendTurnCancel();
      return await terminal;
    } catch (error) {
      return { content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, state: 'FAILED', error: error.message,
        ...(error.code != null ? { backendErrorCode: error.code } : {}), ...(error.data != null ? { backendErrorDetails: redact(error.data) } : {}),
        ...(error.method ? { backendErrorMethod: error.method } : {}),
        ...(this.rpc?.stderrTail?.length ? { backendStderr: redact(this.rpc.stderrTail.join('\n')).slice(-4000) } : {}),
        stopReason: this.sessionId ? 'backend_result_unknown' : 'backend_start_failed' };
    } finally {
      this.settle = null; clearTimeout(this.turnTimer); clearTimeout(this.interruptTimer); this.interruptTimer = undefined;
      this.turnTimer = undefined; input.signal?.removeEventListener('abort', abort);
      await this.close();
    }
  }
  content() { return [...this.messages.values()].join(''); }
  finish(stopReason, detail) {
    if (!this.settle) return;
    const settle = this.settle; this.settle = null;
    clearTimeout(this.turnTimer); clearTimeout(this.interruptTimer); this.interruptTimer = undefined;
    const aborted = stopReason === 'cancelled';
    const done = ['completed', 'end_turn'].includes(stopReason);
    settle({ content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, usage: this.usage,
      state: aborted ? 'CANCELLED' : done ? 'COMPLETED' : 'FAILED', aborted,
      error: !aborted && !done ? 'MSP 回合未完成：' + stopReason + (detail ? '（' + detail + '）' : '') : null,
      stopReason, backendSession: { sessionId: this.sessionId } });
  }
  fail(error) {
    if (!this.settle) return;
    const done = this.settle; this.settle = null;
    clearTimeout(this.turnTimer); clearTimeout(this.interruptTimer); this.interruptTimer = undefined;
    done({ content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' });
  }
  async dispatch(message) {
    try {
      // Server-to-client MSP requests are delivery receipts, not decisions: they
      // must be answered with an empty result or the request stays pending.
      if (message.method === 'approval/request' || message.method === 'userInput/request') {
        await this.rpc.respond(message.id, {});
        if (message.method === 'approval/request') this.approvalRequest(message.params || {});
        else this.userInputRequest(message.params || {});
        return;
      }
      await this.rpc.respondError(message.id, -32601, 'Method not found: ' + message.method);
    } catch (error) { await this.rpc?.respondError(message.id, typeof error.code === 'number' ? error.code : -32603, String(redact(error.message))).catch(() => {}); }
  }
  notification(message) {
    const params = message.params || {};
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) return;
    switch (message.method) {
      case 'turn/started': if (params.turnId) this.turnId = params.turnId; return;
      case 'item/started':
      case 'item/updated':
      case 'item/completed': this.item(message.method, params); return;
      case 'item/delta': this.itemDelta(params); return;
      case 'turn/completed': this.turnCompleted(params); return;
      case 'approval/requested': this.approvalRequest(params); return;
      case 'userInput/requested': this.userInputRequest(params); return;
      case 'session/closed': this.emit({ kind: 'backend_info', info: redact({ muse: 'session closed', reason: params.reason ?? null }) }); return;
      case 'approval/resolved':
      case 'approval/updated':
      case 'userInput/settled':
      case 'turn/retryScheduled':
      case 'turn/retracted':
      case 'turn/unqueued':
      case 'turn/foregroundCompleted':
        this.emit({ kind: 'backend_info', info: redact({ method: message.method, ...params }) }); return;
      default: return;
    }
  }
  item(method, params) {
    const item = params.item;
    if (!item?.itemId) return;
    const previous = this.items.get(item.itemId);
    if (previous && Number(item.revision || 0) < Number(previous.revision || 0)) return;
    this.items.set(item.itemId, item);
    const done = method === 'item/completed';
    if (item.kind === 'agentMessage') {
      if (!done) return;
      const streamed = this.messages.get(item.itemId) || '';
      const final = String(item.text || '');
      // `item/delta` already streamed the text; only append what is genuinely new
      // so a completed item never duplicates the visible answer.
      if (final.startsWith(streamed)) { if (final.length > streamed.length) this.appendContent(item.itemId, final.slice(streamed.length)); }
      else if (!streamed && final) this.appendContent(item.itemId, final);
      return;
    }
    if (item.kind === 'toolCall' || item.kind === 'userShell') {
      const name = item.tool || item.commandText || item.kind;
      if (!done) { this.emit({ kind: 'tool', toolCalls: [{ name, callId: item.callId || item.itemId, args: redact(parseArgs(item.args)), result: null, ok: null }] }); return; }
      const record = { name, callId: item.callId || item.itemId, ok: item.status === 'completed',
        args: redact(parseArgs(item.args)),
        data: { content: redact([textContent(item.visibleOutput || item.failureReason || '')]), status: item.status,
          ...(item.exitCode != null ? { exitCode: item.exitCode } : {}), ...(item.failureReason ? { failureReason: redact(item.failureReason) } : {}) } };
      this.toolCalls = this.toolCalls.filter(call => call.callId !== record.callId); this.toolCalls.push(record);
      this.emit({ kind: 'tool_result', toolCalls: [record] });
      if (item.patchSummary) this.emit({ kind: 'backend_info', info: redact({ patchSummary: item.patchSummary, patchRef: item.patchRef ?? null }) });
      return;
    }
    if (done) this.emit({ kind: 'backend_info', info: redact({ museItem: item.kind, status: item.status, summary: item.finalSummary ?? item.text ?? null }) });
  }
  itemDelta(params) {
    const item = this.items.get(params.itemId);
    const field = params.field || 'text';
    const delta = String(params.delta ?? '');
    if (!delta) return;
    if (item?.kind === 'agentMessage' && field === 'text') { this.appendContent(params.itemId, delta); return; }
    if (item?.kind === 'reasoning') { this.reasoning += delta; this.emit({ kind: 'reasoning', text: delta }); return; }
    if (item?.kind === 'toolCall' || item?.kind === 'userShell') {
      if (field === 'output') this.emit({ kind: 'backend_content', source: 'tool', callId: item.callId || item.itemId, content: textContent(delta) });
      return;
    }
    this.emit({ kind: 'backend_info', info: redact({ method: 'item/delta', itemKind: item?.kind ?? null, field, delta: delta.slice(0, 2000) }) });
  }
  appendContent(itemId, text) {
    if (!text) return;
    this.messages.set(itemId, (this.messages.get(itemId) || '') + text);
    this.emit({ kind: 'content', text });
  }
  turnCompleted(params) {
    const terminal = String(params?.terminal || '');
    const cancelled = this.stopping || /cancel/i.test(terminal);
    const stopReason = cancelled ? 'cancelled' : terminal || 'end_turn';
    const usage = params?.usage;
    if (usage) this.usage = { input_tokens: usage.inputTokens ?? null, output_tokens: usage.outputTokens ?? null,
      cached_tokens: usage.cachedTokens ?? null, reasoning_tokens: usage.reasoningTokens ?? null,
      total_tokens: Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0) };
    this.finish(stopReason, params?.error?.message || params?.reason || null);
  }
  approvalRequest(params) {
    const id = params?.approvalId ? String(params.approvalId) : '';
    if (!id || this.approvals.has(id)) return;
    this.approvals.add(id);
    void this.resolveApproval(params);
  }
  pickChoice(choices, allowed) {
    const decisions = allowed ? ALLOW_DECISIONS : DENY_DECISIONS;
    const candidates = choices.filter(choice => decisions.includes(choice?.decision));
    // A grant is never escalated to a provider-persistent Muse policy.
    const scoped = allowed ? candidates.filter(choice => choice.scope !== 'localPersistent') : candidates;
    return scoped.slice().sort((a, b) => scopeRank(a) - scopeRank(b))[0] || null;
  }
  async resolveApproval(params) {
    const approvalId = String(params.approvalId);
    const choices = Array.isArray(params.availableChoices) ? params.availableChoices : [];
    let allowed = false;
    if (this.settings.sandbox === 'read-only') {
      this.emit({ kind: 'backend_approval', phase: 'denied', accepted: false });
    } else if (!this.stopping) {
      this.emit({ kind: 'backend_approval', phase: 'requested' });
      const detail = JSON.stringify({ toolName: params.toolName ?? null, subject: redact(params.subject),
        rawArgs: redact(params.rawArgs), itemId: params.itemId ?? null, turnId: params.turnId ?? null }, null, 2);
      const accepted = await this.input.confirm?.('HIGH', 'Muse Code 权限请求', detail);
      this.emit({ kind: 'backend_approval', phase: accepted === true ? 'resolved' : 'denied', accepted: accepted === true });
      allowed = accepted === true;
    }
    const choice = this.pickChoice(choices, allowed);
    if (!choice) {
      this.emit({ kind: 'backend_info', info: { muse: 'approval left pending', permissionEnforcement: 'msp-requests',
        error: allowed ? 'Agent 未提供可用的允许选项' : 'Agent 未提供可用的拒绝选项' } });
      return;
    }
    try {
      await this.rpc.request('approval/decide', { sessionId: this.sessionId, commandId: uuidv7(), approvalId,
        requirementId: params.currentRequirementId || { approvalId, sourceIndex: 0 }, choiceId: choice.choiceId });
    } catch (error) { this.emit({ kind: 'backend_info', info: { muse: 'approval/decide failed', error: String(redact(error.message)) } }); }
  }
  userInputRequest(params) {
    const id = params?.userInputId ? String(params.userInputId) : '';
    if (!id || this.userInputs.has(id)) return;
    this.userInputs.add(id);
    void this.resolveUserInput(params);
  }
  questionText(questions) {
    return questions.map((question, index) => {
      const header = String(question?.header || '').trim();
      const body = String(question?.question || '').trim();
      const title = header && header !== body ? header + '：' : '';
      const options = (Array.isArray(question?.options) ? question.options : [])
        .map(option => '· ' + String(option?.label ?? '') + (option?.description ? '（' + option.description + '）' : '')).join('\n');
      return (questions.length > 1 ? (index + 1) + '. ' : '') + title + (body || header || '补充信息') + (options ? '\n' + options : '');
    }).join('\n\n') + (questions.length > 1
      ? '\n\n请用 JSON 对象回答，键为问题 id：' + JSON.stringify(questions.map(question => String(question.id)))
      : '');
  }
  answersFor(questions, response) {
    if (typeof response === 'string' && response.trim()) {
      const value = response.trim();
      if (questions.length === 1) return this.answerForQuestion(questions[0], value);
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return this.answersForObject(questions, parsed);
      } catch {}
      return [];
    }
    if (response && typeof response === 'object' && !Array.isArray(response)) return this.answersForObject(questions, response);
    return [];
  }
  answerForQuestion(question, value) {
    const labels = (Array.isArray(question?.options) ? question.options : []).map(option => String(option?.label ?? '')).filter(Boolean);
    const match = labels.find(label => label === value) || labels.find(label => label.toLowerCase() === value.toLowerCase());
    if (question?.selection?.mode === 'multiple') {
      const selected = value.split(/[,，、;；\n]+/).map(part => part.trim()).filter(Boolean)
        .map(part => labels.find(label => label === part) || labels.find(label => label.toLowerCase() === part.toLowerCase())).filter(Boolean);
      if (selected.length) return [{ questionId: String(question.id), selectedLabels: selected }];
      return [{ questionId: String(question.id), freeText: value }];
    }
    return [match ? { questionId: String(question.id), selectedLabel: match } : { questionId: String(question.id), freeText: value }];
  }
  answersForObject(questions, value) {
    const answers = [];
    for (const question of questions) {
      const raw = value[String(question.id)];
      if (raw == null || String(raw).trim() === '') continue;
      answers.push(...this.answerForQuestion(question, String(raw).trim()));
    }
    return answers;
  }
  async resolveUserInput(params) {
    const userInputId = String(params.userInputId);
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const labels = [...new Set(questions.flatMap(question => (Array.isArray(question?.options) ? question.options : [])
      .map(option => String(option?.label ?? '')).filter(Boolean)))];
    let response = null;
    try { response = await this.input.askUser?.(this.questionText(questions), questions.length === 1 ? labels : []); } catch { response = null; }
    const answers = this.answersFor(questions, response);
    const commandId = uuidv7();
    try {
      if (answers.length) await this.rpc.request('userInput/answer', { sessionId: this.sessionId, commandId, userInputId, answers });
      else await this.rpc.request('userInput/cancel', { sessionId: this.sessionId, commandId, userInputId, reason: '用户未回答' });
    } catch (error) { this.emit({ kind: 'backend_info', info: { muse: 'userInput reply failed', error: String(redact(error.message)) } }); }
  }
  sendTurnCancel() {
    if (this.cancelSent || !this.rpc || !this.sessionId || !this.turnId) return;
    this.cancelSent = true;
    // A cancel is only ever sent for the turn this backend started.
    void this.rpc.request('turn/cancel', { sessionId: this.sessionId, turnId: this.turnId, commandId: uuidv7() }).catch(() => {});
  }
  async interrupt() {
    this.stopping = true; this.cancelRequested = true;
    clearTimeout(this.turnTimer); this.turnTimer = undefined;
    if (!this.rpc) return;
    this.sendTurnCancel();
    if (this.settle && this.interruptTimer === undefined) {
      this.interruptTimer = setTimeout(() => this.fail(new Error('MSP 中断终态未获确认')), config.interruptTimeoutMs);
    }
  }
  async awaitExit(child, timeoutMs) {
    if (!child || child.exitCode != null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      const done = () => { clearTimeout(timer); resolve(true); };
      child.once('close', done); child.once('exit', done);
    });
  }
  async close() {
    clearTimeout(this.turnTimer); clearTimeout(this.interruptTimer); this.turnTimer = undefined; this.interruptTimer = undefined;
    const rpc = this.rpc; this.rpc = null; this.sessionId = null; this.turnId = null;
    if (!rpc) return;
    // MSP has no session/close: the host drains and exits when stdin reaches EOF.
    try { const child = rpc.child; if (child && child.exitCode == null && child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch {}
    await this.awaitExit(rpc.child, config.shutdownTimeoutMs);
    await rpc.close();
  }
}
module.exports = { MuseCodeBackend, uuidv7 };
