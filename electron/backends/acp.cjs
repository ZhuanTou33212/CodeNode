'use strict';
const crypto = require('crypto');
const { StdioRpc } = require('./stdioRpc.cjs');
const { redact } = require('../redaction.cjs');
const config = require('../../config/agent.backends.json');
const { AcpClient } = require('./acpClient.cjs');
const { contentBlock, promptContent } = require('./acpContent.cjs');

const names = { hermes: 'Hermes Agent', opencode: 'OpenCode', openclaw: 'OpenClaw' };
function requiresOpenClawMcpArray(error) {
  if (error?.code !== -32602) return false;
  const detail = JSON.stringify(error.data || {});
  return /mcpServers/.test(detail) && /expected array,\s*received undefined/i.test(detail);
}
class AcpBackend {
  constructor(settings, deps = {}) {
    this.settings = settings; this.deps = deps; this.rpc = null; this.listener = (delta) => {};
    this.sessionId = null; this.settle = null; this.timer = undefined; this.stopping = false;
    this.capabilityInfo = null; this.messages = new Map(); this.tools = new Map(); this.toolCalls = [];
    this.diffText = ''; this.cwd = null;
    this.client = new AcpClient(this); this.reasoning = ''; this.usage = null; this.sessionInfo = {}; this.bridge = null;
  }
  events(listener) { this.listener = listener; }
  emit(delta) { this.listener(delta); }
  command() {
    const command = this.settings.executable || config.commands[this.settings.backend];
    const args = Array.isArray(this.settings.args) ? this.settings.args : config.defaultArgs[this.settings.backend] || [];
    return { command, args: [...args] };
  }
  async sessionRequest(method, params) {
    try { return await this.rpc.request(method, params); }
    catch (error) {
      // Newer OpenClaw rejects mcpServers entirely, while older ACP bridges
      // require an array. Retry only the precise missing-array schema error.
      if (this.settings.backend !== 'openclaw' || Object.hasOwn(params, 'mcpServers') || !requiresOpenClawMcpArray(error)) throw error;
      return this.rpc.request(method, { ...params, mcpServers: [] });
    }
  }
  async connect(cwd) {
    if(this.rpc) return {protocolVersion:1,agentCapabilities:this.capabilityInfo,agentInfo:this.agentInfo};
    const { command, args } = this.command();
    this.rpc = new (this.deps.StdioRpc || StdioRpc)(command, args, cwd, {...this.deps,env:{...this.deps.env,...(this.settings.home?{DSH_HOME:this.settings.home}:{})}});
    this.rpc.on('notification', message => this.notification(message));
    this.rpc.on('request', message => { void this.dispatch(message); });
    this.rpc.on('disconnect', error => this.fail(error));
    const result = await this.rpc.request('initialize', { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {} }, session: { configOptions: { boolean: {} } } },
      clientInfo: { name: 'codenode', title: 'CodeNode', version: require('../../package.json').version } });
    if (result.protocolVersion !== 1) throw new Error('Agent ACP 协议版本不兼容：' + result.protocolVersion);
    this.capabilityInfo = result.agentCapabilities || {};
    this.agentInfo = result.agentInfo || {};
    this.authMethods = result.authMethods || [];
    return result;
  }
  capabilitySnapshot() {
    return {backend:this.settings.backend,protocol:'ACP',protocolVersion:1,conversation:true,events:true,approvals:true,interrupt:true,resume:this.capabilityInfo?.loadSession===true||!!this.capabilityInfo?.sessionCapabilities?.resume,usage:true,hardBudget:false,customTools:true,authMethods:this.authMethods||[],permissions:this.settings.sandbox,proxySource:this.rpc?.proxySource,cost:'unknown',version:this.agentInfo?.version||'unknown'};
  }
  async close(){await this.client.close();await this.bridge?.close();this.bridge=null;await this.rpc?.close();this.rpc=null;}
  async capabilities(cwd) {
    try {
      await this.connect(cwd);
      return { backend: this.settings.backend, available: true, authenticated: null, protocol: 'ACP', protocolVersion: 1,
        conversation: true, events: true, approvals: true, interrupt: true,
        resume: this.capabilityInfo.loadSession === true || !!this.capabilityInfo.sessionCapabilities?.resume,
        usage: true, hardBudget: false, customTools: true, authMethods: this.authMethods, permissions: this.settings.sandbox, proxySource:this.rpc?.proxySource,
        cost: 'unknown', version: this.agentInfo.version || 'unknown' };
    } catch (error) { return { backend: this.settings.backend, available: false, error: error.message }; }
    finally { await this.rpc?.close(); this.rpc = null; }
  }
  async run(input) {
    if(input.onDelta)this.events(input.onDelta);
    this.input = input; this.cwd = input.projectRoot; this.sessionId = null; this.messages = new Map(); this.tools = new Map(); this.toolCalls = []; this.diffText = ''; this.stopping = false;
    this.reasoning = ''; this.usage = null; this.sessionInfo = {};
    const abort = () => { void this.interrupt(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal?.aborted) return { content: '', state: 'CANCELLED', aborted: true, stopReason: 'cancelled' };
      await this.connect(input.projectRoot);
      if (this.settings.acp?.authMethodId) await this.control('authenticate', { methodId: this.settings.acp.authMethodId });
      if (input.toolRegistry && input.toolContext && this.settings.acp?.codeNodeTools === true) this.bridge = await require('./acpMcp.cjs').createToolBridge(input.toolRegistry, input.toolContext, delta => this.emit(delta));
      // Newer OpenClaw ACP bridges reject the mcpServers field entirely.
      const mcpServers = [...(this.settings.acp?.mcpServers || []), ...(this.bridge ? [this.bridge.descriptor] : [])];
      for (const server of mcpServers) if (server.type && !this.capabilityInfo.mcpCapabilities?.[server.type]) throw new Error('Agent 未声明 MCP ' + server.type + ' 能力');
      const sessionMcp = this.settings.backend === 'openclaw' && !mcpServers.length ? {} : { mcpServers };
      if (input.backendSession?.sessionId) {
        this.sessionId = input.backendSession.sessionId;
        const canLoad = this.capabilityInfo.loadSession === true;
        const canResume = !!this.capabilityInfo.sessionCapabilities?.resume;
        if (canLoad) this.sessionInfo = await this.sessionRequest('session/load', { sessionId: input.backendSession.sessionId, cwd: input.projectRoot, ...sessionMcp });
        else if (canResume) this.sessionInfo = await this.sessionRequest('session/resume', { sessionId: input.backendSession.sessionId, cwd: input.projectRoot, ...sessionMcp });
        else throw new Error(this.settings.backend + ' 未声明 ACP 会话恢复能力，不能恢复原执行');
        this.sessionId = input.backendSession.sessionId;
      } else {
        const created = await this.sessionRequest('session/new', { cwd: input.projectRoot, ...sessionMcp });
        if (!created?.sessionId) throw new Error('ACP session/new 未返回会话编号');
        this.sessionId = created.sessionId;
        this.sessionInfo = created;
      }
      this.emit({ kind: 'backend_info', info: redact(this.sessionInfo) });
      if (this.settings.acp?.modeId) await this.control('session/set_mode', { modeId: this.settings.acp.modeId });
      for (const [configId, value] of Object.entries(this.settings.acp?.configValues || {})) await this.control('session/set_config_option', { configId, value, ...(typeof value === 'boolean' ? { type: 'boolean' } : {}) });
      if (this.settings.model) {
        const option = this.sessionInfo.configOptions?.find(x => x.category === 'model');
        if (option) await this.control('session/set_config_option', { configId: option.id, value: this.settings.model });
        else await this.control('session/set_model', { modelId: this.settings.model });
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
      const result = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: promptContent(input, text, this.capabilityInfo.promptCapabilities || {}) },
        Number(this.settings.turnTimeoutMs) > 0 ? Number(this.settings.turnTimeoutMs) : 10 * 60 * 1000);
      if (this.settle) this.finish(result?.stopReason || 'end_turn');
      return await terminal;
    } catch (error) {
      return { content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, state: 'FAILED', error: error.message,
        ...(error.code != null ? { backendErrorCode: error.code } : {}), ...(error.data != null ? { backendErrorDetails: redact(error.data) } : {}),
        ...(error.method ? { backendErrorMethod: error.method } : {}),
        ...(this.rpc?.stderrTail?.length ? { backendStderr: redact(this.rpc.stderrTail.join('\n')).slice(-4000) } : {}),
        stopReason: this.sessionId ? 'backend_result_unknown' : 'backend_start_failed' };
    } finally {
      this.settle = null; clearTimeout(this.timer); input.signal?.removeEventListener('abort', abort);
      await this.client.close(); await this.bridge?.close(); this.bridge = null;
      await this.rpc?.close(); this.rpc = null;
    }
  }

  content() { return [...this.messages.values()].join(''); }
  finish(stopReason) {
    if (!this.settle) return;
    const settle = this.settle; this.settle = null; clearTimeout(this.timer);
    const aborted = stopReason === 'cancelled';
    settle({ content: this.content(), reasoning: this.reasoning, toolCalls: this.toolCalls, usage: this.usage,
      state: aborted ? 'CANCELLED' : ['end_turn', 'completed'].includes(stopReason) ? 'COMPLETED' : 'FAILED',
      aborted, error: !aborted&&!['end_turn','completed'].includes(stopReason)?'ACP 回合未完成：'+stopReason:null, stopReason, backendSession: { sessionId: this.sessionId } });
  }
  fail(error) { if (this.settle) { const done = this.settle; this.settle = null; done({ content: this.content(), toolCalls: this.toolCalls, state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' }); } }
  async dispatch(message) {
    try {
      if (message.method === 'session/request_permission') return await this.permission(message);
      if(message.method==='elicitation/create'){
        const p=message.params||{};
        if(p.sessionId&&p.sessionId!==this.sessionId)throw new Error('未知 ACP 会话');
        if(p.mode&&p.mode!=='form')return await this.rpc.respond(message.id,{action:'cancel'});
        const response=await this.input.askUser?.(String(p.message||'Agent 请求补充信息')+'\n需要的字段：'+JSON.stringify(p.requestedSchema||{}),[]);
        let content=response; if(typeof response==='string'){try{content=JSON.parse(response);}catch{const keys=Object.keys(p.requestedSchema?.properties||{});content=keys.length===1&&p.requestedSchema.properties[keys[0]].type==='string'?{[keys[0]]:response}:null;}}
        const properties=p.requestedSchema?.properties||{};
        const valid=content&&typeof content==='object'&&!Array.isArray(content)&&(p.requestedSchema?.required||[]).every(key=>Object.hasOwn(content,key))&&Object.entries(content).every(([key,value])=>{const item=properties[key];return Object.hasOwn(properties,key)&&item&&(!item.enum||item.enum.includes(value))&&(!item.type||item.type==='integer'?(!item?.type||Number.isInteger(value)):typeof value===item.type);});
        return await this.rpc.respond(message.id,valid?{action:'accept',content}:{action:'cancel'});
      }
      const known = ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release'];
      if (!known.includes(message.method)) return await this.rpc.respondError(message.id, -32601, 'Method not found: ' + message.method);
      await this.rpc.respond(message.id, await this.client.handle(message.method, message.params || {}));
    } catch (error) { await this.rpc?.respondError(message.id, typeof error.code === 'number' ? error.code : -32603, String(redact(error.message))).catch(() => {}); }
  }
  async control(method, params = {}) {
    const allowed = ['authenticate', 'logout', 'session/set_mode', 'session/set_model', 'session/set_config_option', 'session/list', 'session/delete', 'session/close'];
    if (!allowed.includes(method)) throw new Error('不支持的 ACP 控制方法');
    if (method === 'authenticate') {
      const auth = this.authMethods?.find(x => x.id === params.methodId);
      if (!auth || (auth.type && auth.type !== 'agent')) throw new Error('该认证方式需在 Agent 自身终端完成登录');
    } else if (method === 'logout') {
      if (!this.capabilityInfo.auth?.logout) throw new Error('Agent 未声明 logout 能力');
    } else if (['session/list', 'session/delete', 'session/close'].includes(method)) {
      if (!this.capabilityInfo.sessionCapabilities?.[method.split('/')[1]]) throw new Error('Agent 未声明 ' + method + ' 能力');
    } else {
      if (!this.sessionId) throw new Error('尚未创建 ACP 会话');
      if (method === 'session/set_mode' && !this.sessionInfo.modes?.availableModes?.some(x => x.id === params.modeId)) throw new Error('Agent 未提供该模式');
      if (method === 'session/set_model' && !this.sessionInfo.models?.availableModels?.some(x => x.modelId === params.modelId)) throw new Error('Agent 未提供该模型或模型配置选项');
      if (method === 'session/set_config_option') {
        const option = this.sessionInfo.configOptions?.find(x => x.id === params.configId);
        const choices = option?.options?.flatMap(x => x.options || [x]) || [];
        if (!option || (option.type === 'boolean' ? typeof params.value !== 'boolean' : !choices.some(x => x.value === params.value))) throw new Error('Agent 配置项或值无效');
      }
    }
    const result = await this.rpc.request(method, { ...params, ...(method.startsWith('session/') && method !== 'session/list' ? { sessionId: params.sessionId || this.sessionId } : {}) });
    if (result.configOptions) this.sessionInfo.configOptions = result.configOptions;
    this.emit({ kind: 'backend_info', info: redact(result) });
    return result;
  }
  notification(message) {
    const p = message.params || {};
    if (p.sessionId && p.sessionId !== this.sessionId) return;
    if (message.method === 'session/update') {
      const update = p.update || {};
      if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(update.sessionUpdate)) {
        let block; try { block = contentBlock(update.content); } catch (error) { this.emit({ kind: 'backend_info', info: { error: error.message } }); return; }
        if (update.sessionUpdate === 'agent_thought_chunk' && block.type === 'text') { this.reasoning += block.text; this.emit({ kind: 'reasoning', text: block.text }); return; }
        if (update.sessionUpdate !== 'agent_message_chunk' || block.type !== 'text') { this.emit({ kind: 'backend_content', source: update.sessionUpdate, content: block }); return; }
        const id = update.messageId || 'assistant'; this.messages.set(id, (this.messages.get(id) || '') + update.content.text);
        this.emit({ kind: 'content', text: update.content.text });
      } else if (update.sessionUpdate === 'tool_call') {
        this.tools.set(update.toolCallId, update);
        this.emit({ kind: 'tool', toolCalls: [{ name: update.name || update.title || 'agent_tool', callId: update.toolCallId,
          args: redact(update.rawInput), result: null, ok: null }] });
        this.toolContent(update);
      } else if (update.sessionUpdate === 'tool_call_update') {
        const previous = this.tools.get(update.toolCallId) || {};
        const merged = { ...previous, ...update }; this.tools.set(update.toolCallId, merged);
        if (update.content) this.toolContent(merged);
        if (update.status && ['completed', 'failed'].includes(update.status)) {
          const record = { name: merged.name || merged.title || 'agent_tool', callId: update.toolCallId,
            ok: update.status === 'completed', args: redact(merged.rawInput), data: { content: redact(update.content || []), status: update.status } };
          this.toolCalls = this.toolCalls.filter(x => x.callId !== record.callId); this.toolCalls.push(record); this.emit({ kind: 'tool_result', toolCalls: [record] });
        }
      } else if (update.sessionUpdate === 'plan') {
        this.emit({ kind: 'plan', items: (update.entries || []).map(x => ({ step: x.content, status: x.status, priority: x.priority })) });
      } else {
        if (update.sessionUpdate === 'usage_update') this.usage = redact(update);
        if (update.sessionUpdate === 'config_option_update') this.sessionInfo.configOptions = update.configOptions;
        if (update.sessionUpdate === 'current_mode_update' && this.sessionInfo.modes) this.sessionInfo.modes.currentModeId = update.currentModeId;
        this.emit({ kind: 'backend_info', info: redact(update) });
      }
    } else if (message.method === 'session/info_update') this.emit({ kind: 'backend_info', info: redact(p) });
  }
  toolContent(update) {
    const diffs = [];
    for (const tool of this.tools.values()) for (const block of tool.content || []) if (block.type === 'diff') diffs.push(`--- ${block.path}\n${block.oldText || ''}\n+++ ${block.path}\n${block.newText || ''}\n`);
    const text = diffs.join('');
    if (text !== this.diffText) { this.diffText = text; this.emit({ kind: 'backend_diff', diff: text }); }
    for (const block of update.content || []) if (block.type === 'content') {
      try { this.emit({ kind: 'backend_content', source: 'tool', callId: update.toolCallId, content: contentBlock(block.content) }); } catch {}
    }
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
      this.emit({kind:'backend_approval',phase:'denied',accepted:false});
    } else if (!this.stopping) {
      this.emit({ kind: 'backend_approval', phase: 'requested' });
      const accepted = await this.input.confirm?.('HIGH', this.settings.backend + ' ACP 权限请求',
        JSON.stringify({ title: p.title, description: p.description, subject: redact(subject), toolCall: redact(toolCall), options: p.options }, null, 2));
      this.emit({ kind: 'backend_approval', phase: accepted?'resolved':'denied', accepted });
      if (this.stopping || this.input.signal?.aborted) return this.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } });
      if (accepted) option = p.options?.find(item => item.kind === 'allow_once') || option;
      else option = p.options?.find(item => item.kind === 'reject_once') || option;
    } else option = p.options?.find(item => item.kind === 'reject_once' || item.kind === 'reject_always');
    if (option?.kind === 'allow_always' || option?.kind === 'reject_always') option = p.options?.find(item => item.kind === (option.kind === 'allow_always' ? 'allow_once' : 'reject_once')) || option;
    await this.rpc.respond(message.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
  }
  async interrupt() {
    this.stopping = true; void this.client.close(); if (!this.rpc || !this.sessionId || !this.settle) return;
    this.rpc.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }).catch(error => this.fail(error));
    clearTimeout(this.timer); this.timer = setTimeout(() => this.fail(new Error('ACP 中断终态未获确认')), config.interruptTimeoutMs);
  }
}
module.exports = { AcpBackend };
