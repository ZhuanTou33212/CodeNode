#!/usr/bin/env node
/**
 * output-budget-test.cjs —— P2-1（按阶段分配输出预算）的回归判据
 *
 * 审计的证据：**reasoning 会吃掉正文额度并触发多次续写**，所以不能简单把主模型全局 `max_tokens`
 * 从 32k 降到 8k（可能更贵）。采用两档：
 *   - 上一轮**调过工具** → 这一轮在「选工具」：tool 档（出厂 12k，区间 8k~12k）；
 *   - 否则（首轮 / 交付 / 续写）→ final 档（出厂 32k，区间 24k~32k）；
 *   - 两档都只能**往下压**，永不越过用户配的 `agent.max_tokens`；
 *   - 正文为空却被截断（reasoning 吃光额度）→ **加预算重试一次**，而不是「从断点接着写」一段不存在的内容；
 *   - `agent.output_budget_tiers=false` → 完全回到旧行为（请求体逐字节一致，这是负向判据）。
 *
 * 判据都落在**真实发出的请求体**（scripted-model 记录的 seen）与 trace 上。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-outbudget-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'CONTENT-1\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

// ============================ A. 配置 ============================
console.log('== A. 配置出厂值与开关 ==');
{
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-outbudget-cfg-'));
  fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
  const writeCfg = (text) => fs.writeFileSync(path.join(projDir, '.codenode', 'agent.properties'), text);
  writeCfg('');
  const d = agent.loadConfig(projDir).limits;
  check('[A] 出厂：两档 12k / 32k、开关开、加预算重试 1 次',
    d.outputTiers === true && d.toolMaxTokens === 12000 && d.finalMaxTokens === 32000 && d.truncationBumps === 1,
    JSON.stringify({ tiers: d.outputTiers, tool: d.toolMaxTokens, final: d.finalMaxTokens, bumps: d.truncationBumps }));
  check('[A] tool 档落在审计建议的 8k~12k 区间、final 档落在 24k~32k 区间',
    d.toolMaxTokens >= 8000 && d.toolMaxTokens <= 12000 && d.finalMaxTokens >= 24000 && d.finalMaxTokens <= 32000);
  writeCfg('agent.output_budget_tiers=false\n');
  check('[A] agent.output_budget_tiers=false → 关闭（回到旧行为）', agent.loadConfig(projDir).limits.outputTiers === false);
  writeCfg('agent.output_budget_tool=8192\nagent.output_budget_final=24576\nagent.truncation_budget_bumps=0\n');
  const c = agent.loadConfig(projDir).limits;
  check('[A] 两档与重试次数都可配', c.toolMaxTokens === 8192 && c.finalMaxTokens === 24576 && c.truncationBumps === 0, JSON.stringify(c));
}

// ============================ B. 端到端请求体 ============================
/**
 * 最近一次 run 的请求快照 + trace 事件。
 * `limits` 必须用**真实 loadConfig 的出厂值**打底：手搓一个 `{maxTotalTokens}` 会让 `outputTiers` 缺失，
 * 于是测出来的是「功能没接线」而不是「功能对不对」（第一版就这么错了）。
 */
async function runTurn(script, cfgOverrides = {}, runId = 'run-outbudget') {
  const limits = { ...agent.loadConfig(root).limits, ...(cfgOverrides.limits || {}) };
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root, confirm: async () => true, audit: () => {},
    ragConfig: { enabled: false }, sandbox: policy, signal: controller.signal,
  });
  const stub = installScriptedModel(script, { loopLast: false });
  let seen = [];
  try {
    await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'test-key-not-real',
        model: 'scripted-model',
        maxTokens: 32000,
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
        costRunId: runId,
        ...cfgOverrides,
        // limits 放在最后：既吃到真实出厂值，也允许用例逐项覆盖
        limits: { ...limits, maxTotalTokens: 100000000 },
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '读一下 a.txt' },
      ],
      tools: {
        registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] }),
        context,
      },
      signal: controller.signal,
      timeoutMs: 20000,
    });
  } finally {
    seen = stub.seen || [];
    stub.restore();
  }
  const traceFile = path.join(root, '.codenode', 'tools_trace.jsonl');
  const traces = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((t) => t.runId === runId)
    : [];
  return { seen, traces };
}

