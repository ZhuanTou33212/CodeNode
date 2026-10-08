/**
 * stream-anomaly-test.cjs —— 回归 #12：流内异常必须被消费
 *
 * 缺陷：`electron/streamAccumulator.cjs` 早就会把「HTTP 200 的流里下发了 error 对象」
 * 记成 `in-stream-error`（返回 `anomalies`），但主循环**从不读**它 ——
 * 于是一个完全没有产出、或只有半截回答的「成功」回合会被当 COMPLETED 交付：
 * 没有报错、没有 run 事件、不发 error 增量，用户与排障者都拿不到任何归因线索
 * （这正是被反复修过的「回答写一半就断」的残留形态之一）。
 *
 * 判据：
 *   A. 200 流里带 error 对象 → 判为失败（stopReason=stream_error），
 *      即使已经有正文或完整形状的 tool call，也不发 done、不执行工具；
 *   B. 反向锁：正常内容、没有 error 对象 → 不得被误判成失败；
 *   C. 正常 EOF 缺少 [DONE] 和 finish_reason → 视为中断并整轮重发；
 *      重试用尽时，完整形状的 tool call 也不得执行。
 *
 * 本用例自带 fetch stub（不依赖 scripts/lib/scripted-model.cjs）：
 * 后者只能造「标准成功流」与「HTTP>=400」，造不出「200 流里内联 error」这种真实形态。
 */
'use strict';

const agent = require("../../electron/agent.cjs");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('PASS  ' + label + (detail ? ' :: ' + detail : ''));
    return;
  }
  failures += 1;
  console.error('FAIL  ' + label + (detail ? ' :: ' + detail : ''));
}

const encoder = new TextEncoder();
const sse = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';

/** 用受控 SSE 流替换 global.fetch（HTTP 200）；可为每次整轮重发指定不同响应。 */
function stubFetch(lines, options = {}) {
  const original = global.fetch;
  let calls = 0;
  /** 只兑现被测代码用到的字段（ok/status/headers/text/body.getReader），是 Response 的子集 → any 别名 */
  global.fetch = /** @type {any} */ (async () => {
    const attempts = options.attempts;
    const spec = attempts ? attempts[Math.min(calls, attempts.length - 1)] : { lines, done: options.done };
    calls += 1;
    const stream = (spec.lines || []).join('') + (spec.done === false ? '' : 'data: [DONE]\n\n');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => stream,
      json: async () => ({}),
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: encoder.encode(stream) };
            },
          };
        },
      },
    };
  });
  const restore = () => {
    global.fetch = original;
  };
  restore.calls = () => calls;
  return restore;
}

function cfgFor() {
  return {
    apiBase: 'http://scripted.local/v1',
    apiKey: 'k',
    model: 'stream-anomaly-test',
    maxTokens: 512,
    reasoningEffort: '',
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2, streamMaxAttempts: 0 },
    limits: { maxTotalTokens: 1000000 },
    compression: { enabled: false },
    context: { enabled: false },
    compaction: { ...agent.parseCompactionConfig({}), enabled: false },
    contextWindow: 0,
    rag: { enabled: false },
    tools: {},
  };
}

const stopChunk = (completion) =>
  sse({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: completion, total_tokens: 10 + completion },
  });

const toolChunk = () => sse({
  choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: 'call_spy', type: 'function', function: { name: 'spy', arguments: '{}' } },
  ] } }],
});

function spyTools(onExecute) {
  return {
    registry: {
      toOpenAiTools: () => [{ type: 'function', function: { name: 'spy', description: 'spy', parameters: { type: 'object', properties: {} } } }],
      execute: async () => {
        onExecute();
        return { ok: true, text: 'executed' };
      },
    },
    context: null,
  };
}

