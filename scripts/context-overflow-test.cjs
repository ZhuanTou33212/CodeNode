/**
 * context-overflow-test.cjs —— 「上下文超窗」这条最后路径：预检 + 供应商报错后的自救
 *
 * 背景：「回答写一半就断」的第 5 类根因是长会话把请求顶出模型窗口。压缩把这条路径从
 * 「迟早会撞」变成「基本不会撞」，但还有两种现实情况：
 *   ① 剩下的东西**本身**就超窗（压缩也压不动）→ 必须**别发出去吃 400**，并给出可执行的出路；
 *   ② 模型管理里填的窗口比供应商实际允许的**大**（标称 1M、实际 128k）→ 压缩线迟于 400 触发。
 *      真被拒过一次之后要**记住**这个模型的保守窗口下限，并把这一轮救回来（压一次 + 重发）。
 *
 * 判据全部落在可观察终态：实际发生的请求次数与请求体（payload.max_tokens）+ 返回值 + 增量事件。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compaction = require('../electron/compaction.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const DEEPSEEK_400 = JSON.stringify({
  error: {
    message: "This model's maximum context length is 65536 tokens. However, you requested 90000 tokens (87000 in the messages, 3000 in the completion). Please reduce the length of the messages or completion.",
    type: 'invalid_request_error',
    code: 'invalid_request_error',
  },
});
const zh = (chars) => '测'.repeat(chars);

async function run(options) {
  const cfg = {
    apiBase: 'http://scripted.local/v1',
    apiKey: 'k',
    model: 'scripted-model',
    maxTokens: options.maxTokens === undefined ? 2048 : options.maxTokens,
    reasoningEffort: '',
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2, streamMaxAttempts: 0 },
    limits: { maxTotalTokens: 1000000 },
    compression: { enabled: false },
    context: { enabled: false },
    compaction: { ...agent.parseCompactionConfig({}), enabled: true, ...(options.compaction || {}) },
    contextWindow: options.contextWindow,
    rag: { enabled: false },
    tools: {},
  };
  const stub = installScriptedModel(options.script, { loopLast: true });
  const deltas = [];
  try {
    const result = await agent.runAgentChat({
      cfg,
      messages: options.messages,
      tools: null,
      onDelta: (d) => deltas.push(d),
    });
    return { result, deltas, seen: stub.seen, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

(async () => {
  agent.resetContextWindowOverrides();

  // ---- 1. 预检：输入本身就超窗 → 一次请求都不发，如实报出来并给出出路 ----
  {
    const cfgWindow = 1000;
    const turn = await run({
      contextWindow: cfgWindow,
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: zh(4000) }, // ≈2800 token > 1000
      ],
      script: [{ content: '（不该被调用）', finishReason: 'stop' }],
    });
    check('[预检] 输入超窗 → 不发请求（calls=0）', turn.calls === 0, 'calls=' + turn.calls);
    check('[预检] stopReason=context_overflow，且错误文案给出可执行出路',
      turn.result.stopReason === 'context_overflow' &&
        /开一个新会话/.test(String(turn.result.error)) &&
        /上下文窗口/.test(String(turn.result.error)),
      String(turn.result.error).slice(0, 60));
    const pre = turn.deltas.find((d) => d.kind === 'context_overflow' && d.phase === 'preflight');
    check('[预检] 上报 tokens/window 供界面显示', !!pre && pre.tokens > cfgWindow && pre.window === cfgWindow, JSON.stringify(pre));
  }

  // ---- 2. 预检不误伤：窗口未知（只有兜底值）时，宁可发出去也不拒发 ----
  {
    const turn = await run({
      contextWindow: 0, // 没声明
      compaction: { contextWindow: 0, fallbackWindow: 500 }, // 兜底值极小（猜的）
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: zh(4000) },
      ],
      script: [{ content: '照常回答。', finishReason: 'stop' }],
    });
    check('[预检] 只有兜底窗口时不拒发（不误伤大窗口模型）', turn.calls === 1 && /照常回答/.test(String(turn.result.content)), 'calls=' + turn.calls);
  }

  // ---- 3. 挤掉输出预算 → 缩小 max_tokens 继续发（不是拒发） ----
  {
    const turn = await run({
      contextWindow: 3000,
      maxTokens: 4096, // 估算 ≈2400 + 4096 > 3000
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: zh(3400) },
      ],
      script: [{ content: '短回答。', finishReason: 'stop' }],
    });
    const capped = turn.deltas.find((d) => d.kind === 'max_tokens_capped');
    check('[输出预算] 挤压时缩小 max_tokens 而不是拒发', turn.calls === 1 && !!capped, 'calls=' + turn.calls);
    check('[输出预算] 缩小后的请求体真的用了新的 max_tokens',
      !!capped && capped.to < 4096 && capped.to > 0 && turn.seen[0].maxTokens === capped.to,
      JSON.stringify({ capped: capped && capped.to, sent: turn.seen[0] && turn.seen[0].maxTokens }));
  }

  // ---- 4. 供应商报超窗 → 记下保守窗口 + 强制压一次 + 重发（自救） ----
  {
    agent.resetContextWindowOverrides();
    const turn = await run({
      contextWindow: 100000, // 声明值很大：压缩线（90k）远不可及 —— 正是「标称大、实际小」的现场
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮：看 a.txt' },
        { role: 'assistant', content: zh(600) },
        { role: 'user', content: '第二轮：继续' },
      ],
      script: [
        { httpStatus: 400, body: DEEPSEEK_400 },            // 第 1 次：供应商说超窗
        { content: '交接摘要：已完成第一轮，下一步继续。', finishReason: 'stop' }, // 第 2 次：压缩
        { content: '救回来了，这是回答。', finishReason: 'stop' },                   // 第 3 次：重发成功
      ],
    });
    check('[自救] 400 之后压一次并重发（共 3 次请求）', turn.calls === 3, 'calls=' + turn.calls);
    check('[自救] 本轮交付成功，不是失败', /救回来了/.test(String(turn.result.content)), String(turn.result.content).slice(0, 20));
    check('[自救] 记下该模型的保守窗口下限（下次压缩线按它算）',
      agent.getContextWindowOverride({ apiBase: 'http://scripted.local/v1', model: 'scripted-model' }) > 0,
      String(agent.getContextWindowOverride({ apiBase: 'http://scripted.local/v1', model: 'scripted-model' })));
    const rec = turn.deltas.find((d) => d.kind === 'context_overflow' && d.phase === 'recovering');
    check('[自救] 上报「正在自救」+ 供应商原文，用户看得见原因', !!rec && /maximum context length/.test(String(rec.providerMessage)), JSON.stringify(rec && rec.window));
    const done = turn.deltas.find((d) => d.kind === 'compacted' && d.ok !== false);
    check('[自救] 压缩的触发来源标成 provider-rejected', !!done && done.trigger === 'provider-rejected', done && done.trigger);
    check('[自救] 重发的请求带的是**压缩后**的历史', turn.seen[2].messages.some((m) => String(m.content).startsWith('<compaction>')), JSON.stringify(turn.seen[2].messages.map((m) => m.role)));
    check('[自救] 结果里如实计数 overflowRecoveries=1', turn.result.overflowRecoveries === 1, String(turn.result.overflowRecoveries));
  }

  // ---- 5. 只救一次：压完还超 → 原样冒错（不无限烧钱） ----
  {
    agent.resetContextWindowOverrides();
    const turn = await run({
      contextWindow: 100000,
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: zh(600) },
        { role: 'user', content: '第二轮' },
      ],
      script: [
        { httpStatus: 400, body: DEEPSEEK_400 },                                 // 1: 超窗
        { content: '摘要。', finishReason: 'stop' },                              // 2: 压缩
        { httpStatus: 400, body: DEEPSEEK_400 },                                 // 3: 重发还超
        { content: '不该被调用', finishReason: 'stop' },
      ],
    });
    check('[只救一次] 重发仍超窗 → 不再压、不再试（calls=3）', turn.calls === 3, 'calls=' + turn.calls);
    check('[只救一次] 如实失败，错误里保留供应商原文', !!turn.result.error && /maximum context length/.test(String(turn.result.error)), String(turn.result.error).slice(0, 80));
    check('[只救一次] overflowRecoveries 记到 1（发生过一次自救）', turn.result.overflowRecoveries === 1, String(turn.result.overflowRecoveries));
  }

  // ---- 6. 非超窗的 400（真错误）不许被当成超窗处理 ----
  {
    agent.resetContextWindowOverrides();
    const turn = await run({
      contextWindow: 100000,
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '你好' },
      ],
      script: [{ httpStatus: 400, body: JSON.stringify({ error: { message: 'invalid tool schema: missing type', type: 'invalid_request_error' } }) }],
    });
    check('[非超窗 400] 不进自救逻辑（calls=1，不压缩）', turn.calls === 1, 'calls=' + turn.calls);
    check('[非超窗 400] 不留下假的窗口降级记录', agent.getContextWindowOverride({ apiBase: 'http://scripted.local/v1', model: 'scripted-model' }) === 0);
    check('[非超窗 400] 错误原样冒给用户（含真实原因）', /invalid tool schema/.test(String(turn.result.error)), String(turn.result.error).slice(0, 60));
    check('[非超窗 400] overflowRecoveries=0', turn.result.overflowRecoveries === 0, String(turn.result.overflowRecoveries));
  }

  // ---- 6b. 400 的第二种成因：输入装得下，但「输入 + max_tokens 输出预留」超窗 ----
  {
    agent.resetContextWindowOverrides();
    const turn = await run({
      contextWindow: 0, // 视作未知 → 不走预检，让「供应商」来拒
      compaction: { contextWindow: 0, fallbackWindow: 100000000 },
      // 荒谬的输出预留：DeepSeek 会回「you requested N tokens (X in the messages, Y in the completion)」。
      // 注意：这里原来写的是 999999，但配上 1048576 的窗口后「1500 + 999999 = 1001499 < 1048576」
      // —— 报错自己前后矛盾（按它给的数字本该被接受）。既然本轮起窗口改取**报错里的真实值**，
      // 就必须把夹具改成自洽的：输出预留真的把「输入 + 输出」顶过窗口。
      maxTokens: 1200000,
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: zh(400) },
        { role: 'user', content: '第二轮：继续' },
      ],
      script: [
        { httpStatus: 400, body: '{"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1201500 tokens (1500 in the messages, 1200000 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error"}}' },
        { content: '摘要：已完成第一轮。', finishReason: 'stop' }, // 压缩
        { content: '收缩输出后救回来了。', finishReason: 'stop' }, // 重发
      ],
    });
    check('[自救·输出预留] max_tokens 太大导致的 400 也能救（重发用的是收缩后的输出预算）',
      turn.calls === 3 && /救回来了/.test(String(turn.result.content)),
      'calls=' + turn.calls + ' content=' + String(turn.result.content).slice(0, 16));
    check('[自救·输出预留] 重发请求体的 max_tokens 明显小于原来的 1200000',
      turn.seen[2] && Number(turn.seen[2].maxTokens) < 1200000 && Number(turn.seen[2].maxTokens) > 0,
      String(turn.seen[2] && turn.seen[2].maxTokens));
    // 回归 #3：收缩必须按**报错里的真实窗口**算，而不是按「估算 × 0.9」这个下界。
    // 旧实现会把 max_tokens 砍到 ~1024（估算 1500×0.9=1350，减去估算再减 64）——回答被砍废。
    check('[自救·输出预留] 收缩后的预算贴着真实窗口（不是被估算下界砍成残废）',
      turn.seen[2] && Number(turn.seen[2].maxTokens) > 1000000,
      'maxTokens=' + String(turn.seen[2] && turn.seen[2].maxTokens));
  }

  // ---- 6c. 交互：压缩压不动 + 输入超窗 → 预检兜住（一次都不发），且先告诉用户「压缩失败了」 ----
  {
    const turn = await run({
      contextWindow: 800, // 输入 ≈2800 token 远大于窗口
      compaction: { enabled: true },
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: zh(4000) },
        { role: 'user', content: '第二轮：继续' },
      ],
      script: [
        {}, // 压缩请求：空摘要 → 压缩失败（fail-open）
        { content: '不该被调用', finishReason: 'stop' },
      ],
    });
    check('[交互] 压缩失败 + 输入超窗 → 预检拒发（一次请求都不发）',
      turn.calls === 1 && turn.result.stopReason === 'context_overflow',
      'calls=' + turn.calls + ' stopReason=' + turn.result.stopReason);
    check('[交互] 用户先看到「压缩失败」的增量，再看到超窗结论（不是静默失败）',
      turn.deltas.some((d) => d.kind === 'compacted' && d.ok === false) &&
        turn.deltas.some((d) => d.kind === 'context_overflow' && d.phase === 'preflight'),
      turn.deltas.map((d) => d.kind + (d.ok === false ? ':fail' : '')).join(','));
  }

  // ---- 7. 识别器本身：真超窗文案命中，其它不误判 ----
  {
    const hit = agent.classifyContextOverflow(new Error('HTTP 400: ' + DEEPSEEK_400));
    check('[识别器] DeepSeek 真超窗文案 → 命中', !!hit && hit.status === 400, JSON.stringify(hit && hit.status));
    check('[识别器] context_length_exceeded → 命中',
      !!agent.classifyContextOverflow(new Error('HTTP 400: {"error":{"code":"context_length_exceeded"}}')));
    check('[识别器] 无上下文措辞的 400 → 不命中',
      !agent.classifyContextOverflow(new Error('HTTP 400: {"error":{"message":"invalid api key"}}')));
    check('[识别器] 500 里的超窗字样 → 不命中（不是 4xx 超窗）',
      !agent.classifyContextOverflow(new Error('HTTP 500: maximum context length reached internally')));
    check('[识别器] 中文超窗文案 → 命中', !!agent.classifyContextOverflow(new Error('HTTP 400: {"error":"输入的上下文长度超出上限"}')));
    check('[识别器] 空错误 → 不命中', agent.classifyContextOverflow(null) === null);
  }

  // ---- 8. 窗口降级取历史最小值（越拒越保守），且按模型隔离 ----
  {
    agent.resetContextWindowOverrides();
    const a = { apiBase: 'http://x/v1', model: 'm-a' };
    const b = { apiBase: 'http://x/v1', model: 'm-b' };
    agent.noteContextOverflow(a, 100000); // → 90000
    agent.noteContextOverflow(a, 50000);  // → 45000（更保守，覆盖）
    agent.noteContextOverflow(a, 80000);  // → 72000（不如 45000 保守，**不**覆盖）
    check('[窗口账本] 取历史最小值（越被拒越保守）', agent.getContextWindowOverride(a) === 45000, String(agent.getContextWindowOverride(a)));
    check('[窗口账本] 按模型隔离（别的模型不受影响）', agent.getContextWindowOverride(b) === 0, String(agent.getContextWindowOverride(b)));
  }

  // ---- 9. 压缩仍要能压住：降级后的窗口会立刻改变压缩触发线 ----
  {
    const cfg = {
      apiBase: 'http://x/v1',
      model: 'm-c',
      compaction: { ...agent.parseCompactionConfig({}), enabled: true },
    };
    const before = agent.getContextWindowOverride(cfg);
    agent.noteContextOverflow(cfg, 10000);
    const after = agent.getContextWindowOverride(cfg);
    check('[窗口账本] 被拒后压缩线立刻降到 估算×0.9（不用等声明值）', before === 0 && after === 9000, before + '→' + after);
    check('[压缩联动] 9000 窗口 × 0.9 = 8100 就是新的触发线', compaction.shouldCompact({ tokens: 8500, contextWindow: after, ratio: 0.9, compressible: 2 }).needed === true);
  }

  // ---- 10. 回归 #3：窗口降级必须取**报错里的真实窗口**，估算下界不得参与预检拒发 ----
  // 旧实现把窗口锁成「估算 × 0.9」，实测锁到真实窗口的 56%（报错说 1048576，我们锁成 590035）；
  // 而那个值又被预检当硬门槛 → 一次**与输入无关**的 400（真实成因是「输入 + max_tokens 超窗」）
  // 会让这份历史在该进程内**永久发不出去**，用户只能重启应用。
  {
    agent.resetContextWindowOverrides();
    const probeCfg = { apiBase: 'http://scripted.local/v1', model: 'scripted-model' };

    // (a) 解析器：用 docs/context-overflow-guard-2026-09-17.md §4 的真机文案
    const parsed = agent.parseOverflowNumbers(
      "This model's maximum context length is 1048576 tokens. However, you requested 1141290 tokens (748074 in the messages, 393216 in the completion). Please reduce the length of the messages or completion."
    );
    check(
      '[窗口解析] 从报错里抠出真实窗口与消息侧 token 数',
      parsed.window === 1048576 && parsed.inputTokens === 748074,
      JSON.stringify(parsed)
    );

    // (b) 供应商口径：记下的是真实窗口，而不是 655595×0.9=590035
    const noted = agent.noteContextOverflow(probeCfg, {
      tokens: 655595,
      providerMessage: "This model's maximum context length is 1048576 tokens.",
    });
    check(
      '[窗口账本] 报错里有真实窗口时用它（不再锁成 估算×0.9=590035）',
      noted === 1048576 && agent.isContextWindowOverrideAuthoritative(probeCfg) === true,
      'window=' + noted + ' trusted=' + agent.isContextWindowOverrideAuthoritative(probeCfg)
    );

    // (c) 估算口径永远不能覆盖可信值（否则一次瞬时误判就把窗口改小）
    agent.noteContextOverflow(probeCfg, 5000); // 估算口径 → 4500
    check(
      '[窗口账本] 估算值不得覆盖供应商报出的可信窗口',
      agent.getContextWindowOverride(probeCfg) === 1048576,
      String(agent.getContextWindowOverride(probeCfg))
    );

    // (d) 核心回归（真实循环）：被拒过之后，估算 ≈19600 token 的请求必须**照常发出**。
    //     旧实现会把窗口锁成 4500，于是这个请求被预检直接拒发（永久发不出去）。
    const bigTurn = await run({
      contextWindow: 0,
      compaction: { contextWindow: 0, fallbackWindow: 100000000 },
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: zh(28000) }, // ≈19600 token：远大于旧的估算下界 4500，远小于真实窗口 1048576
      ],
      script: [{ content: '正常回答', finishReason: 'stop' }],
    });
    check(
      '[回归 #3] 估算下界不再把本来能发的请求永久挡死',
      bigTurn.calls === 1 && !bigTurn.result.error && bigTurn.result.stopReason !== 'context_overflow',
      'calls=' + bigTurn.calls + ' stopReason=' + bigTurn.result.stopReason + ' error=' + String(bigTurn.result.error || '').slice(0, 40)
    );

    // (e) 独立判据：**只有**估算下界时同样不得拒发（拒发只认可信窗口）。
    //     这正是「一次误判 → 永久挡死」的根因：把估算当门槛，输入一旦超过它就再也发不出去。
    agent.resetContextWindowOverrides();
    const estCfg = { apiBase: 'http://scripted.local/v1', model: 'scripted-model' };
    agent.noteContextOverflow(estCfg, 5000); // 只拿到估算 → 保守窗口 4500，但不可信
    check(
      '[窗口账本] 只有估算时 trusted=false（不可用于拒发）',
      agent.isContextWindowOverrideAuthoritative(estCfg) === false,
      'trusted=' + agent.isContextWindowOverrideAuthoritative(estCfg)
    );
    const estTurn = await run({
      contextWindow: 0,
      compaction: { contextWindow: 0, fallbackWindow: 100000000 },
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: zh(28000) }, // ≈19600 > 估算下界 4500
      ],
      script: [{ content: '仍然照发', finishReason: 'stop' }],
    });
    check(
      '[回归 #3] 只有估算下界时不拒发（拒发只认可信窗口）',
      estTurn.calls === 1 && estTurn.result.stopReason !== 'context_overflow',
      'calls=' + estTurn.calls + ' stopReason=' + estTurn.result.stopReason
    );
  }

  console.log(failures === 0 ? 'CONTEXT OVERFLOW TEST: PASS' : 'CONTEXT OVERFLOW TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('CONTEXT OVERFLOW TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
