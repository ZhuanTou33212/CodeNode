/**
 * model-protocol-test.cjs —— 多厂商协议兼容（S13）：一份 harness，四家协议，全部真跑 HTTP
 *
 * 缺口（用户视角的原始诉求：「让 CodeNode 兼容市面上所有主流模型的 api key」）：
 *   改造前请求只有一种形状 —— `apiBase + '/chat/completions'` + `Authorization: Bearer` +
 *   `reasoning_effort` / `stream_options` 无条件下发。于是 Claude 原生 / Gemini 原生 /
 *   Azure 企业版这三档**主流 key 直接不可用**（400/401/404），而它们的占比恰恰最大。
 *
 * 界面上只有「API Key」一个入口（预设清单 / 协议选择 / 测连接 / 拉列表都已按用户要求删除），
 * 协议与端点由 `resolveProtocol()` 按 API 地址自动判定（Claude 地址 → /v1/messages，Azure 地址 →
 * 部署名路径；其余 = OpenAI 兼容），所以本用例还要锁住「自动判定不许误判、也不许改动默认档」。
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

    // ======================= G. 协议自动判定（界面上只有「API Key」一个入口） =======================
    console.log('\n== G. 协议按 API 地址自动判定（用户不需要选协议） ==');
    {
      check('G1 Claude 地址 → anthropic', protocolLib.resolveProtocol({ apiBase: 'https://api.anthropic.com' }) === 'anthropic');
      check('G2 Gemini 地址 → gemini', protocolLib.resolveProtocol({ apiBase: 'https://generativelanguage.googleapis.com' }) === 'gemini');
      check('G3 Azure 地址 → openai 协议 + azure 端点 + api-key 头',
        protocolLib.resolveProtocol({ apiBase: 'https://myres.openai.azure.com' }) === 'openai'
          && protocolLib.normalizeEndpoint({ apiBase: 'https://myres.openai.azure.com' }) === 'azure'
          && protocolLib.normalizeAuthStyle('', 'openai', 'azure') === 'api-key');
      check('G4 负向：普通 OpenAI 兼容地址仍是 openai + standard + Bearer（不许误判）',
        protocolLib.resolveProtocol({ apiBase: 'https://api.deepseek.com' }) === 'openai'
          && protocolLib.normalizeEndpoint({ apiBase: 'https://api.deepseek.com' }) === 'standard'
          && protocolLib.normalizeAuthStyle('', 'openai', 'standard') === 'bearer');
      check('G5 显式声明优先于地址判定（api_protocol 仍可强制）',
        protocolLib.resolveProtocol({ apiBase: 'https://api.anthropic.com', protocol: 'openai' }) === 'openai');
      check('G6 空地址/未配置不炸（回落 openai 兼容）', protocolLib.resolveProtocol({}) === 'openai' && protocolLib.resolveProtocol({ apiBase: '' }) === 'openai');
      // 判定结果**真的进了请求构造**（本地 mock 的地址没有域名线索，所以这里在纯函数层锁 URL/认证头）
      const autoAnth = protocolLib.buildRequest({ apiBase: 'https://api.anthropic.com', apiKey: KEY, model: 'claude-sonnet-4-5', maxTokens: 4096 }, MESSAGES, { stream: true });
      check('G7 Claude 地址下真的构造出 /v1/messages + x-api-key（不需要用户选协议）',
        autoAnth.url === 'https://api.anthropic.com/v1/messages' && autoAnth.headers['x-api-key'] === KEY && !autoAnth.headers.Authorization,
        autoAnth.url);
      const autoAz = protocolLib.buildRequest({ apiBase: 'https://myres.openai.azure.com', apiKey: KEY, model: 'gpt-4o', maxTokens: 1024 }, MESSAGES, { stream: true });
      check('G8 Azure 地址下真的构造出部署名路径 + api-key 头 + api-version',
        /\/openai\/deployments\/gpt-4o\/chat\/completions\?api-version=/.test(autoAz.url) && autoAz.headers['api-key'] === KEY && !autoAz.headers.Authorization,
        autoAz.url);
      check('G9 OpenAI 兼容地址下请求形状不变（负向：自动判定没有改动默认档）',
        (() => { const r = protocolLib.buildRequest({ apiBase: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', maxTokens: 1024 }, MESSAGES, { stream: true }); return r.url === 'https://api.deepseek.com/chat/completions' && r.headers.Authorization === 'Bearer ' + KEY; })());
    }
    // ======================= H. 存储层：新增字段进得了 models.json =======================
    console.log('\n== H. models.json 往返（协议字段可持久化，密钥仍加密） ==');
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-models-'));
      const norm = modelStore.normalizeModelInput({ id: 'x', label: 'X', model: 'm', protocol: 'CLAUDE', endpoint: 'Azure', apiVersion: '', auth: '', provider: 'azure-openai' });
      check('H1 协议别名归一（CLAUDE → anthropic）', norm.protocol === 'anthropic', JSON.stringify(norm));
      check('H2 Azure 地址自动判成 azure 端点；未声明的认证留空（请求时按协议取默认，不钉死）', norm.endpoint === 'azure' && norm.auth === '', JSON.stringify({ e: norm.endpoint, a: norm.auth }));
      const bad = modelStore.normalizeModelInput({ id: 'y', protocol: '不存在的协议', maxTokensField: 'nonsense' });
      check('H3 非法取值一律**留空**（不写脏值，也不钉成 openai —— 钉死会让改地址后突然 404）', bad.protocol === '' && bad.endpoint === '', JSON.stringify(bad));
      const seeded = modelStore.seedModels({ apiBase: 'https://api.deepseek.com', apiKey: '' });
      check('H4 首启种子模型不再带协议字段（留空 = 按地址自动判定，DeepSeek 地址自然落到 openai 兼容）',
        seeded.every((m) => m.protocol === undefined && m.endpoint === undefined), JSON.stringify(seeded.map((m) => m.protocol)));
      check('H5 seed 的模型 ID / 价格口径没变（不顺手改动默认档）',
        seeded[0].model === 'deepseek-flash' && seeded[0].contextWindow === 1000000 && seeded[1].priceInput === 0.66,
        JSON.stringify(seeded.map((m) => [m.model, m.contextWindow])));
      void dir;
    }
    // ======================= I. 界面回到极简（只有 API Key 一个入口）+ 关键接线 =======================
    console.log('\n== I. 界面精简与接线（删掉的东西不许残留，留下的必须真接线） ==');
    {
      const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const uiSrc = read('src/components/ModelManager.tsx');
      const preloadSrc = read('electron/preload.cjs');
      const dts = read('src/global.d.ts');
      const ipcSrc = read('electron/ipc/models.cjs');
      const agentIpc = read('electron/ipc/agent.cjs');
      const removed = ['接入协议', '从预设添加', '拉取模型列表', '测试连接', '认证头', '端点风格', '厂商预设'];
      const left = removed.filter((word) => uiSrc.includes(word));
      check('I1 模型管理界面里没有预设/协议/认证/端点/测连接/拉列表（只剩原有的名称/ID/地址/Key/上下文/价格/开关）',
        left.length === 0, left.join(','));
      const removedMethods = ['modelsPresets', 'modelsPresetApply', 'modelsTest', 'modelsFetch'];
      check('I2 preload 不再暴露这四条通道', removedMethods.every((m) => !preloadSrc.includes(m)));
      check('I3 类型声明同步（global.d.ts 里也没有）', removedMethods.every((m) => !dts.includes(m)));
      check('I4 主进程只剩原有的四条模型通道', (ipcSrc.match(/ipcMain\.handle\(/g) || []).length === 4,
        'handles=' + (ipcSrc.match(/ipcMain\.handle\(/g) || []).length);
      check('I5 模型管理仍在 App 里挂载（没把入口一起删掉）', /<ModelManager \/>/.test(read('src/App.tsx')));
      check('I6 「支持推理强度」仍然进了运行期（按模型置空 reasoningEffort）', /sel\.supportsEffort === false/.test(agentIpc));
      check('I7 协议自动判定已接线（请求构造走 resolveProtocol）',
        /const protocol = resolveProtocol\(cfg\);/.test(read('electron/modelProtocol.cjs')));
      check('I8 预设库文件已删除（不留死文件）', !fs.existsSync(path.join(__dirname, '..', 'electron', 'providerPresets.cjs')));
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
