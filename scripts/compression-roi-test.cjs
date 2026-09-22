#!/usr/bin/env node
/**
 * compression-roi-test.cjs —— P1-3（工具结果压缩改成收益驱动）的回归判据
 *
 * 审计给的问题与算式：压缩调用成本 ≈ R + S（R = 原文 token，S = 摘要 token），每个后续主轮省 ≈ R − S，
 * 回本所需后续轮数 > (R + S) / (R − S)。原来的口径是**字符**阈值 2,400 + 摘要 1,500 字符 ——
 * R=2400/S=1500 时要 4.33 个后续轮才回本，短任务里反而更贵。
 *
 * 现在的口径：
 *   ① 先做确定性投影/分页/句柄，**投影后**还大到超过 token 阈值（出厂 8,000）才轮到 LLM 摘要；
 *   ② 预计剩余轮数 ≤1 → 永不压缩（最后一轮压了必然亏）；
 *   ③ 净收益判据 `剩余轮数 × (R − S) > (R + S)`；
 *   ④ 同类工具**累计净亏**且已压过 ≥2 次 → 本 run 内自动降级为确定性裁剪；
 *   ⑤ 记 `netTokensSaved`（收益口径）与 `netTokensImmediate`（单轮差），成本只用供应商**实报** usage。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const costAttribution = require('../electron/costAttribution.cjs');
const costLedger = require('../electron/costLedger.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

const { CostLedger } = costLedger;
let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** 出厂压缩配置（与 parseCompressionConfig 的出厂值一致） */
const COMP = {
  enabled: true,
  thresholdTokens: 8000,
  summaryTokens: 1500,
  thresholdChars: 2400,
  budgetChars: 1500,
  maxCalls: 8,
  exclude: [],
  batch: true,
  batchMaxItems: 4,
};

// ============================ A. 收益算式 ============================
console.log('== A. 收益算式（审计原文那条） ==');
{
  const doc = agent.compressionRoi({ contentTokens: 2400, summaryTokens: 1500, remainingRounds: 4 });
  check('[A] 审计例子 R=2400 / S=1500 → 回本 4.33 个后续轮', Math.abs(doc.roundsToBreakEven - 4.3333) < 0.001, String(doc.roundsToBreakEven));
  check('[A] 剩 4 轮 → 不划算（4 × 900 = 3600 < 3900）', doc.profitable === false);
  check('[A] 剩 5 轮 → 划算（5 × 900 = 4500 > 3900）',
    agent.compressionRoi({ contentTokens: 2400, summaryTokens: 1500, remainingRounds: 5 }).profitable === true);
  check('[A] 摘要不小于原文（省不出东西）→ 永不划算且回本轮数是 Infinity',
    agent.compressionRoi({ contentTokens: 1000, summaryTokens: 1000, remainingRounds: 99 }).profitable === false &&
    agent.compressionRoi({ contentTokens: 1000, summaryTokens: 1000, remainingRounds: 99 }).roundsToBreakEven === Infinity);
  check('[A] 大结果 + 多轮：R=20000 / S=1500 / 剩 3 轮 → 划算',
    agent.compressionRoi({ contentTokens: 20000, summaryTokens: 1500, remainingRounds: 3 }).profitable === true);
}

