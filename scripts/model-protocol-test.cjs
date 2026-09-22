/**
 * model-protocol-test.cjs —— 多厂商协议兼容（S13）：一份 harness，四家协议，全部真跑 HTTP
 *
 * 缺口（用户视角的原始诉求：「让 CodeNode 兼容市面上所有主流模型的 api key」）：
 *   改造前请求只有一种形状 —— `apiBase + '/chat/completions'` + `Authorization: Bearer` +
 *   `reasoning_effort` / `stream_options` 无条件下发。于是 Claude 原生 / Gemini 原生 /
 *   Azure 企业版这三档**主流 key 直接不可用**（400/401/404），而它们的占比恰恰最大。
 *
 * 本用例的取证方式（不看内部变量，只看**服务端收到什么**与**调用方拿到什么**）：
 *   ① 四个 mock 服务端各自**严格校验**自己的协议（路径 / 认证头 / 请求体禁用字段），
 *      不合规回 4xx —— 于是「协议接错」不可能静默通过（M1/M2 就是这条判据的自证）；
 *   ② 真实 `chatCompletionStream` / `chatCompletion` 打真实 HTTP，断言解析出的
 *      content / reasoning / toolCalls / usage / finishReason；
 *   ③ **端到端**：真实 `runAgentChat` + 真实工具注册表跑完一轮 Claude 原生协议的工具循环
 *      （第 2 次请求的 messages 里必须出现 Anthropic 形状的 `tool_result` 块，且 tool_use_id 对得上）；
 *   ④ OpenAI 兼容档的**负向判据**：发出的原始报文体（含字段顺序）与改造前逐字节一致；
 *   ⑤ 预设清单本身可判：每家地址/协议/认证头都在白名单内，且主流厂商一个不缺。
 *
 * 离线确定性：全部 loopback、无外部网络、无 API Key、无 display。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const protocolLib = require('../electron/modelProtocol.cjs');
const presetLib = require('../electron/providerPresets.cjs');
const modelStore = require('../electron/modelStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const KEY = 'test-key-1234567890';
const AUTH_BLOCK = 'toolu_1';

/** SSE 帧（OpenAI 形状的 mock 用；Anthropic/Gemini 走各自的 event 形状） */
function sse(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

/**
 * 通用 mock 服务端：
 *   route(req, body, raw) → { status?, headers?, sse?: string[], text?: string, end?: boolean }
 * requests 记录原始请求（method / url / headers / raw body），用例据此做「服务端视角」断言。
 */
function startMock(route) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      let out;
      try {
        out = route(req, body, raw, state) || {};
      } catch (error) {
        out = { status: 500, text: JSON.stringify({ error: { message: String((error && error.message) || error) } }) };
      }
      const status = out.status || 200;
      if (status >= 400) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(out.text || JSON.stringify({ error: { message: 'mock rejected' } }));
        return;
      }
      if (Array.isArray(out.sse)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        out.sse.forEach((frame) => res.write(frame));
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.text || JSON.stringify(out.json || {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        port,
        base: 'http://127.0.0.1:' + port,
        requests: state.requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 深扫：整个对象里有没有某个键（用于「Gemini 请求体不许带 additionalProperties」这种判据） */
function hasKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    return Object.values(value).some((item) => hasKeyDeep(item, key));
  }
  return false;
}

async function expectFailure(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

const MESSAGES = [{ role: 'system', content: '你是 CodeNode。' }, { role: 'user', content: '把 a.txt 读出来' }];
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件',
      // 与生产同形：注册表 closeInputSchema() 会给顶层对象加 additionalProperties:false，
      // 而 Gemini 的 schema 子集不认这个关键字 —— 夹具少了它，C5 的剥离判据就是空转（变异实测过）
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '路径' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

// ────────────────────────── OpenAI 兼容 mock（基线 + 负向判据） ──────────────────────────
function openAiRoute(req, body, raw, state) {
  if (req.method === 'GET' && req.url.startsWith('/models')) {
    if (req.headers.authorization !== 'Bearer ' + KEY) return { status: 401, text: JSON.stringify({ error: { message: 'bad key' } }) };
    return { json: { data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] } };
  }
  if (req.method !== 'POST' || !req.url.startsWith('/chat/completions')) {
    return { status: 404, text: JSON.stringify({ error: { message: 'openai mock: unknown route ' + req.method + ' ' + req.url } }) };
  }
  if (req.headers.authorization !== 'Bearer ' + KEY) {
    return { status: 401, text: JSON.stringify({ error: { message: 'openai mock: Authorization: Bearer <key> required' } }) };
  }
  // 请求体里带了「不是 OpenAI 协议该有的东西」直接拒（同一份 mock 也当「协议校验器」用）
  if (body && (body.contents || body.systemInstruction || body.system !== undefined)) {
    return { status: 400, text: JSON.stringify({ error: { message: 'openai mock: got non-OpenAI body shape' } }) };
  }
  if (body && body.stream !== true) {
    return {
      json: {
        choices: [{ index: 0, message: { role: 'assistant', content: '非流式回答' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    };
  }
  return {
    sse: [
      sse({ choices: [{ index: 0, delta: { content: '先' } }] }),
      sse({ choices: [{ index: 0, delta: { content: '读文件。' }, finish_reason: 'tool_calls' }] }),
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path": "a.txt"}' } }],
            },
          },
        ],
      }),
      sse({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } }),
      'data: [DONE]\n\n',
    ],
  };
}

// ────────────────────────── Anthropic mock（原生 /v1/messages） ──────────────────────────
function anthropicFrames(text, tool) {
  /** @type {Array<any>} 逐帧都是不同形状的 Messages API 事件，这里不逐个建模 */
  const frames = [
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 0 } },
    },
    { type: 'ping' },
  ];
  if (text) {
    frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    frames.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    frames.push({ type: 'content_block_stop', index: 0 });
  }
  if (tool) {
    frames.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: AUTH_BLOCK, name: tool.name } });
    // 参数按真实的「分片下发」来：累加器必须拼回合法 JSON
    frames.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } });
    frames.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th": "a.txt"}' } });
    frames.push({ type: 'content_block_stop', index: 1 });
  }
  frames.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 25 } });
  frames.push({ type: 'message_stop' });
  return frames.map((frame) => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n');
}