(async () => {
  console.log('\n== B. 端到端：真实请求体里的 max_tokens ==');
  const readCall = { toolCalls: [{ name: 'read_file', args: { path: 'work/a.txt' } }], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } };

  // B1：首轮 = final 档（不压）；第二轮（上一轮调过工具）= tool 档（压到 12k）
  const b1 = await runTurn([readCall, { content: '完成' }], {}, 'run-tier-b1');
  check('[B] 第 1 轮（还未调过工具）→ final 档：max_tokens 保持 32000（首轮不压，避免给「一次问清」加截断风险）',
    b1.seen[0] && b1.seen[0].maxTokens === 32000, JSON.stringify(b1.seen.map((s) => s.maxTokens)));
  check('[B] 第 2 轮（上一轮调过工具 → 正在选工具）→ tool 档：max_tokens 压到 12000',
    b1.seen[1] && b1.seen[1].maxTokens === 12000, JSON.stringify(b1.seen.map((s) => s.maxTokens)));
  const tierTrace = b1.traces.filter((t) => t.kind === 'output_budget_tier').pop();
  check('[B] 定档留痕（tool 档：from 32000 → to 12000）',
    !!tierTrace && tierTrace.tier === 'tool' && tierTrace.from === 32000 && tierTrace.to === 12000,
    tierTrace ? JSON.stringify(tierTrace) : 'no-trace');

  // B2：负向 —— 关掉开关 → 两轮都是用户配的 32000（与改动前逐字节一致的行为）
  const b2 = await runTurn([readCall, { content: '完成' }], { limits: { outputTiers: false } }, 'run-tier-b2');
  check('[B] 负向：output_budget_tiers=false → 每一轮都是 32000（不介入）',
    b2.seen.length === 2 && b2.seen.every((s) => s.maxTokens === 32000) && b2.traces.filter((t) => t.kind === 'output_budget_tier').length === 0,
    JSON.stringify(b2.seen.map((s) => s.maxTokens)));

  // B3：用户把 max_tokens 配小 → 档位只能往下压，不能抬上去
  const b3 = await runTurn([readCall, { content: '完成' }], { maxTokens: 4000 }, 'run-tier-b3');
  check('[B] 档位只往下压、永不越过用户配置（max_tokens=4000 时两轮都是 4000）',
    b3.seen.length === 2 && b3.seen.every((s) => s.maxTokens === 4000), JSON.stringify(b3.seen.map((s) => s.maxTokens)));

  // B4：正文为空 + finish_reason=length → 加预算重试（且**不**注入「接着写」的补问）
  const b4 = await runTurn([readCall, { content: '', finishReason: 'length' }, { content: '完成' }], {}, 'run-tier-b4');
  const bump = b4.traces.filter((t) => t.kind === 'truncation_budget_bump').pop();
  check('[B] 空正文被截断 → 加预算重试一次（12000 → 32000）并留痕',
    !!bump && bump.from === 12000 && bump.to === 32000, bump ? JSON.stringify(bump) : 'no-trace');
  check('[B] 重试请求真的用了抬高后的预算', b4.seen[2] && b4.seen[2].maxTokens === 32000, JSON.stringify(b4.seen.map((s) => s.maxTokens)));
  const msgCounts = b4.seen.map((s) => (s.messages || []).length);
  check('[B] 空正文时不注入「从断点接着写」的补问（重试请求的消息条数与上一轮相同 —— 没有断点可接）',
    msgCounts.length >= 3 && msgCounts[2] === msgCounts[1],
    JSON.stringify(msgCounts));
  check('[B] 加预算重试是有上限的（出厂 1 次，不会无限补问）', b4.traces.filter((t) => t.kind === 'truncation_budget_bump').length === 1);

  // B5：有正文被截断 → 仍走既有的「从断点接着写」（补问会新增一条消息）
  const b5 = await runTurn([readCall, { content: '前半段正文…', finishReason: 'length' }, { content: '完成' }], {}, 'run-tier-b5');
  check('[B] 有正文被截断 → 不加预算、而是注入「接着写」的补问（消息条数 +2：assistant 半截 + 补问）',
    b5.traces.filter((t) => t.kind === 'truncation_nudge').length === 1 &&
    b5.seen[2] && (b5.seen[2].messages || []).length === (b5.seen[1].messages || []).length + 2,
    JSON.stringify({ nudges: b5.traces.filter((t) => t.kind === 'truncation_nudge').length, counts: b5.seen.map((s) => (s.messages || []).length) }));

  console.log('\n' + (failures === 0 ? 'OUTPUT BUDGET TEST: PASS（两档 + 只往下压 + 空正文加预算重试 + 开关可回退）' : 'OUTPUT BUDGET TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('OUTPUT BUDGET TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