// ============================ B. 决策（各路跳过原因） ============================
console.log('\n== B. compressionDecision 各路 ==');
{
  const base = { compression: COMP, toolName: 'read_file', contentTokens: 20000, contentChars: 80000, usedCalls: 0, remainingRounds: 3 };
  check('[B] 大结果 + 剩 3 轮 → 压（reason=profitable）',
    agent.compressionDecision(base).compress === true && agent.compressionDecision(base).reason === 'profitable');
  check('[B] 变异/判别力：同一输入只把剩余轮数改成 1 → 立刻不压（证明这条判据真在起作用）',
    agent.compressionDecision({ ...base, remainingRounds: 1 }).compress === false &&
    agent.compressionDecision({ ...base, remainingRounds: 1 }).reason === 'last-round');
  check('[B] 剩余轮数未知 → 不压（宁可少省，不赌「后面还有」）',
    agent.compressionDecision({ ...base, remainingRounds: undefined }).reason === 'last-round');
  check('[B] 投影后仍低于 token 阈值（8k）→ 不压（哪怕字符数早就过 2,400）',
    agent.compressionDecision({ ...base, contentTokens: 3000, contentChars: 90000 }).reason === 'below-token-threshold');
  check('[B] 旧口径仍然说了算：exclude / max_calls / 开关关闭 → 一律不压（老配置不被放宽）',
    agent.compressionDecision({ ...base, toolName: 'ask_user', compression: { ...COMP, exclude: ['ask_user'] } }).reason === 'legacy-gate' &&
    agent.compressionDecision({ ...base, usedCalls: 8 }).reason === 'legacy-gate' &&
    agent.compressionDecision({ ...base, compression: { ...COMP, enabled: false } }).reason === 'legacy-gate' &&
    agent.compressionDecision({ ...base, contentChars: 100 }).reason === 'legacy-gate');
  // ROI 为负必须构造在**过了 token 阈值之后**：R=9000 / S=8000 → 每轮只省 1000，成本 17000，剩 2 轮不够
  const roiNeg = agent.compressionDecision({
    ...base, contentTokens: 9000, contentChars: 40000, remainingRounds: 2, compression: { ...COMP, summaryTokens: 8000 },
  });
  check('[B] 净收益为负（剩 2 轮 × 1000 = 2000 < 成本 17000）→ 不压，且给出算式',
    roiNeg.compress === false && roiNeg.reason === 'roi-negative' && roiNeg.roi.roundsToBreakEven === 17,
    JSON.stringify({ reason: roiNeg.reason, roi: roiNeg.roi }));
  check('[B] 同类工具累计净亏且压过 ≥2 次 → 自动降级为确定性裁剪（不再调模型）',
    agent.compressionDecision({ ...base, stats: new Map([['read_file', { calls: 2, netTokensSaved: -500 }]]) }).reason === 'negative-net');
  check('[B] 只压过 1 次就净亏 → 还不降级（避免一次意外就永久关掉）',
    agent.compressionDecision({ ...base, stats: new Map([['read_file', { calls: 1, netTokensSaved: -500 }]]) }).compress === true);
  check('[B] 别的工具的亏损不影响本工具（按工具分别记账）',
    agent.compressionDecision({ ...base, stats: new Map([['execute_shell', { calls: 5, netTokensSaved: -9e5 }]]) }).compress === true);
}

