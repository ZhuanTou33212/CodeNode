/**
 * stream-recovery-test.cjs —— 流式回答「中途断掉」必须能自愈，且自愈过程不能让内容出错
 *
 * 背景（2026-09-17 实测）：网络/代理在 SSE 流**中途**重置时，此前的重试只覆盖**建连**阶段 ——
 * 响应体一开始流动，`reader.read()` 抛错就直接冒到主循环：用户看到回答写一半消失、
 * 报错是一句英文 `terminated`，而服务端只收到过 1 次请求（mock 实测）。
 *
 * 现在的行为（整轮语义）：
 *   ① 中途断线 / 停滞 → **丢弃半截、整轮重发**，重发前发 `stream_restart` 让界面与主循环
 *      把已流出的部分作废（否则两遍内容会叠在一起）；
 *   ② 停滞（连续 N 秒没有任何分片）与「总时长超限」分开判定，且**有数据就重置**停滞计时；
 *   ③ 用户主动取消不重发；重发次数用尽 → 中文错误 + 如实上报「已收到多少字」；
 *   ④ 重发过的输入要计进请求预算的补偿（attemptsRef），不能白烧额度。
 *
 * 判据一律落在**可观察终态**：mock 服务端收到的请求次数、真实 runAgentChat 的返回值、
 * 以及「界面按增量拼出来的文本」——不看内部变量。
 */
'use strict';

const http = require('http');

const agent = require('../electron/agent.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

function sse(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function contentChunk(text) {
  return sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function doneChunk(usage) {
  return (
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
    'data: [DONE]\n\n'
  );
}

/**
 * 极简 OpenAI 兼容 mock：每个请求按 behaviors[n] 演一段剧本。
 *   { mode: 'kill-after', chunks, delayMs }  吐 N 个分片后**杀连接**（模拟中途断线）
 *   { mode: 'stall', chunks }                吐 N 个分片后**永不再发**（模拟卡死）
 *   { mode: 'ok', text, chunkDelayMs }       正常流（可分包慢发）
 */
function startMock(behaviors) {
  const state = { requests: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const index = state.requests;
      state.requests += 1;
      try {
        state.bodies.push(JSON.parse(body));
      } catch {
        state.bodies.push(null);
      }
      const behavior = behaviors[Math.min(index, behaviors.length - 1)] || { mode: 'ok', text: '默认回答' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (behavior.mode === 'kill-after') {
        for (let i = 0; i < (behavior.chunks || 3); i++) res.write(contentChunk('半截片段' + (i + 1) + '。'));
        setTimeout(() => res.socket.destroy(), behavior.delayMs || 20);
        return;
      }
      if (behavior.mode === 'stall') {
        for (let i = 0; i < (behavior.chunks || 2); i++) res.write(contentChunk('停滞片段' + (i + 1) + '。'));
        // 之后既不写也不再发：连接保持打开 → 只能在停滞超时里被判定
        return;
      }
      const text = behavior.text || '默认回答';
      // 慢发模式按 20 字符一片（不是逐字符）：400 字 × 60ms 逐字符发会把用例拖到 24s
      const pieces = behavior.chunkDelayMs ? text.match(/[\s\S]{1,20}/g) || [text] : [text];
      let i = 0;
      const push = () => {
        if (i >= pieces.length) {
          try {
            res.write(doneChunk());
            res.end();
          } catch {}
          return;
        }
        try {
          res.write(contentChunk(pieces[i]));
        } catch {}
        i += 1;
        if (behavior.chunkDelayMs) setTimeout(push, behavior.chunkDelayMs);
        else push();
      };
      push();
    });
  });
  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(address && typeof address === 'object' ? address.port : 0);
        });
      }),
    close: () => {
      try {
        server.closeAllConnections();
      } catch {}
      server.close();
    },
  };
}

/** 界面侧的累加器：与 src/store/sessionStore.ts 的 streamDelta 同语义（content 追加 / content_reset 清空） */
function makeUiSink() {
  const sink = { content: '', reasoning: '', resets: 0, restarts: [], events: [] };
  return {
    sink,
    onDelta: (d) => {
      sink.events.push(d && d.kind);
      if (!d || !d.kind) return;
      if (d.kind === 'content' && d.text) sink.content += d.text;
      else if (d.kind === 'reasoning' && d.text) sink.reasoning += d.text;
      else if (d.kind === 'content_reset') {
        sink.resets += 1;
        sink.restarts.push(d);
        sink.content = '';
        sink.reasoning = '';
      }
    },
  };
}

function baseCfg(port, reliability) {
  return {
    apiBase: 'http://127.0.0.1:' + port,
    apiKey: 'test-key',
    model: 'mock-model',
    maxTokens: 512,
    reasoningEffort: '',
    reliability,
    limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
    compression: { enabled: false },
    rag: { enabled: false },
    tools: {},
  };
}