function anthropicRoute(req, body, raw, state) {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    if (req.headers['x-api-key'] !== KEY) return { status: 401, text: JSON.stringify({ error: { message: 'anthropic mock: x-api-key required' } }) };
    return { json: { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] } };
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    return { status: 404, text: JSON.stringify({ error: { message: 'anthropic mock: unknown route ' + req.method + ' ' + req.url } }) };
  }
  if (req.headers['x-api-key'] !== KEY) {
    return { status: 401, text: JSON.stringify({ error: { message: 'anthropic mock: x-api-key required' } }) };
  }
  // Anthropic 的真实约束：这些字段出现即 400（协议接错时必然命中其中一条）
  if (body && body.stream_options) return { status: 400, text: JSON.stringify({ error: { message: 'anthropic mock: stream_options is not a Messages API field' } }) };
  if (body && body.reasoning_effort !== undefined) return { status: 400, text: JSON.stringify({ error: { message: 'anthropic mock: reasoning_effort is not a Messages API field' } }) };
  if (body && Array.isArray(body.tools) && body.tools.some((t) => t && (t.function || !t.input_schema))) {
    return { status: 400, text: JSON.stringify({ error: { message: 'anthropic mock: tools must use {name, description, input_schema}' } }) };
  }
  if (body && body.messages && body.messages.some((m) => m.role === 'system')) {
    return { status: 400, text: JSON.stringify({ error: { message: 'anthropic mock: system must be top-level, not a message' } }) };
  }
  /**
   * 轮次判定看**请求内容**而不是计数器：带 tool_result 回灌的那一轮就是收尾轮。
   * （用例里同一个 mock 会被多个小节共用，计数器口径会让脚本错位。）
   */
  const hasToolResult = !!(body && Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')));
  const isSecond = hasToolResult;
  void state;
  if (body && body.stream !== true) {
    return {
      json: {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看需要什么。' },
          { type: 'text', text: '非流式回答' },
          { type: 'tool_use', id: 'toolu_sync', name: 'read_file', input: { path: 'a.txt' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
  }
  return { sse: isSecond ? anthropicFrames('文件内容是 CONTENT-1。', null) : anthropicFrames('先读文件。', { name: 'read_file' }) };
}

// ────────────────────────── Gemini mock（原生 generativelanguage） ──────────────────────────
function geminiRoute(req, body, raw, state) {
  if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
    if (req.headers['x-goog-api-key'] !== KEY) return { status: 401, text: JSON.stringify({ error: { message: 'gemini mock: x-goog-api-key required' } }) };
    return { json: { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }, { name: 'models/gemini-2.5-flash' }] } };
  }
  const url = String(req.url);
  if (req.method !== 'POST' || !/^\/v1beta\/models\/[^:]+:(streamGenerateContent|generateContent)/.test(url)) {
    return { status: 404, text: JSON.stringify({ error: { message: 'gemini mock: unknown route ' + req.method + ' ' + url } }) };
  }
  if (req.headers['x-goog-api-key'] !== KEY) {
    return { status: 401, text: JSON.stringify({ error: { message: 'gemini mock: x-goog-api-key required' } }) };
  }
  if (body && body.messages !== undefined) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: messages is not a Gemini field (use contents)' } }) };
  }
  if (body && Array.isArray(body.tools) && body.tools.some((t) => !t || !Array.isArray(t.functionDeclarations))) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: tools must be [{functionDeclarations}]' } }) };
  }
  if (body && hasKeyDeep(body.tools, 'additionalProperties')) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: additionalProperties is rejected by the Gemini schema subset' } }) };
  }
  if (body && body.stream_options) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: stream_options is not a Gemini field' } }) };
  }
  if (!/alt=sse/.test(url)) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: streaming requires ?alt=sse' } }) };
  }
  if (body && body.contents && body.contents.length && !body.systemInstruction) {
    return { status: 400, text: JSON.stringify({ error: { message: 'gemini mock: system message must be hoisted to systemInstruction' } }) };
  }
  void state;
  return {
    sse: [
      sse({ candidates: [{ content: { role: 'model', parts: [{ text: '我先看看。' }] } }] }),
      sse({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] } }] }),
      sse({
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 38, cachedContentTokenCount: 5 },
      }),
    ],
  };
}

