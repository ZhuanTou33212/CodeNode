/**
 * compaction-test.cjs —— 上下文压缩（照 **Codex CLI** 的做法）必须真压、压对、压不动时不假装
 *
 * 依据（本机实测取证）：
 *   - 提示词逐字取自 codex-cli 0.135.0 二进制（`CONTEXT CHECKPOINT COMPACTION…`）；
 *   - 触发线 0.9 × 窗口（Codex 的 `model_context_window=1000000` / `model_auto_compact_token_limit=900000`）；
 *   - 压缩后的历史 = `[system, ...人的轮次, 摘要]`（Codex rollout 的 `replacement_history` 形状；
 *     机器注入的 `<codex_internal_context>` 那类 user 消息被丢掉）；
 *   - 摘要以可见文本带回（Codex 用 OpenAI 的服务端加密压缩项，OpenAI 兼容接口没有这个能力）。
 *
 * 判据全部落在**可观察终态**：脚本化模型实际收到的请求体（第几次请求、messages 是什么）+
 * runAgentChat 的返回值 + onDelta 增量，不看内部变量。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compaction = require('../electron/compaction.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-compact-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

const SUMMARY = '交接摘要：已完成第 1 步；下一步检查 b.txt；关键约束是不要改 package.json。';

/** 长中文文本（估算口径：1 个中文字 ≈ 0.7 token，所以 1000 字 ≈ 700 token） */
const zh = (chars) => '测'.repeat(chars);

/**
 * 跑一轮真实工具循环。
 * @param {{script: Array<any>, compaction?: any, forceCompaction?: boolean, messages?: Array<any>, prompt?: string, contextWindow?: number}} options
 */
async function runTurn(options) {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const cfg = {
    apiBase: 'http://scripted.local/v1',
    apiKey: 'scripted-key',
    model: 'scripted-model',
    maxTokens: 2048,
    reasoningEffort: '',
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2, streamMaxAttempts: 0 },
    limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
    compression: { enabled: false },
    // 硬裁剪关掉：本用例只测「语义压缩」这一层的行为，别让占位符裁剪混进来
    context: { enabled: false },
    compaction: { ...agent.parseCompactionConfig({}), ...(options.compaction || {}) },
    contextWindow: options.contextWindow,
    rag: { enabled: false },
    tools: {},
  };
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['read_file'],
  });
  const stub = installScriptedModel(options.script, { loopLast: true });
  const deltas = [];
  try {
    const result = await agent.runAgentChat({
      cfg,
      messages: options.messages || [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: options.prompt || '继续任务' },
      ],
      tools: { registry, context },
      signal: controller.signal,
      forceCompaction: options.forceCompaction === true,
      onDelta: (d) => deltas.push(d),
    });
    return { result, seen: stub.seen, calls: stub.calls, deltas };
  } finally {
    stub.restore();
  }
}