(async () => {
  // ---- A. 200 流里带 error 对象 + 本轮无产出 → 必须判失败 ----
  {
    const restore = stubFetch([
      sse({ error: { message: 'upstream overloaded', type: 'server_error' } }),
      stopChunk(0),
    ]);
    const deltas = [];
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(),
        messages: [{ role: 'user', content: '你好' }],
        tools: null,
        onDelta: (d) => deltas.push(d),
      });
    } finally {
      restore();
    }
    const kinds = deltas.map((d) => d.kind).join(',');
    check('[#12] 流内 error 且无产出 → 必须给出 error', !!result.error, String(result.error || '').slice(0, 80));
    check('[#12] 流内 error 且无产出 → stopReason=stream_error', result.stopReason === 'stream_error', String(result.stopReason));
    check('[#12] 流内 error 且无产出 → 不得发 done（不伪装成完成）', !deltas.some((d) => d.kind === 'done'), kinds);
    check('[#12] 流内 error 且无产出 → 发 error 增量', deltas.some((d) => d.kind === 'error'), kinds);
  }

  // ---- B. 反向锁：正常流不得被误判成失败 ----
  {
    const restore = stubFetch([
      sse({ choices: [{ index: 0, delta: { content: '正常回答' } }] }),
      stopChunk(5),
    ]);
    const deltas = [];
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(),
        messages: [{ role: 'user', content: '你好' }],
        tools: null,
        onDelta: (d) => deltas.push(d),
      });
    } finally {
      restore();
    }
    check(
      '[#12] 正常流不得被判成失败',
      !result.error && result.stopReason !== 'stream_error',
      JSON.stringify({ error: result.error || null, stopReason: result.stopReason || null })
    );
    check('[#12] 正常流照常交付 done', deltas.some((d) => d.kind === 'done'), deltas.map((d) => d.kind).join(','));
    check('[#12] 正常流正文完整', String(result.content || '').includes('正常回答'), String(result.content || '').slice(0, 30));
  }

  // ---- C. 既有内容又有 error → 保留半截以便排障，但终态必须失败 ----
  {
    const restore = stubFetch([
      sse({ choices: [{ index: 0, delta: { content: '已经写了一半' } }] }),
      sse({ error: { message: 'stream broke', type: 'server_error' } }),
      stopChunk(4),
    ]);
    const deltas = [];
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(),
        messages: [{ role: 'user', content: '你好' }],
        tools: null,
        onDelta: (d) => deltas.push(d),
      });
    } finally {
      restore();
    }
    check(
      '[#12] 流内既有内容又有 error → 不丢已产出的正文',
      String(result.content || '').includes('已经写了一半'),
      String(result.content || '').slice(0, 40)
    );
    check('[#12] 半截正文后报错 → FAILED / stream_error，且不发 done',
      result.state === 'FAILED' && result.stopReason === 'stream_error' &&
      deltas.some((d) => d.kind === 'error') && !deltas.some((d) => d.kind === 'done'),
      JSON.stringify({ state: result.state, stopReason: result.stopReason, deltas: deltas.map((d) => d.kind) }));
  }

  // ---- D. 200 流里先给完整形状的 tool call 后报错 → 不执行 ----
  {
    let executions = 0;
    const restore = stubFetch([toolChunk(), sse({ error: { message: 'tool stream broke' } }), stopChunk(0)]);
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(), messages: [{ role: 'user', content: '调用工具' }],
        tools: spyTools(() => { executions += 1; }), onDelta: () => {},
      });
    } finally { restore(); }
    check('[流内 error] 已流出的完整工具参数也不能执行',
      executions === 0 && result.state === 'FAILED' && result.stopReason === 'stream_error',
      JSON.stringify({ executions, state: result.state, stopReason: result.stopReason }));
  }

  // ---- D2. 供应商报错后直接 EOF，也应保留 stream_error 原因 ----
  {
    const restore = stubFetch([
      sse({ choices: [{ index: 0, delta: { content: '半截' } }] }),
      sse({ error: { message: 'provider failed' } }),
    ], { done: false });
    let result;
    try {
      result = await agent.runAgentChat({ cfg: cfgFor(), messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: () => {} });
    } finally { restore(); }
    check('[流内 error + EOF] 保留供应商报错归因',
      result.state === 'FAILED' && result.stopReason === 'stream_error' && result.content === '半截',
      JSON.stringify({ state: result.state, stopReason: result.stopReason, content: result.content }));
  }

  // ---- E. 正常 EOF 但没有结束信号：完整工具参数也只是未确认的片段 ----
  {
    let executions = 0;
    const restore = stubFetch([toolChunk()], { done: false });
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(), messages: [{ role: 'user', content: '调用工具' }],
        tools: spyTools(() => { executions += 1; }), onDelta: () => {},
      });
    } finally { restore(); }
    check('[缺结束信号] 工具未执行且 run 判 FAILED',
      executions === 0 && result.state === 'FAILED' && /结束标记/.test(String(result.error || '')),
      JSON.stringify({ executions, state: result.state, error: result.error }));
  }

  // ---- F. 缺结束信号时整轮重发；旧半截必须从界面和最终结果中清掉 ----
  {
    const restore = stubFetch([], { attempts: [
      { lines: [sse({ choices: [{ index: 0, delta: { content: '旧半截' } }] })], done: false },
      { lines: [sse({ choices: [{ index: 0, delta: { content: '完整回答' } }] }), stopChunk(4)], done: true },
    ] });
    const deltas = [];
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: { ...cfgFor(), reliability: { ...cfgFor().reliability, streamMaxAttempts: 1 } },
        messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: (d) => deltas.push(d),
      });
      check('[缺结束信号] 整轮重发一次', restore.calls() === 2, 'calls=' + restore.calls());
    } finally { restore(); }
    check('[缺结束信号] 旧半截被复位，最终仅交付重发结果',
      result.content === '完整回答' && result.state === 'COMPLETED' && deltas.some((d) => d.kind === 'content_reset'),
      JSON.stringify({ content: result.content, state: result.state, resets: deltas.filter((d) => d.kind === 'content_reset').length }));
  }

  // ---- G. 兼容只给 finish_reason、没有 [DONE] 的网关 ----
  {
    const restore = stubFetch([sse({ choices: [{ index: 0, delta: { content: '正常结束' } }] }), stopChunk(4)], { done: false });
    let result;
    try {
      result = await agent.runAgentChat({ cfg: cfgFor(), messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: () => {} });
    } finally { restore(); }
    check('[finish_reason] 无 [DONE] 仍可正常完成', result.content === '正常结束' && result.state === 'COMPLETED',
      JSON.stringify({ content: result.content, state: result.state }));
  }

  // ---- H. Gemini 的普通 EOF 不得由协议翻译层伪造成 [DONE] ----
  {
    const restore = stubFetch([sse({ candidates: [{ content: { role: 'model', parts: [{ text: '未结束' }] } }] })], { done: false });
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: { ...cfgFor(), protocol: 'gemini' }, messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: () => {},
      });
    } finally { restore(); }
    check('[Gemini 缺结束信号] 不伪造完成', result.state === 'FAILED' && /结束标记/.test(String(result.error || '')),
      JSON.stringify({ state: result.state, error: result.error }));
  }

  // ---- I. 损坏数据行即使后续收到 stop/[DONE]，也不能被当作成功 ----
  {
    const restore = stubFetch([
      'data: {broken-json\n\n',
      sse({ choices: [{ index: 0, delta: { content: '剩余内容' } }] }),
      stopChunk(4),
    ]);
    let result;
    try {
      result = await agent.runAgentChat({ cfg: cfgFor(), messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: () => {} });
    } finally { restore(); }
    check('[坏 SSE 行] 后续正常结束也判 stream_error',
      result.state === 'FAILED' && result.stopReason === 'stream_error' && /unparsable-data-line/.test(String(result.error || '')),
      JSON.stringify({ state: result.state, stopReason: result.stopReason, error: result.error }));
  }

  // ---- J. 原生协议解析失败必须透传到统一错误通道 ----
  {
    const restore = stubFetch([
      'data: {broken-native-frame\n\n',
      sse({ candidates: [{ content: { role: 'model', parts: [{ text: '剩余内容' }] }, finishReason: 'STOP' }] }),
    ], { done: false });
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: { ...cfgFor(), protocol: 'gemini' }, messages: [{ role: 'user', content: '你好' }], tools: null, onDelta: () => {},
      });
    } finally { restore(); }
    check('[Gemini 坏帧] 不静默跳过后交付成功',
      result.state === 'FAILED' && result.stopReason === 'stream_error' && /invalid_stream_frame/.test(String(result.error || '')),
      JSON.stringify({ state: result.state, stopReason: result.stopReason, error: result.error }));
  }

  // ---- K. 坏行与完整形状的工具调用同轮出现，仍不得执行 ----
  {
    let executions = 0;
    const restore = stubFetch([toolChunk(), 'data: {broken-json\n\n', stopChunk(4)]);
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(), messages: [{ role: 'user', content: '调用工具' }],
        tools: spyTools(() => { executions += 1; }), onDelta: () => {},
      });
    } finally { restore(); }
    check('[坏 SSE 行 + tool call] 不能执行工具',
      executions === 0 && result.state === 'FAILED' && result.stopReason === 'stream_error',
      JSON.stringify({ executions, state: result.state, stopReason: result.stopReason }));
  }

  console.log(failures === 0 ? 'STREAM ANOMALY TEST: PASS' : 'STREAM ANOMALY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('STREAM ANOMALY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