// ============================ C. 端到端 ============================
(async () => {
  console.log('\n== C. 端到端：真 run 上的压/不压 ==');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-roi-'));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  // 100k 字符 ASCII ≈ 25k token：稳稳超过 8k token 阈值，且不会被 data_truncate_cap（120k）截断
  fs.writeFileSync(path.join(root, 'work', 'big.txt'), ('ALPHA '.repeat(16) + '\n').repeat(10000));
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);

  async function runTurn(script, cfgOverrides, runId) {
    const ledger = new CostLedger({ projectRoot: root, runId });
    const controller = new AbortController();
    const context = new AgentToolContext({
      projectRoot: root, confirm: async () => true, audit: () => {},
      ragConfig: { enabled: false }, sandbox: policy, signal: controller.signal,
    });
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
    const stub = installScriptedModel(script, { loopLast: false });
    try {
      await agent.runAgentChat({
        cfg: {
          apiBase: 'http://scripted.local/v1',
          apiKey: 'test-key-not-real',
          model: 'scripted-model',
          maxTokens: 1024,
          reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
          limits: { maxTotalTokens: 100000000, maxConcurrentRuns: 1, ...(cfgOverrides.limits || {}) },
          compression: { ...COMP, model: 'scripted-model' },
          rag: { enabled: false },
          tools: {},
          costLedger: ledger,
          costRunId: runId,
          ...cfgOverrides,
        },
        messages: [
          { role: 'system', content: '测试用 system' },
          { role: 'user', content: '看看 big.txt' },
        ],
        tools: { registry, context },
        signal: controller.signal,
        timeoutMs: 30000,
      });
    } finally {
      stub.restore();
    }
    const traceFile = path.join(root, '.codenode', 'tools_trace.jsonl');
    const traces = fs.existsSync(traceFile)
      ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { ledger, traces };
  }

  /** read_file 默认只读 200 行（≈600 token，远不够阈值）→ 显式 maxLines 取满，得到 ≈22k token 的结果 */
  const bigRead = { toolCalls: [{ name: 'read_file', args: { path: 'work/big.txt', maxLines: 9000 } }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920, prompt_cache_miss_tokens: 900 } };

  // C1：还有 3 个后续轮 → 应该压（成本用供应商实报 usage）
  const c1 = await runTurn(
    [
      bigRead,
      { content: '<!-- summary i=1 -->\n摘要：big.txt 里全是 ALPHA。', usage: { prompt_tokens: 26000, completion_tokens: 300, total_tokens: 26300 } },
      { content: '完成', usage: { prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210 } },
    ],
    { limits: { maxToolIterations: 4 } },
    'run-roi-compress',
  );
  const comp1 = c1.ledger.entries.filter((e) => e.kind === 'compression');
  check('[C] 大结果 + 剩 3 轮 → 真的调了压缩模型（账本上有 compression 一笔）', comp1.length === 1, 'compression=' + comp1.length);
  const compTrace = c1.traces.filter((t) => t.kind === 'compression').pop();
  check('[C] 压缩 trace 记了净收益（收益口径 + 单轮口径都给）',
    !!compTrace && compTrace.savedTokens > 0 && compTrace.costTokens === 26300 &&
    compTrace.netTokensSaved === compTrace.savedTokens * compTrace.remainingRounds - compTrace.costTokens &&
    compTrace.netTokensImmediate === compTrace.savedTokens - compTrace.costTokens,
    compTrace ? JSON.stringify({ saved: compTrace.savedTokens, cost: compTrace.costTokens, net: compTrace.netTokensSaved, imm: compTrace.netTokensImmediate, rounds: compTrace.remainingRounds }) : 'missing');
  check('[C] 成本口径来自**实报** usage（costKnown=true），不是估算', compTrace && compTrace.costKnown === true);
  const mainAfter = c1.ledger.entries.filter((e) => e.kind === 'main').map((e) => e.meta && e.meta.attribution).filter(Boolean).pop();
  check('[C] 压缩账进了归因（P1-3 → P2-2：costTokens 换来了多少 futureSavedTokens）',
    !!mainAfter && mainAfter.compression.calls === 1 && mainAfter.compression.byTool.read_file &&
    mainAfter.compression.costTokens > 0 && mainAfter.compression.savedTokens > 0,
    mainAfter ? JSON.stringify(mainAfter.compression.byTool) : 'missing');

  // C2：最后一轮（maxToolIterations=1）→ 永不压缩
  const c2 = await runTurn([bigRead], { limits: { maxToolIterations: 1 } }, 'run-roi-lastround');
  check('[C] 最后一轮（剩 0 轮）→ 一份都不压（账本上没有 compression）',
    c2.ledger.entries.filter((e) => e.kind === 'compression').length === 0);
  const skipTrace = c2.traces.filter((t) => t.kind === 'compression_skipped').pop();
  check('[C] 而且「为什么没压」是可观测的（compression_skipped 事件里 last-round ≥ 1），不是静默省掉',
    !!skipTrace && Number(skipTrace.skips && skipTrace.skips['last-round']) >= 1,
    skipTrace ? JSON.stringify(skipTrace.skips) : 'no-trace');

  console.log('\n' + (failures === 0 ? 'COMPRESSION ROI TEST: PASS（阈值按 token + 净收益判据 + 最后一轮不压 + 自动降级）' : 'COMPRESSION ROI TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('COMPRESSION ROI TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