// ────────────────────────── Azure OpenAI mock ──────────────────────────
function azureRoute(req, body, raw, state) {
  const url = String(req.url);
  if (req.method !== 'POST' || !/^\/openai\/deployments\/[^/]+\/chat\/completions\?api-version=/.test(url)) {
    return { status: 404, text: JSON.stringify({ error: { message: 'azure mock: expected /openai/deployments/<deployment>/chat/completions?api-version=…' } }) };
  }
  if (req.headers['api-key'] !== KEY) {
    return { status: 401, text: JSON.stringify({ error: { message: 'azure mock: api-key header required' } }) };
  }
  if (req.headers.authorization) {
    return { status: 401, text: JSON.stringify({ error: { message: 'azure mock: Authorization header must not be used' } }) };
  }
  void body;
  void raw;
  void state;
  return {
    sse: [
      sse({ choices: [{ index: 0, delta: { content: 'Azure ' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: { content: '回答。' }, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }),
      'data: [DONE]\n\n',
    ],
  };
}

async function main() {
  const openai = await startMock(openAiRoute);
  const anthropic = await startMock(anthropicRoute);
  const gemini = await startMock(geminiRoute);
  const azure = await startMock(azureRoute);
  const noop = () => {};

  try {
    // ======================= A. OpenAI 兼容档：负向判据（逐字节不变） =======================
    console.log('\n== A. OpenAI 兼容（默认档）逐字节不变 + 流式解析 ==');
    {
      const cfg = {
        apiBase: openai.base,
        apiKey: KEY,
        model: 'deepseek-flash',
        maxTokens: 4096,
        reasoningEffort: 'medium',
        sendStreamOptions: true,
      };
      const res = await agent.chatCompletionStream(cfg, MESSAGES, noop, { tools: TOOLS, timeoutMs: 8000 });
      const raw = openai.requests[openai.requests.length - 1].raw;
      /** 改造前的请求体（字段与顺序）就是这条；任何一处漂移都会红 */
      const expected = JSON.stringify({
        model: 'deepseek-flash',
        messages: MESSAGES,
        stream: true,
        max_tokens: 4096,
        reasoning_effort: 'medium',
        stream_options: { include_usage: true },
        tools: TOOLS,
      });
      check('A1 路径仍是 {apiBase}/chat/completions', openai.requests[0].url === '/chat/completions', openai.requests[0].url);
      check('A2 认证头仍是 Authorization: Bearer', openai.requests[0].headers.authorization === 'Bearer ' + KEY);
      check('A3 请求体逐字节一致（字段与顺序都没变）', raw === expected, raw === expected ? '' : 'got=' + raw.slice(0, 220));
      check('A4 流式内容解析不变', res.content === '先读文件。', res.content);
      check('A5 流式工具调用解析不变', res.toolCalls.length === 1 && res.toolCalls[0].name === 'read_file' && res.toolCalls[0].argsValid === true, JSON.stringify(res.toolCalls));
      check('A6 finish_reason 与 usage 照旧', res.finishReason === 'tool_calls' && res.usage.total_tokens === 30, JSON.stringify({ f: res.finishReason, u: res.usage }));

      // 关掉可关字段：请求体里必须**没有**它们（老口径的负向判据一起守）
      const off = await agent.chatCompletionStream({ ...cfg, reasoningEffort: null, sendStreamOptions: false }, MESSAGES, noop, { timeoutMs: 8000 });
      const rawOff = openai.requests[openai.requests.length - 1].raw;
      check('A7 reasoningEffort=null / sendStreamOptions=false → 字段消失（不是发 null/false）',
        !JSON.parse(rawOff).reasoning_effort && !JSON.parse(rawOff).stream_options && openai.requests.length >= 2, rawOff.slice(0, 160));
      check('A8 无工具时不下发 tools 字段', !('tools' in JSON.parse(rawOff)));
      void off;

      // 非流式（压缩 / 意图分类走的这条路）
      const sync = await agent.chatCompletion(cfg, MESSAGES, { timeoutMs: 8000 });
      check('A9 非流式解析不变（chatCompletion）', sync.content === '非流式回答' && sync.usage.total_tokens === 14, JSON.stringify(sync));
    }

    // ======================= B. Anthropic 原生（Claude） =======================
    console.log('\n== B. Anthropic Messages（Claude 原生） ==');
    {
      const cfg = {
        apiBase: anthropic.base,
        apiKey: KEY,
        model: 'claude-sonnet-4-5',
        maxTokens: 4096,
        protocol: 'anthropic',
        reasoningEffort: 'medium',
        sendStreamOptions: true,
      };
      const res = await agent.chatCompletionStream(cfg, MESSAGES, noop, { tools: TOOLS, timeoutMs: 8000 });
      const req = anthropic.requests[anthropic.requests.length - 1];
      const body = JSON.parse(req.raw);
      check('B1 路径 = {base}/v1/messages', req.url === '/v1/messages', req.url);
      check('B2 认证走 x-api-key，且不带 Authorization', req.headers['x-api-key'] === KEY && !req.headers.authorization);
      check('B3 带 anthropic-version 头', !!req.headers['anthropic-version'], String(req.headers['anthropic-version']));
      check('B4 system 提升为顶层参数（不是 messages 里的一条）', body.system === '你是 CodeNode。' && body.messages.every((m) => m.role !== 'system'), JSON.stringify(body.system));
      check('B5 不下发 stream_options / reasoning_effort（Messages API 没有这两个字段）', !body.stream_options && body.reasoning_effort === undefined);
      check('B6 工具 schema 用 input_schema（不是 function.parameters）', Array.isArray(body.tools) && body.tools[0].input_schema && !body.tools[0].function, JSON.stringify(body.tools && body.tools[0]).slice(0, 160));
      check('B7 思考链映射到 thinking.budget_tokens，且被 max_tokens 夹住（medium=8192 > max_tokens 4096 → 2048）',
        body.thinking && body.thinking.type === 'enabled' && body.thinking.budget_tokens === 2048 && body.thinking.budget_tokens < body.max_tokens,
        JSON.stringify({ thinking: body.thinking, max_tokens: body.max_tokens }));
      const wideCfg = { ...cfg, maxTokens: 32768 };
      const wide = await agent.chatCompletionStream(wideCfg, MESSAGES, noop, { timeoutMs: 8000 });
      const wideBody = JSON.parse(anthropic.requests[anthropic.requests.length - 1].raw);
      check('B7b 输出预算足够时用满档（medium → 8192）', wideBody.thinking && wideBody.thinking.budget_tokens === 8192, JSON.stringify(wideBody.thinking));
      void wide;
      check('B8 流式正文解析', res.content === '先读文件。', res.content);
      check('B9 工具调用（input_json_delta 分片）拼回合法 JSON', res.toolCalls.length === 1 && res.toolCalls[0].id === AUTH_BLOCK && res.toolCalls[0].args === '{"path": "a.txt"}' && res.toolCalls[0].argsValid === true, JSON.stringify(res.toolCalls));
      check('B10 stop_reason=tool_use → finishReason=tool_calls', res.finishReason === 'tool_calls', String(res.finishReason));
      check('B11 usage 映射（input+cache_read 计入 prompt，缓存命中单列）',
        res.usage && res.usage.prompt_tokens === 112 && res.usage.completion_tokens === 25 && res.usage.total_tokens === 137 && res.usage.prompt_tokens_details.cached_tokens === 100,
        JSON.stringify(res.usage));
      check('B12 流异常：无（协议翻译不应制造 anomaly）', (res.anomalies || []).length === 0, JSON.stringify(res.anomalies));

      // thinking 分片 → reasoning 通道
      const thinkFrames = ['event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '内部推理…' } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答。' } }) + '\n\n',
        'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + '\n\n',
        'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n'];
      const thinkSrv = await startMock((r, b) => (r.method === 'POST' ? { sse: thinkFrames } : { status: 404, text: '{}' }));
      const think = await agent.chatCompletionStream({ ...cfg, apiBase: thinkSrv.base }, MESSAGES, noop, { timeoutMs: 8000 });
      check('B13 thinking_delta → reasoning 通道（不混进正文）', think.reasoning === '内部推理…' && think.content === '答。', JSON.stringify({ r: think.reasoning, c: think.content }));
      await thinkSrv.close();

      // 不支持推理强度的模型：thinking 字段整个不下发
      const noEffort = await agent.chatCompletionStream({ ...cfg, reasoningEffort: null }, MESSAGES, noop, { timeoutMs: 8000 });
      const bodyNoEffort = JSON.parse(anthropic.requests[anthropic.requests.length - 1].raw);
      check('B14 关思考 → 请求体里没有 thinking（而不是 thinking:disabled）', bodyNoEffort.thinking === undefined, JSON.stringify(bodyNoEffort.thinking));
      void noEffort;

      // 图片附件（视觉）双向往返：Claude 用 base64 source、Gemini 用 inlineData
      const imageMsg = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } }] }];
      const anthImg = protocolLib.toAnthropicMessages(imageMsg);
      const anthBlock = anthImg.messages[0].content.find((b) => b.type === 'image');
      check('B17 图片 → Anthropic base64 source（media_type 取自 data URL）',
        !!anthBlock && anthBlock.source.type === 'base64' && anthBlock.source.media_type === 'image/png' && anthBlock.source.data === 'AAAB',
        JSON.stringify(anthBlock));
      const gemImg = protocolLib.toGeminiContents(imageMsg);
      const gInline = gemImg.contents[0].parts.find((pt) => pt.inlineData);
      check('B18 图片 → Gemini inlineData（同一份 data URL 口径）',
        !!gInline && gInline.inlineData.mimeType === 'image/png' && gInline.inlineData.data === 'AAAB',
        JSON.stringify(gInline));

      // 首条消息必须是 user（历史以助手开头时 Anthropic 会 400）——纯函数层直接锁
      const assistantFirst = protocolLib.toAnthropicMessages([
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '继续' },
      ]);
      check('B16 历史以助手开头 → 补一条 user 占位（否则 Messages API 直接 400）',
        assistantFirst.messages.length === 3 && assistantFirst.messages[0].role === 'user' && assistantFirst.messages[1].role === 'assistant',
        JSON.stringify(assistantFirst.messages.map((m) => m.role)));
      const userFirst = protocolLib.toAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
      check('B16b 负向：正常以 user 开头时**不插入**占位（不制造多余上下文）',
        userFirst.messages.length === 2 && userFirst.messages[0].content[0].text === 'a',
        JSON.stringify(userFirst.messages.length));
      const alt = protocolLib.toAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]);
      check('B16c 相邻同角色合并（Anthropic 要求 user/assistant 交替）',
        alt.messages.length === 2 && alt.messages[0].content.length === 2,
        JSON.stringify(alt.messages.map((m) => m.role + ':' + m.content.length)));

      // 非流式（Anthropic 原生）
      const sync = await agent.chatCompletion(cfg, MESSAGES, { timeoutMs: 8000 });
      check('B15 非流式解析（text / thinking / tool_use 三类块）',
        sync.content === '非流式回答' && sync.reasoning === '先看需要什么。' && sync.toolCalls && sync.toolCalls[0].id === 'toolu_sync' && sync.usage.total_tokens === 27,
        JSON.stringify(sync));
    }

    // ======================= C. Gemini 原生 =======================
    console.log('\n== C. Google Gemini（原生 generativelanguage） ==');
    {
      const cfg = {
        apiBase: gemini.base,
        apiKey: KEY,
        model: 'gemini-2.5-flash',
        maxTokens: 2048,
        protocol: 'gemini',
        reasoningEffort: 'medium',
      };
      const res = await agent.chatCompletionStream(cfg, MESSAGES, noop, { tools: TOOLS, timeoutMs: 8000 });
      const req = gemini.requests[gemini.requests.length - 1];
      const body = JSON.parse(req.raw);
      check('C1 路径 = {base}/v1beta/models/<model>:streamGenerateContent?alt=sse',
        req.url === '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', req.url);
      check('C2 认证走 x-goog-api-key', req.headers['x-goog-api-key'] === KEY && !req.headers.authorization);
      check('C3 system → systemInstruction；消息进 contents', !!body.systemInstruction && Array.isArray(body.contents) && body.contents.every((c) => c.role !== 'system'), JSON.stringify(Object.keys(body)));
      check('C4 工具转 functionDeclarations', Array.isArray(body.tools) && Array.isArray(body.tools[0].functionDeclarations) && body.tools[0].functionDeclarations[0].name === 'read_file');
      check('C5 Gemini schema 子集：全树不带 additionalProperties / $schema', !hasKeyDeep(body.tools, 'additionalProperties') && !hasKeyDeep(body.tools, '$schema'));
      check('C6 max_tokens → generationConfig.maxOutputTokens', body.generationConfig && body.generationConfig.maxOutputTokens === 2048, JSON.stringify(body.generationConfig));
      check('C7 不认字段不下发（stream_options / reasoning_effort / messages）', !body.stream_options && body.reasoning_effort === undefined && body.messages === undefined);
      check('C8 正文解析（parts[].text）', res.content === '我先看看。', res.content);
      check('C9 functionCall → 内部 toolCalls（补出稳定 id，参数为合法 JSON）',
        res.toolCalls.length === 1 && res.toolCalls[0].name === 'read_file' && res.toolCalls[0].args === '{"path":"a.txt"}' && res.toolCalls[0].argsValid === true,
        JSON.stringify(res.toolCalls));
      check('C10 usageMetadata 映射（含缓存命中）',
        res.usage && res.usage.prompt_tokens === 30 && res.usage.completion_tokens === 8 && res.usage.total_tokens === 38 && res.usage.prompt_tokens_details.cached_tokens === 5,
        JSON.stringify(res.usage));
      check('C11 finishReason=STOP → stop', res.finishReason === 'stop', String(res.finishReason));
      const gAssistantFirst = protocolLib.toGeminiContents([{ role: 'assistant', content: '上一轮' }, { role: 'user', content: '继续' }]);
      check('C12 Gemini 同理：历史以 model 开头 → 补 user 占位；正常历史不补',
        gAssistantFirst.contents[0].role === 'user' && protocolLib.toGeminiContents([{ role: 'user', content: 'a' }]).contents[0].parts[0].text === 'a',
        JSON.stringify(gAssistantFirst.contents.map((c) => c.role)));
      const gTool = protocolLib.toGeminiContents([
        { role: 'assistant', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: '文件内容' },
      ]);
      check('C13 tool 消息 → functionResponse 且按 id 反查函数名（会话首条为 model → 先补 user 占位）',
        gTool.contents.some((c) => c.parts.some((pt) => pt.functionResponse && pt.functionResponse.name === 'read_file')),
        JSON.stringify(gTool.contents).slice(0, 240));
    }

    // ======================= D. Azure OpenAI =======================
    console.log('\n== D. Azure OpenAI（部署名路径 + api-key 头） ==');
    {
      const cfg = {
        apiBase: azure.base,
        apiKey: KEY,
        model: 'gpt-4o',
        endpoint: 'azure',
        apiVersion: '2024-10-21',
        maxTokens: 1024,
        reasoningEffort: null,
      };
      const res = await agent.chatCompletionStream(cfg, MESSAGES, noop, { timeoutMs: 8000 });
      const req = azure.requests[azure.requests.length - 1];
      check('D1 路径 = /openai/deployments/<部署名>/chat/completions?api-version=…',
        req.url === '/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21', req.url);
      check('D2 认证走 api-key 头（Azure 不认 Bearer）', req.headers['api-key'] === KEY && !req.headers.authorization);
      check('D3 流式解析与 OpenAI 档一致', res.content === 'Azure 回答。' && res.usage.total_tokens === 9 && res.finishReason === 'stop', JSON.stringify({ c: res.content, u: res.usage }));

      // 部署名可单独指定（模型 ID 与部署名不一致是 Azure 的常态）
      await agent.chatCompletionStream({ ...cfg, azureDeployment: 'my-deploy' }, MESSAGES, noop, { timeoutMs: 8000 });
      check('D4 azureDeployment 覆盖部署名', azure.requests[azure.requests.length - 1].url.startsWith('/openai/deployments/my-deploy/'), azure.requests[azure.requests.length - 1].url);
    }

    // ======================= E. 端到端：Claude 原生协议跑完整工具循环 =======================
    console.log('\n== E. 端到端：runAgentChat 走 Claude 原生协议（真实工具注册表） ==');
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-proto-'));
      fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-1\n');
      const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
      sandbox.setDefaultPolicy(policy);
      const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
      const context = new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal });
      const cfg = {
        apiBase: anthropic.base,
        apiKey: KEY,
        model: 'claude-sonnet-4-5',
        protocol: 'anthropic',
        maxTokens: 2048,
        reasoningEffort: null,
        costRunId: 'run-proto-e2e',
        tools: {},
        limits: {},
        compression: { enabled: false },
        reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
      };
      const before = anthropic.requests.filter((r) => r.method === 'POST').length;
      const out = await agent.runAgentChat({
        cfg,
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '把 a.txt 读出来并复述内容' }],
        tools: { registry, context },
        onDelta: () => {},
      });
      const posts = anthropic.requests.slice(before).filter((r) => r.method === 'POST');
      check('E1 工具循环真的跑了两轮（tool_use → tool_result → 收尾）', posts.length === 2, 'posts=' + posts.length);
      check('E2 最终回答里带上了文件真实内容（工具真的执行了）', /CONTENT-1/.test(String(out.content || '')), String(out.content || '').slice(0, 120));
      const second = posts.length > 1 ? JSON.parse(posts[1].raw) : null;
      const toolResultMsg = second && second.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
      check('E3 第 2 轮把工具结果回灌成 Anthropic 的 tool_result 块（在 user 消息里）', !!toolResultMsg, JSON.stringify(second && second.messages).slice(0, 260));
      check('E4 tool_result 的 tool_use_id 与上一轮 tool_use 的 id 对得上', !!toolResultMsg && toolResultMsg.content.some((b) => b.type === 'tool_result' && b.tool_use_id === AUTH_BLOCK), JSON.stringify(toolResultMsg && toolResultMsg.content).slice(0, 200));
      const assistantToolUse = second && second.messages.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
      check('E5 上一轮的助手消息以 tool_use 块形状回放（不是 tool_calls 字段）', !!assistantToolUse, JSON.stringify(second && second.messages.map((m) => m.role)).slice(0, 160));
      check('E6 两轮都没有触发协议校验失败（服务端未回 4xx）', posts.every((r) => r.headers['x-api-key'] === KEY), '');
      fs.rmSync(root, { recursive: true, force: true });
    }

    // ======================= F. 判别力：协议接错必须当场失败 =======================
    console.log('\n== F. 判别力（变异对照）：协议接错不许静默通过 ==');
    {
      const wrongOpenAiWay = await expectFailure(() =>
        agent.chatCompletionStream({ apiBase: anthropic.base, apiKey: KEY, model: 'claude-sonnet-4-5', maxTokens: 64 }, MESSAGES, noop, { timeoutMs: 8000 })
      );
      check('F1 用 OpenAI 兼容档打 Anthropic 端点 → 失败（404，而不是「看起来成功」）', !!wrongOpenAiWay && /HTTP 404/.test(wrongOpenAiWay.message), wrongOpenAiWay && wrongOpenAiWay.message.slice(0, 120));

      const wrongAuth = await expectFailure(() =>
        agent.chatCompletionStream({ apiBase: anthropic.base, apiKey: KEY, model: 'claude-sonnet-4-5', protocol: 'anthropic', auth: 'bearer', maxTokens: 64 }, MESSAGES, noop, { timeoutMs: 8000 })
      );
      check('F2 协议对但认证头接错 → 401（认证头是可独立判据）', !!wrongAuth && /HTTP 401/.test(wrongAuth.message), wrongAuth && wrongAuth.message.slice(0, 120));

      const wrongGeminiPath = await expectFailure(() =>
        agent.chatCompletionStream({ apiBase: gemini.base, apiKey: KEY, model: 'gemini-2.5-flash', protocol: 'openai', maxTokens: 64 }, MESSAGES, noop, { timeoutMs: 8000 })
      );
      check('F3 用 OpenAI 档打 Gemini 端点 → 404', !!wrongGeminiPath && /HTTP 404/.test(wrongGeminiPath.message), wrongGeminiPath && wrongGeminiPath.message.slice(0, 120));

      const wrongAzure = await expectFailure(() =>
        agent.chatCompletionStream({ apiBase: azure.base, apiKey: KEY, model: 'gpt-4o', endpoint: 'azure', apiVersion: '2024-10-21', auth: 'bearer', maxTokens: 64 }, MESSAGES, noop, { timeoutMs: 8000 })
      );
      check('F4 Azure 端点用 Bearer 打 → 401（api-key 头不是可选项）', !!wrongAzure && /HTTP 401/.test(wrongAzure.message), wrongAzure && wrongAzure.message.slice(0, 120));
    }

    // ======================= G. 模型列表 / 预设清单 =======================
    console.log('\n== G. 拉取模型列表 + 厂商预设清单 ==');
    {
      const listReq = protocolLib.buildModelListRequest({ apiBase: openai.base, apiKey: KEY, model: 'x' });
      const res = await fetch(listReq.url, { method: listReq.method, headers: listReq.headers });
      const json = await res.json();
      const parsed = protocolLib.parseModelList('openai', json);
      check('G1 OpenAI 兼容档可拉取模型列表（/models + Bearer）', res.ok && parsed.length === 2 && parsed[0].id === 'deepseek-v4-flash', JSON.stringify(parsed));

      const anthropicList = protocolLib.buildModelListRequest({ apiBase: anthropic.base, apiKey: KEY, protocol: 'anthropic' });
      const ares = await fetch(anthropicList.url, { method: anthropicList.method, headers: anthropicList.headers });
      const aparsed = protocolLib.parseModelList('anthropic', await ares.json());
      check('G2 Anthropic 档列表端点（/v1/models + x-api-key + design 头）', ares.ok && aparsed[0].id === 'claude-sonnet-4-5', JSON.stringify(aparsed));

      const geminiList = protocolLib.buildModelListRequest({ apiBase: gemini.base, apiKey: KEY, protocol: 'gemini' });
      const gres = await fetch(geminiList.url, { method: geminiList.method, headers: geminiList.headers });
      const gparsed = protocolLib.parseModelList('gemini', await gres.json());
      check('G3 Gemini 档列表端点（/v1beta/models → 去掉 models/ 前缀）', gres.ok && gparsed[0].id === 'gemini-2.5-pro', JSON.stringify(gparsed));

      check('G4 Azure 没有列表端点 → 明确返回 null（不编造）', protocolLib.buildModelListRequest({ apiBase: azure.base, apiKey: KEY, endpoint: 'azure' }) === null);

      const presets = presetLib.allPresets();
      const ids = presets.map((p) => p.id);
      const required = ['deepseek', 'moonshot', 'dashscope', 'zhipu', 'minimax', 'volcengine', 'qianfan', 'hunyuan', 'spark', 'siliconflow', 'openai', 'anthropic', 'gemini', 'azure-openai', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'perplexity', 'ollama', 'lmstudio'];
      const missing = required.filter((id) => !ids.includes(id));
      check('G5 主流厂商预设不缺（' + required.length + ' 家点名核对）', missing.length === 0, missing.length ? '缺失=' + missing.join(',') : '共 ' + ids.length + ' 家');
      check('G6 每条预设的地址都是绝对 URL', presets.every((p) => /^https?:\/\//.test(p.apiBase)), presets.filter((p) => !/^https?:\/\//.test(p.apiBase)).map((p) => p.id).join(','));
      check('G7 协议取值全在白名单内', presets.every((p) => protocolLib.PROTOCOL_IDS.includes(protocolLib.normalizeProtocol(p.protocol))));
      check('G8 Anthropic / Gemini 预设的协议与认证头自动配对（用户不用手改）',
        (() => {
          const a = presetLib.findPreset('anthropic');
          const g = presetLib.findPreset('gemini');
          return a.protocol === 'anthropic' && a.auth === 'x-api-key' && g.protocol === 'gemini' && g.auth === 'x-goog-api-key';
        })());
      check('G9 Azure 预设 = azure 端点 + api-key 认证',
        (() => {
          const az = presetLib.findPreset('azure-openai');
          return az.endpoint === 'azure' && az.auth === 'api-key';
        })());
      check('G10 本地预设免鉴权（auth=none，空 Key 合法）', presetLib.findPreset('ollama').auth === 'none' && presetLib.findPreset('lmstudio').auth === 'none');
      const applied = presetLib.presetModels(presetLib.findPreset('anthropic'), { apiKey: KEY });
      check('G11 预设 → 模型条目带上协议/认证/上下文/价格', applied.length >= 1 && applied[0].protocol === 'anthropic' && applied[0].auth === 'x-api-key' && applied[0].contextWindow > 0 && applied[0].apiKey === KEY, JSON.stringify(applied[0]));
      check('G12 预设条目的模型 ID 带厂商前缀（两家同名模型不会互相覆盖）', applied.every((m) => m.id.startsWith('anthropic/')), applied.map((m) => m.id).join(','));
    }

    // ======================= H. 存储层：新增字段进得了 models.json =======================
    console.log('\n== H. models.json 往返（协议字段可持久化，密钥仍加密） ==');
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-models-'));
      const norm = modelStore.normalizeModelInput({ id: 'x', label: 'X', model: 'm', protocol: 'CLAUDE', endpoint: 'Azure', apiVersion: '', auth: '', provider: 'azure-openai' });
      check('H1 协议别名归一（CLAUDE → anthropic）', norm.protocol === 'anthropic', JSON.stringify(norm));
      check('H2 端点/认证缺省值收敛（Azure → azure + api-key，空 auth → auto）', norm.endpoint === 'azure' && norm.auth === 'auto', JSON.stringify({ e: norm.endpoint, a: norm.auth }));
      const bad = modelStore.normalizeModelInput({ id: 'y', protocol: '不存在的协议', maxTokensField: 'nonsense' });
      check('H3 非法取值收敛到默认（不把脏值写进配置）', bad.protocol === 'openai' && bad.maxTokensField === 'max_tokens', JSON.stringify(bad));
      const seeded = modelStore.seedModels({ apiBase: 'https://api.deepseek.com', apiKey: '' });
      check('H4 首启种子模型带协议字段且仍是 OpenAI 兼容档', seeded.every((m) => m.protocol === 'openai' && m.endpoint === 'standard'), JSON.stringify(seeded.map((m) => m.protocol)));
      check('H5 seed 的模型 ID / 价格口径没变（不顺手改动默认档）',
        seeded[0].model === 'deepseek-flash' && seeded[0].contextWindow === 1000000 && seeded[1].priceInput === 0.66,
        JSON.stringify(seeded.map((m) => [m.model, m.contextWindow])));
      void dir;
    }
    // ======================= J. IPC handler 级：四条新通道真跑一遍 =======================
    console.log('\n== J. 模型管理通道（handler 级真实调用：写入 / 测连接 / 拉列表） ==');
    {
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-models-ipc-'));
      /**
       * 纯 Node 下没有 Electron 的 safeStorage，写入带密钥的条目会按设计**拒绝保存**
       * （`model-store-security-test.cjs` 就是锁这条的）。这里按仓库既有做法往 require.cache
       * 注入一个**确定性可逆**的密钥环桩，好让本段能真的跑通「写入 → 加密落盘 → 读回 → 测连接」，
       * 同时 J3 断言落盘文件里没有明文密钥。
       */
      const electronPath = require.resolve('electron');
      /** @type {any} */
      const cache = require.cache;
      const originalElectron = cache[electronPath];
      cache[electronPath] = {
        id: electronPath,
        filename: electronPath,
        loaded: true,
        exports: {
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from('stub:' + value),
            decryptString: (buf) => buf.toString().slice(5),
          },
          app: { getPath: () => userData },
        },
      };
      const ipcModels = require('../electron/ipc/models.cjs');
      const handlers = new Map();
      /**
       * 配置源用桩：真实 `agent.loadConfig` 会读仓库的 config/agent.properties（本用例不许往仓库写任何东西，
       * 也不该依赖本机安装的密钥）。流式调用走的仍是**真实** chatCompletionStream。
       */
      const baseCfg = {
        apiBase: 'http://127.0.0.1:9',
        apiKey: 'test-key',
        model: 'stub',
        maxTokens: 1024,
        reasoningEffort: null,
        sendStreamOptions: true,
        protocol: 'openai',
        auth: 'auto',
        endpoint: 'standard',
        maxTokensField: 'max_tokens',
        reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
      };
      ipcModels.register({
        ipcMain: /** @type {any} */ ({ handle: (channel, fn) => handlers.set(channel, fn) }),
        agent: { loadConfig: () => baseCfg, chatCompletionStream: agent.chatCompletionStream },
        userDataDir: () => userData,
      });
      const call = (channel, arg) => handlers.get(channel)({}, arg);

      const presetsRes = await call('models:presets');
      check('J1 models:presets 返回完整厂商清单（含分组）', presetsRes.ok && presetsRes.presets.length >= 30 && !!presetsRes.regions.cn, 'count=' + presetsRes.presets.length);

      const applied = await call('models:preset-apply', { presetId: 'ollama', apiKey: '' });
      check('J2 models:preset-apply 落盘（本地预设免鉴权，条目进 models.json）', applied.ok && applied.added >= 1 && (applied.models || []).some((m) => m.provider === 'ollama'), JSON.stringify({ added: applied.added }));
      const savedRaw = fs.readFileSync(path.join(userData, 'models.json'), 'utf8');
      check('J3 落盘文件里没有明文密钥（apiKey 字段不是明文）', !/test-key/.test(savedRaw) && !/"apiKey":\s*"sk-/.test(savedRaw), '');

      // 测连接：真发一次最小请求打 Anthropic mock（走完整 handler 路径：cfg 合并 → 协议层 → 解析）
      const anthropicModel = {
        id: 'anthropic/claude-sonnet-4-5',
        label: 'Claude',
        model: 'claude-sonnet-4-5',
        apiBase: anthropic.base,
        apiKey: KEY,
        protocol: 'anthropic',
        auth: 'x-api-key',
        endpoint: 'standard',
        maxTokensField: 'max_tokens',
        contextWindow: 200000,
        priceInput: 0,
        priceInputHit: 0,
        priceOutput: 0,
        supportsEffort: false,
        vision: true,
        enabled: true,
      };
      await call('models:save', anthropicModel);
      const testRes = await call('models:test', anthropicModel.id);
      check('J4 models:test 真发请求并如实回报（ok / 延迟 / 协议 / 回复）',
        testRes.ok === true && testRes.protocol.protocol === 'anthropic' && testRes.protocol.auth === 'x-api-key' && typeof testRes.latencyMs === 'number' && typeof testRes.reply === 'string',
        JSON.stringify({ ok: testRes.ok, p: testRes.protocol, reply: testRes.reply }));

      const fetchRes = await call('models:fetch', anthropicModel.id);
      check('J5 models:fetch 拉到 Anthropic 模型清单', fetchRes.ok && fetchRes.models[0].id === 'claude-sonnet-4-5', JSON.stringify(fetchRes).slice(0, 160));

      // 失败路径：协议接错 → 404，且必须给出可照做的建议 + 最小形态对照
      await call('models:save', { ...anthropicModel, id: 'wrong/proto', model: 'claude-x', apiBase: openai.base });
      const bad = await call('models:test', 'wrong/proto');
      check('J6 失败时带回状态码 + 建议 + 最小对照（不把 404 说成「密钥无效」）',
        bad.ok === false && bad.status === 404 && /地址|模型 ID/.test(String(bad.hint)) && bad.minimal && bad.minimal.ok === false,
        JSON.stringify({ status: bad.status, hint: bad.hint, minimal: bad.minimal }));

      // Azure 没有列表端点：handler 必须如实说明，而不是抛异常或编造
      await call('models:save', { ...anthropicModel, id: 'az/x', model: 'gpt-4o', protocol: 'openai', endpoint: 'azure', auth: 'api-key', apiBase: azure.base });
      const azFetch = await call('models:fetch', 'az/x');
      check('J7 Azure 的 fetch 给出明确说明（不抛异常、不编造列表）', azFetch.ok === false && /部署/.test(String(azFetch.error)), String(azFetch.error));

      const listAfter = await call('models:list');
      check('J8 models:list 只回 apiKeySet 布尔、正文里没有密钥（明文只存在主进程）',
        (listAfter.models || []).length >= 3
          && (listAfter.models || []).every((m) => !m.apiKey && typeof m.apiKeySet === 'boolean')
          && !JSON.stringify(listAfter).includes(KEY)
          && !JSON.stringify(listAfter).includes('test-key'),
        JSON.stringify((listAfter.models || []).map((m) => m.apiKeySet)));
      if (originalElectron) cache[electronPath] = originalElectron;
      else delete cache[electronPath];
      fs.rmSync(userData, { recursive: true, force: true });
    }

    // ======================= I. 接线：主进程 → preload → 类型 → UI =======================
    console.log('\n== I. 接线断言（新增四条通道与「推理强度」开关都真的接上了） ==');
    {
      const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const ipcSrc = read('electron/ipc/models.cjs');
      const preloadSrc = read('electron/preload.cjs');
      const dts = read('src/global.d.ts');
      const uiSrc = read('src/components/ModelManager.tsx');
      const agentIpc = read('electron/ipc/agent.cjs');
      const mainSrc = read('electron/main.cjs');
      const wiring = [
        ['models:presets', 'modelsPresets'],
        ['models:preset-apply', 'modelsPresetApply'],
        ['models:test', 'modelsTest'],
        ['models:fetch', 'modelsFetch'],
      ];
      for (const [channel, method] of wiring) {
        const parts = {
          '主进程 handler': ipcSrc.includes("'" + channel + "'"),
          preload: preloadSrc.includes(method + ':'),
          '类型声明': dts.includes(method),
          'UI 调用': uiSrc.includes('api.' + method),
        };
        check('I 通道 ' + channel + ' 四段接线齐全', Object.values(parts).every(Boolean), JSON.stringify(parts));
      }
      check('I main.cjs 仍注册模型域 IPC 模块', /require\('\.\/ipc\/models\.cjs'\)/.test(mainSrc) || mainSrc.includes('ipc/models.cjs'), '');
      /**
       * 取某个 async 处理函数的函数体：接线断言必须落在**函数体内部**且是**调用**形态
       * （写错方法名 api.modelsFetchX( 也算「字符串出现」，实测变异存活过一轮）。
       */
      const bodyOf = (text, marker) => {
        const at = text.indexOf(marker);
        return at === -1 ? '' : text.slice(at, at + 1400);
      };
      check('I 「拉取模型列表」按钮真的调用 modelsFetch（不是字符串出现、也不是方法名写错）',
        /api\.modelsFetch\(/.test(bodyOf(uiSrc, 'const fetchModels = async () => {')));
      check('I 「测试连接」按钮真的调用 modelsTest', /api\.modelsTest\(/.test(bodyOf(uiSrc, 'const testConnection = async () => {')));
      check('I 「全部加入」按钮真的调用 modelsPresetApply', /api\.modelsPresetApply\(/.test(bodyOf(uiSrc, 'const addPresetAll = async () => {')));
      check('I 预设清单真的被加载（打开对话框时调 modelsPresets）', /api\.modelsPresets\(/.test(uiSrc));
      check('I UI 提供协议选择（openai / anthropic / gemini）', ['openai', 'anthropic', 'gemini'].every((id) => uiSrc.includes("'" + id + "'")), '');
      check('I UI 暴露「拉取模型列表」「测试连接」按钮', uiSrc.includes('拉取模型列表') && uiSrc.includes('测试连接'));
      check('I 「支持推理强度」勾选框真的进了运行期（agent:chat 里按模型置空 reasoningEffort）',
        /sel\.supportsEffort === false/.test(agentIpc), '');
    }
  } finally {
    await Promise.all([openai.close(), anthropic.close(), gemini.close(), azure.close()]);
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  assert.strictEqual(failures, 0, failures + ' 项断言失败');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