(async () => {
  // ---- (1) 照 Codex 的做法：提示词、触发线、新历史形状 ----
  {
    const prompt = compaction.COMPACTION_PROMPT;
    check('[Codex 口径] 提示词逐字一致（含 5 行结构）',
      /^You are performing a CONTEXT CHECKPOINT COMPACTION\./.test(prompt) &&
        prompt.includes('- Current progress and key decisions made') &&
        prompt.includes('- Important context, constraints, or user preferences') &&
        prompt.includes('- What remains to be done (clear next steps)') &&
        prompt.includes('- Any critical data, examples, or references needed to continue') &&
        prompt.includes('seamlessly continue the work.'),
      prompt.split('\n').length + ' 行');
    const cfg = agent.parseCompactionConfig({});
    check('[Codex 口径] 出厂触发线 0.9 × 窗口', cfg.ratio === 0.9, String(cfg.ratio));
    check('[Codex 口径] 默认保留人的轮次、默认开', cfg.enabled === true && cfg.keepUserTurns === true,
      JSON.stringify({ enabled: cfg.enabled, keepUserTurns: cfg.keepUserTurns }));
  }

  // ---- (2) 没到阈值：不发摘要请求、消息逐字节不动（防过度压缩） ----
  {
    const turn = await runTurn({
      contextWindow: 1000000, // 阈值 900k，下面这点内容远远不到
      script: [{ content: '正常回答。', finishReason: 'stop' }],
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: zh(2000) },
        { role: 'user', content: '继续' },
      ],
    });
    check('[未到阈值] 只有 1 次模型请求（没有多花一次摘要调用）', turn.calls === 1, 'calls=' + turn.calls);
    const sent = turn.seen[0].messages;
    check('[未到阈值] 历史原样送达（条数与末条内容都没变）',
      sent.length === 4 && sent[3].content === '继续', JSON.stringify(sent.map((m) => m.role)));
    check('[未到阈值] 没有 compacted 增量', !turn.deltas.some((d) => d.kind === 'compacted'));
  }

  // ---- (3) 超阈值：发摘要请求 → 历史被替换成 [system, 人的轮次, 摘要] ----
  {
    const big = zh(3000); // ≈2100 token；窗口取 1000、ratio 0.9 → 阈值 900，必然触发
    const turn = await runTurn({
      contextWindow: 1000,
      script: [
        { content: SUMMARY, finishReason: 'stop' },   // 第 1 次请求 = 摘要
        { content: '按摘要继续完成。', finishReason: 'stop' }, // 第 2 次 = 主请求
      ],
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮：看看 a.txt' },
        { role: 'assistant', content: big, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: zh(4000) },
        { role: 'user', content: '【系统提示】上一轮工具失败，换个思路（机器注入，不该保留）' },
        { role: 'user', content: '第二轮：继续' },
      ],
    });
    check('[超阈值] 先发了一次摘要请求（历史 + Codex 提示词）', turn.calls === 2, 'calls=' + turn.calls);
    const summaryReq = turn.seen[0].messages;
    check('[超阈值] 摘要请求带了完整转录与 Codex 提示词',
      summaryReq.length === 1 && summaryReq[0].role === 'user' &&
        summaryReq[0].content.includes('You are performing a CONTEXT CHECKPOINT COMPACTION') &&
        summaryReq[0].content.includes('[tool]'),
      JSON.stringify({ msgs: summaryReq.length, role: summaryReq[0] && summaryReq[0].role }));
    const mainReq = turn.seen[1].messages;
    check('[超阈值] 主请求的历史 = [system, 人的轮次, 摘要]',
      mainReq.length === 4 &&
        mainReq[0].role === 'system' &&
        mainReq[1].content === '第一轮：看看 a.txt' &&
        mainReq[2].content === '第二轮：继续' &&
        mainReq[3].role === 'user' && mainReq[3].content.startsWith('<compaction>'),
      JSON.stringify(mainReq.map((m) => m.role + ':' + String(m.content).slice(0, 12))));
    check('[超阈值] 助手长文与工具结果已被摘要取代（不再占上下文）',
      !mainReq.some((m) => m.role === 'assistant' || m.role === 'tool'), JSON.stringify(mainReq.map((m) => m.role)));
    check('[超阈值] 机器注入的 user 提示不保留（Codex 丢 <codex_internal_context> 的同款行为）',
      !mainReq.some((m) => String(m.content).includes('机器注入')), JSON.stringify(mainReq.map((m) => String(m.content).slice(0, 10))));
    check('[超阈值] 摘要正文进了信封', mainReq[3].content.includes('下一步检查 b.txt'));
    check('[超阈值] 返回值如实上报压缩次数与摘要',
      turn.result.compacted === 1 && String(turn.result.contextSummary).includes('交接摘要'), JSON.stringify({ n: turn.result.compacted }));
    const doneDelta = turn.deltas.find((d) => d.kind === 'compacted' && d.ok !== false);
    check('[超阈值] 增量带上窗口号、前后 token 与给模型的信封',
      !!doneDelta && doneDelta.windowNumber === 1 && doneDelta.tokensBefore > doneDelta.tokensAfter &&
        String(doneDelta.envelope).startsWith('<compaction>'),
      JSON.stringify(doneDelta && { w: doneDelta.windowNumber, b: doneDelta.tokensBefore, a: doneDelta.tokensAfter }));
    check('[超阈值] 触发来源标成 over-limit', !!doneDelta && doneDelta.trigger === 'over-limit', doneDelta && doneDelta.trigger);
  }

  // ---- (4) /compact：无视阈值立刻压一次（等价 Codex 的手动命令） ----
  {
    const turn = await runTurn({
      contextWindow: 1000000, // 阈值远不可及
      forceCompaction: true,
      script: [
        { content: SUMMARY, finishReason: 'stop' },
        { content: '好了。', finishReason: 'stop' },
      ],
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '先做第一件事' },
        { role: 'assistant', content: zh(500) },
        { role: 'user', content: '现在做第二件' },
      ],
    });
    check('[/compact] 未到阈值也压（2 次请求）', turn.calls === 2, 'calls=' + turn.calls);
    const delta = turn.deltas.find((d) => d.kind === 'compacted' && d.ok !== false);
    check('[/compact] 触发来源标成 manual', !!delta && delta.trigger === 'manual', delta && delta.trigger);
    check('[/compact] 压完仍然交付回答', String(turn.result.content).includes('好了'), JSON.stringify(String(turn.result.content).slice(0, 20)));
  }

  // ---- (5) 没什么可压时不假装压过（只剩 system + 人的话） ----
  {
    const turn = await runTurn({
      contextWindow: 1000000,
      forceCompaction: true,
      script: [{ content: '好。', finishReason: 'stop' }],
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '只有一条人的话' },
      ],
    });
    check('[/compact 空压缩] 不额外发摘要请求', turn.calls === 1, 'calls=' + turn.calls);
    const bad = turn.deltas.find((d) => d.kind === 'compacted' && d.ok === false);
    check('[/compact 空压缩] 如实报「没有可压缩的内容」', !!bad && /没有可压缩的内容/.test(String(bad.reason)), JSON.stringify(bad && bad.reason));
    check('[/compact 空压缩] 返回值里 compacted=0（没压就是没压）', turn.result.compacted === 0, String(turn.result.compacted));
  }

  // ---- (6) 摘要失败 → fail-open：不阻断本轮、如实上报、硬裁剪仍兜底 ----
  {
    const turn = await runTurn({
      // 窗口取值要卡在一个窄区间里：估算（**含工具 schema**，≈2376）> 阈值，且 ≥ 输入本身。
      // 取 2500：阈值 2250 < 2376（会触发压缩）、2376 ≤ 2500（预检不会拒发）。
      // 若不把工具 schema 计入估算，窗口就会选小 → 压缩失败后预检直接拒发（那是另一条判据）。
      contextWindow: 2500,
      script: [
        {},  // 摘要请求：脚本给空内容（模型没吐摘要）
        { content: '照常交付。', finishReason: 'stop' },
      ],
      messages: [
        { role: 'system', content: '你是测试用 system' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: zh(3000) },
        { role: 'user', content: '第二轮：继续' },
      ],
    });
    check('[摘要失败] 仍然完成本轮并交付回答', String(turn.result.content).includes('照常交付'), JSON.stringify(String(turn.result.content).slice(0, 20)));
    const bad = turn.deltas.find((d) => d.kind === 'compacted' && d.ok === false);
    check('[摘要失败] 如实报失败（用户能看到原因）', !!bad && /摘要/.test(String(bad.reason)), JSON.stringify(bad && bad.reason));
    check('[摘要失败] 没有把历史换成空摘要（原历史保留）',
      turn.seen[1].messages.some((m) => String(m.content).startsWith('测测测')), JSON.stringify(turn.seen[1].messages.map((m) => m.role)));
    check('[摘要失败] 返回值 compacted=0', turn.result.compacted === 0, String(turn.result.compacted));
  }

  // ---- (7) 估算口径：中文按 0.7/字 而不是「字节数」 ----
  {
    const msg = [{ role: 'user', content: zh(1000) }];  // 1000 中文字 = 3000 字节
    const tokens = compaction.estimateTokens(msg);
    check('[估算口径] 1000 中文字 ≈ 700 token（按字节算会报 3000+）', tokens > 600 && tokens < 800, String(tokens));
    const en = compaction.estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]);
    check('[估算口径] 400 个 ASCII 字符 ≈ 100 token', en > 80 && en < 140, String(en));
    // 触发判据用估算值而不是字节数：130k 字节的中文（≈91k token）不该在 128k 窗口 × 0.9 上触发
    const plan = compaction.shouldCompact({ tokens: 91000, contextWindow: 128000, ratio: 0.9, compressible: 3 });
    check('[估算口径] 91k token < 115k 阈值 → 不触发（字节口径会误触发）', plan.needed === false, JSON.stringify(plan));
  }

  // ---- (8) 限额与丢弃：超出总量上限时从最旧开始丢并如实标注 ----
  {
    const long = zh(5000);
    const built = compaction.buildSummarizationMessages({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: long },
        { role: 'assistant', content: long },
        { role: 'user', content: '最近一条' },
      ],
      itemMaxChars: 1000,
      maxTotalChars: 3000,
    });
    check('[超量] 单条按上限截断并标注', built.messages[0].content.includes('已截断') || built.messages[0].content.includes('未纳入本次压缩输入'),
      String(built.messages[0].content.slice(0, 60)));
    check('[超量] 仍然带着 Codex 提示词', built.messages[0].content.includes('CONTEXT CHECKPOINT COMPACTION'));
    const kept = compaction.buildCompactedHistory({
      systemMessage: { role: 'system', content: 'sys' },
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: zh(100) },
        { role: 'user', content: '第二句' },
      ],
      summary: '摘要',
      keepUserMaxChars: 1000,
      keepUserTotalChars: 3,
    });
    check('[超量] 保留人的轮次时按字符预算从最近往前取', kept.keptUserTurns === 1 && kept.messages[1].content === '第二句',
      JSON.stringify({ n: kept.keptUserTurns, first: kept.messages[1] && kept.messages[1].content }));
  }

  console.log(failures === 0 ? 'COMPACTION TEST: PASS' : 'COMPACTION TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('COMPACTION TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