async function runChat(port, reliability, options = {}) {
  const { sink, onDelta } = makeUiSink();
  const controller = new AbortController();
  if (options.abortAfterMs) setTimeout(() => controller.abort(), options.abortAfterMs);
  const startedAt = Date.now();
  const result = await agent.runAgentChat({
    cfg: baseCfg(port, reliability),
    messages: [{ role: 'user', content: '请回答' }],
    tools: null,
    signal: controller.signal,
    onDelta,
  });
  return { result, sink, elapsedMs: Date.now() - startedAt };
}

const RECOVERY = { maxAttempts: 1, retryBaseMs: 5, retryMaxMs: 10, turnTimeoutMs: 20000, streamIdleTimeoutMs: 5000, streamMaxAttempts: 2 };

(async () => {
  // ---- (1) 中途断线 → 丢弃半截、整轮重发，最终答案干净且不重复 ----
  {
    const FULL = '完整回答：一二三四五六七八九十。';
    const mock = startMock([
      { mode: 'kill-after', chunks: 3 },
      { mode: 'ok', text: FULL },
    ]);
    const port = await mock.listen();
    const { result, sink } = await runChat(port, RECOVERY);
    mock.close();
    check('[中途断线] 服务端收到 2 次请求（真的重发了，不是拿半截交差）', mock.state.requests === 2, 'requests=' + mock.state.requests);
    check('[中途断线] 交付内容 == 重发后的完整回答', result.content === FULL, JSON.stringify(String(result.content)));
    check('[中途断线] 半截片段没有被交付', !String(result.content || '').includes('半截片段'), JSON.stringify(String(result.content).slice(0, 40)));
    check('[中途断线] 界面看到的文本 == 交付内容（content_reset 生效，没有两遍开头）', sink.content === FULL, JSON.stringify(sink.content.slice(0, 60)));
    check('[中途断线] 界面收到 1 次 content_reset', sink.resets === 1, 'resets=' + sink.resets);
    check('[中途断线] 返回值如实上报重发次数', result.streamRestarts === 1, 'streamRestarts=' + result.streamRestarts);
    check('[中途断线] 终态是正常完成（不是 FAILED）', result.state === 'COMPLETED' && !result.error, JSON.stringify({ state: result.state, error: result.error }));
  }

  // ---- (2) 重复断线但重发次数内 → 仍能成功（且每次都复位界面） ----
  {
    const FULL = '第二次重发才成功。';
    const mock = startMock([
      { mode: 'kill-after', chunks: 2 },
      { mode: 'kill-after', chunks: 2 },
      { mode: 'ok', text: FULL },
    ]);
    const port = await mock.listen();
    const { result, sink } = await runChat(port, RECOVERY);
    mock.close();
    check('[连续断线] 服务端收到 3 次请求', mock.state.requests === 3, 'requests=' + mock.state.requests);
    check('[连续断线] 交付内容干净且界面同步', result.content === FULL && sink.content === FULL, JSON.stringify({ r: String(result.content), ui: sink.content }));
    check('[连续断线] 重发次数上报 2', result.streamRestarts === 2, 'streamRestarts=' + result.streamRestarts);
  }

  // ---- (3) 停滞（连接活着但不再来数据）→ 中文错误 + 如实上报已收字数 ----
  {
    const mock = startMock([{ mode: 'stall', chunks: 2 }]);
    const port = await mock.listen();
    const { result, sink, elapsedMs } = await runChat(port, { ...RECOVERY, streamIdleTimeoutMs: 250, streamMaxAttempts: 1 });
    mock.close();
    check('[停滞] 重发次数用尽前重试过（服务端收到 2 次请求）', mock.state.requests === 2, 'requests=' + mock.state.requests);
    check('[停滞] 报错是中文「停滞」而不是英文 aborted', /停滞/.test(String(result.error || '')), String(result.error || '').slice(0, 80));
    check('[停滞] 报错里如实说明已收到的字数', /已收到 \d+ 字/.test(String(result.error || '')), String(result.error || '').slice(0, 80));
    check('[停滞] 已流出的部分仍留在返回值里（用户不是一无所获）', /停滞片段/.test(String(result.content || '')), JSON.stringify(String(result.content).slice(0, 40)));
    check('[停滞] 界面最终文本 == 返回值（复位与重发一致）', sink.content === String(result.content || ''), JSON.stringify({ ui: sink.content.slice(0, 30), r: String(result.content).slice(0, 30) }));
    check('[停滞] 停滞先于总时长上限触发（250ms << 20s）', elapsedMs < 5000, 'elapsedMs=' + elapsedMs);
    check('[停滞] 终态 FAILED', result.state === 'FAILED', String(result.state));
  }

  // ---- (4) 有数据就重置停滞计时：慢但在输出 → 不许误判为卡死 ----
  {
    // 必须**跨多个停滞窗口**才有判别力：40 段 × 120ms ≈ 4.8s 的流，停滞阈值 400ms
    // （分片太少/太快时，即使去掉「收到数据就重置」也照样能过 —— 那是空转用例）
    const text = '慢速流也要成功。'.repeat(40);
    const mock = startMock([{ mode: 'ok', text, chunkDelayMs: 120 }]);
    const port = await mock.listen();
    const { result, sink } = await runChat(port, { ...RECOVERY, streamIdleTimeoutMs: 400 });
    mock.close();
    check('[慢速流] 分包慢发（每 120ms 一片、跨多个停滞窗口）不被误判为停滞',
      result.content === text && !result.error,
      JSON.stringify({ chars: String(result.content || '').length, expect: text.length, error: result.error }));
    check('[慢速流] 没有多余重发', result.streamRestarts === 0, 'streamRestarts=' + result.streamRestarts);
    check('[慢速流] 界面文本与交付一致', sink.content === text, JSON.stringify(sink.content.length));
  }

  // ---- (5) 用户取消不重发（取消是用户意图，不能自作主张再来一次） ----
  {
    const mock = startMock([{ mode: 'ok', text: 'x'.repeat(400), chunkDelayMs: 60 }]);
    const port = await mock.listen();
    const { result, sink } = await runChat(port, RECOVERY, { abortAfterMs: 160 });
    mock.close();
    check('[用户取消] 只发了 1 次请求（不重发）', mock.state.requests === 1, 'requests=' + mock.state.requests);
    check('[用户取消] 归类为 aborted 而不是错误', result.aborted === true && !result.error, JSON.stringify({ aborted: result.aborted, error: result.error }));
    check('[用户取消] 界面不会收到 content_reset（内容没被抽走）', sink.resets === 0, 'resets=' + sink.resets);
  }

  // ---- (6) 正常一次流：不许产生多余事件（防过度修复） ----
  {
    const mock = startMock([{ mode: 'ok', text: '一切正常。' }]);
    const port = await mock.listen();
    const { result, sink } = await runChat(port, RECOVERY);
    mock.close();
    check('[正常流] 1 次请求、0 重发、0 复位', mock.state.requests === 1 && result.streamRestarts === 0 && sink.resets === 0,
      JSON.stringify({ req: mock.state.requests, restarts: result.streamRestarts, resets: sink.resets }));
    check('[正常流] 内容与终态不变', result.content === '一切正常。' && result.state === 'COMPLETED', JSON.stringify({ c: result.content, s: result.state }));
  }

  // ---- (7) 预算补偿：重发过的输入要计进 attemptsRef（不白烧额度） ----
  {
    const runBudgetChat = async (behaviors) => {
      const RequestBudget = require('../electron/requestBudget.cjs').RequestBudget;
      const budget = new RequestBudget(1000000);
      const mock = startMock(behaviors);
      const port = await mock.listen();
      const cfg = baseCfg(port, RECOVERY);
      cfg.requestBudget = budget;
      const result = await agent.runAgentChat({
        cfg,
        messages: [{ role: 'user', content: '请回答' }],
        tools: null,
        signal: new AbortController().signal,
        onDelta: () => {},
      });
      mock.close();
      return { result, used: budget.used };
    };
    const single = await runBudgetChat([{ mode: 'ok', text: '预算路径成功。' }]);
    const restarted = await runBudgetChat([
      { mode: 'kill-after', chunks: 2 },
      { mode: 'ok', text: '预算路径成功。' },
    ]);
    check('[预算补偿] 重发后仍能完成', restarted.result.content === '预算路径成功。', JSON.stringify(String(restarted.result.content)));
    // 输入被真实发送了 2 次 → 结算量必须明显多于「一次就好」的对照（去掉 sentBefore 补偿即红）
    check('[预算补偿] 结算量把重发的那份输入算进去了（> 单次对照）', restarted.used > single.used,
      JSON.stringify({ restarted: restarted.used, single: single.used }));
  }

  // ---- (8) 出厂配置口径 ----
  {
    const rel = agent.parseReliabilityConfig({});
    check('[出厂口径] streamMaxAttempts 默认 2', rel.streamMaxAttempts === 2, String(rel.streamMaxAttempts));
    check('[出厂口径] 停滞超时默认 120s、单轮 600s', rel.streamIdleTimeoutMs === 120000 && rel.turnTimeoutMs === 600000,
      JSON.stringify({ idle: rel.streamIdleTimeoutMs, turn: rel.turnTimeoutMs }));
    const cfg = agent.loadConfig(null);
    check('[出厂口径] max_tokens 不再是 8192 档位', cfg.maxTokens >= 16384, String(cfg.maxTokens));
  }

  console.log(failures === 0 ? 'STREAM RECOVERY TEST: PASS' : 'STREAM RECOVERY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('STREAM RECOVERY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
