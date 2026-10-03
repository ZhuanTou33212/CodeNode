'use strict';

const crypto = require('crypto');
const { AgentToolResult } = require('../result.cjs');
const { request } = require('../../publicHttp.cjs');

function endpointFor(base, kind) {
  const url = new URL(String(base || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    throw new Error('Dify 地址应为不含凭据、查询参数的 HTTP(S) /v1 API 地址');
  }
  return url.href.replace(/\/+$/, '') + (kind === 'chat' ? '/chat-messages' : '/workflows/run');
}

function register(registry) {
  registry.register('dify_call', '调用项目显式配置的已发布 Dify 工作流或聊天应用。需网络权限及执行前确认；输入会发送到 Dify，返回结果不会直接写本地文件或画布。', {
    type: 'object',
    additionalProperties: false,
    properties: {
      inputs: { type: 'object', description: '映射到 Dify 应用的输入变量' },
      query: { type: 'string', maxLength: 8000, description: '聊天应用的用户问题；工作流可省略' },
      conversationId: { type: 'string', maxLength: 200, description: '聊天应用的会话 ID；首次调用留空' },
    },
  }, async (context, args) => {
    const cfg = require('../../agent.cjs').loadConfig(context.projectRoot()).dify;
    if (!cfg || !cfg.enabled) return AgentToolResult.failure('PERMISSION_DENIED', 'Dify 未启用；在项目 .codenode/agent.properties 配置 dify.enabled/base/api_key', { tool: 'dify_call' });
    if (!['workflow', 'chat'].includes(cfg.kind)) return AgentToolResult.error('dify.kind 必须是 workflow 或 chat');
    const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? args.inputs : {};
    const query = String(args.query || '').trim();
    if (cfg.kind === 'chat' && !query) return AgentToolResult.error('聊天应用需要 query');
    const user = 'codenode-' + crypto.createHash('sha256').update(context.projectRoot()).digest('hex').slice(0, 12);
    const payload = cfg.kind === 'chat'
      ? { inputs, query, response_mode: 'blocking', user, ...(args.conversationId ? { conversation_id: String(args.conversationId) } : {}) }
      : { inputs, response_mode: 'blocking', user };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 32768) return AgentToolResult.error('Dify 输入超过 32 KiB 上限');
    let endpoint;
    try { endpoint = endpointFor(cfg.base, cfg.kind); }
    catch (error) { return AgentToolResult.error(String(error && error.message || error)); }
    const started = Date.now();
    const audit = (status) => context.audit('dify_call kind=' + cfg.kind + ' inputKeys=' + Object.keys(inputs).join(',').slice(0, 240) + ' status=' + status + ' elapsedMs=' + (Date.now() - started));
    try {
      const response = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body,
        signal: context.signal && context.signal(),
        timeoutMs: 60000,
        maxBytes: 1024 * 1024,
        allowPrivateHosts: true,
      });
      let parsed;
      try { parsed = JSON.parse(response.text); }
      catch { audit('invalid_json'); return AgentToolResult.failure('FATAL_FAILURE', 'Dify 返回的不是 JSON', { kind: cfg.kind, elapsedMs: Date.now() - started }); }
      const run = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
      const status = String(run.status || (cfg.kind === 'chat' ? 'succeeded' : 'unknown'));
      const elapsedMs = Date.now() - started;
      const output = cfg.kind === 'chat' ? parsed.answer : run.outputs;
      const data = {
        kind: cfg.kind,
        inputKeys: Object.keys(inputs),
        inputs,
        query: cfg.kind === 'chat' ? query : undefined,
        output,
        elapsedMs,
        status,
        taskId: parsed.task_id || null,
        runId: run.id || parsed.workflow_run_id || null,
        conversationId: parsed.conversation_id || null,
        error: run.error || parsed.message || null,
      };
      if (status !== 'succeeded' || output == null) {
        audit(status);
        return AgentToolResult.failure('FATAL_FAILURE', 'Dify 执行失败：' + String(data.error || '未返回成功输出'), data);
      }
      audit('succeeded');
      const rendered = typeof output === 'string' ? output : JSON.stringify(output);
      const resultText = 'Dify ' + cfg.kind + ' 成功（' + elapsedMs + 'ms）\n' + rendered.slice(0, 16000) + (rendered.length > 16000 ? '\n…（已截断）' : '');
      return AgentToolResult.ok(resultText, data, { modelContent: resultText });
    } catch (error) {
      audit('failed');
      return AgentToolResult.failure('FATAL_FAILURE', 'Dify 调用失败：' + String(error && error.message || error).slice(0, 300), { kind: cfg.kind, inputKeys: Object.keys(inputs), elapsedMs: Date.now() - started });
    }
  });
  registry.declareContract('dify_call', { readOnly: false, mutatesWorkspace: false, requiredCapability: 'network.request', requiresConfirmation: 'HIGH', idempotent: false, timeoutMs: 0 });
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ["dify_call"]);
}

module.exports = { register, endpointFor };
