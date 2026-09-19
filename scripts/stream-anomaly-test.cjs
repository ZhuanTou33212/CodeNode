/**
 * stream-anomaly-test.cjs —— 回归 #12：流内异常必须被消费
 *
 * 缺陷：`electron/streamAccumulator.cjs` 早就会把「HTTP 200 的流里下发了 error 对象」
 * 记成 `in-stream-error`（返回 `anomalies`），但主循环**从不读**它 ——
 * 于是一个完全没有产出、或只有半截回答的「成功」回合会被当 COMPLETED 交付：
 * 没有报错、没有 run 事件、不发 error 增量，用户与排障者都拿不到任何归因线索
 * （这正是被反复修过的「回答写一半就断」的残留形态之一）。
 *
 * 判据（三段，含反向锁）：
 *   A. 200 流里带 error 对象、且本轮无任何产出 → **必须**判为失败（stopReason=stream_error），
 *      不发 done 增量、发 error 增量；
 *   B. 反向锁：正常内容、没有 error 对象 → 不得被误判成失败；
 *   C. 流内既有内容又有 error → 不得丢掉已经产出的正文。
 *
 * 本用例自带 fetch stub（不依赖 scripts/lib/scripted-model.cjs）：
 * 后者只能造「标准成功流」与「HTTP>=400」，造不出「200 流里内联 error」这种真实形态。
 */
'use strict';

const agent = require('../electron/agent.cjs');

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

/** 用一条受控 SSE 流替换 global.fetch（HTTP 200）。返回还原函数。 */
function stubFetch(lines) {
  const stream = lines.join('') + 'data: [DONE]\n\n';
  const original = global.fetch;
  /** 只兑现被测代码用到的字段（ok/status/headers/text/body.getReader），是 Response 的子集 → any 别名 */
  global.fetch = /** @type {any} */ (async () => ({
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
  }));
  return () => {
    global.fetch = original;
  };
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

  // ---- C. 既有内容又有 error → 不得丢掉已产出的正文 ----
  {
    const restore = stubFetch([
      sse({ choices: [{ index: 0, delta: { content: '已经写了一半' } }] }),
      sse({ error: { message: 'stream broke', type: 'server_error' } }),
      stopChunk(4),
    ]);
    let result;
    try {
      result = await agent.runAgentChat({
        cfg: cfgFor(),
        messages: [{ role: 'user', content: '你好' }],
        tools: null,
        onDelta: () => {},
      });
    } finally {
      restore();
    }
    check(
      '[#12] 流内既有内容又有 error → 不丢已产出的正文',
      String(result.content || '').includes('已经写了一半'),
      String(result.content || '').slice(0, 40)
    );
  }

  console.log(failures === 0 ? 'STREAM ANOMALY TEST: PASS' : 'STREAM ANOMALY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('STREAM ANOMALY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
